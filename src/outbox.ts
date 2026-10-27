import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "./pheebs-store.js";

// The queues of envelopes waiting for the background sender, one directory per backend and token
// (see `scopeKey`), each holding its own events, state and flusher lock. Where an event may go is
// decided by the directory it sits in, never by a shared file a failed read could misreport.
// Each event is one file, written under tmp/ and renamed into new/: a rename is atomic, so the
// sender never reads half an event, and concurrent hooks never interleave the way appends to one
// shared file can.
const OUTBOX_ROOT = join(homedir(), ".pheebs", "outbox");

const LIMITS = {
  maxEvents: 10_000,
  maxBytes: 5 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

// A flusher touches its lock on every pass, so a lock this old belongs to one that died.
export const LOCK_STALE_MS = 2 * 60 * 1000;

// The longest any deliberate pause runs. A nextAttemptAt further out than this was written under a
// clock that has since gone backwards, and honouring it would stop every hook starting a flusher.
export const MAX_PAUSE_MS = 60 * 60 * 1000;

// How long a backend found not to batch is sent one event per request before it is asked again.
export const UNSUPPORTED_RECHECK_MS = 24 * 60 * 60 * 1000;

// Time left until a stamp, or 0 once it has passed. A stamp further out than `maxMs` was written
// before the clock went backwards, and honouring it would hold the queue until the clock caught up.
export function remainingMs(until: number | undefined, maxMs: number, now = Date.now()): number {
  const left = (until ?? 0) - now;
  return left > 0 && left <= maxMs ? left : 0;
}

// A writer killed between write and rename leaves its file behind in tmp/.
const ORPHAN_TMP_MS = 60 * 1000;

export interface OutboxState {
  attempts?: number;
  nextAttemptAt?: number;
  batchUnsupportedUntil?: number;
  droppedSinceLastSend?: number;
  maxBatch?: number;
  maxBatchUntil?: number;
  // The last queued name sent in a batch whose send failed after it may have arrived, and when
  // the batch route first answered 404 or 405 for it. Events up to it may go to the batch route
  // again, never to /ingest. Names sort by arrival only while the clock moves forward, so after a
  // step back every never-sent event named before the marker counts as in doubt too, until the
  // clock catches up: accepted, since it costs those events after an hour of 404s and needs no
  // more state.
  inDoubtThrough?: string;
  inDoubtSince?: number;
  lastError?: string;
}

export interface Pending {
  name: string;
  path: string;
  bytes: number;
  queuedAt: number;
}

const newDir = (dir: string) => join(dir, "new");
const tmpDir = (dir: string) => join(dir, "tmp");
const statePath = (dir: string) => join(dir, "state.json");
const lockPath = (dir: string) => join(dir, "flush.lock");

/**
 * Identifies the backend and token a queue was captured under. Events captured for one backend
 * must never ship to another the developer later points pheebs at, and the token id is not always
 * resolved, so the key hashes the token itself rather than storing it.
 */
export function scopeKey(baseUrl: string, token: string): string {
  return createHash("sha256").update(`${baseUrl}\n${token}`).digest("hex").slice(0, 16);
}

const SCOPE_NAME = /^[0-9a-f]{16}$/;

export function scopeDir(scope: string, root = OUTBOX_ROOT): string {
  return join(root, scope);
}

// A queue written to this recently may belong to a hook that read the configuration a moment
// before or after this one. Removing it would race that hook; leaving it costs nothing, because
// no flusher sends a queue that is not the configured one, and a later flusher removes it.
const SCOPE_SETTLE_MS = 60 * 1000;

function lastWritten(dir: string): number {
  let at = 0;
  for (const path of [dir, newDir(dir)]) {
    try {
      at = Math.max(at, statSync(path).mtimeMs);
    } catch {}
  }
  return at;
}

/**
 * Drop the queues captured for any other backend or token. The developer has pointed Pheebs
 * elsewhere, and those events were never meant for the new destination.
 */
export function discardOtherScopes(scope: string, root = OUTBOX_ROOT, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === scope || !SCOPE_NAME.test(name)) continue;
    const dir = join(root, name);
    if (now - lastWritten(dir) < SCOPE_SETTLE_MS) continue;
    // A file held open, or owned by someone else, keeps that queue for a later try; it must not
    // keep the current one from being written or sent.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export function readState(dir: string): OutboxState {
  return readJsonFile<OutboxState>(statePath(dir)) ?? {};
}

// Staged under tmp/, where the orphan sweep finds it if the rename never happens, and renamed into
// place so a reader never sees half a file. The queue's directory is not recreated here: a writer
// whose queue was removed, by uninstall or a change of backend, should fail rather than revive it.
function writeState(state: OutboxState, dir: string): void {
  try {
    mkdirSync(tmpDir(dir), { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const staged = join(tmpDir(dir), `state.${process.pid}.json`);
  writeFileSync(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // On Windows a reader or a virus scanner holding state.json open makes the rename fail for a
  // moment; a lost write would report the same drops twice or leave a stale backoff in place.
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(staged, statePath(dir));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

export function updateState(patch: Partial<OutboxState>, dir: string): OutboxState {
  const next = { ...readState(dir), ...patch };
  writeState(next, dir);
  return next;
}

export function enqueue(payload: Record<string, unknown>, dir: string, now = Date.now()): void {
  mkdirSync(tmpDir(dir), { recursive: true, mode: 0o700 });
  mkdirSync(newDir(dir), { recursive: true, mode: 0o700 });
  const id = typeof payload.event_id === "string" ? payload.event_id : randomUUID();
  // The name sorts by arrival, and the id keeps two events in one millisecond apart.
  const name = `${String(now).padStart(13, "0")}-${id}.json`;
  const staged = join(tmpDir(dir), name);
  writeFileSync(staged, JSON.stringify(payload), { mode: 0o600 });
  renameSync(staged, join(newDir(dir), name));
}

export function listPending(dir: string): Pending[] {
  let names: string[];
  try {
    names = readdirSync(newDir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const pending: Pending[] = [];
  for (const name of names.sort()) {
    const path = join(newDir(dir), name);
    try {
      pending.push({ name, path, bytes: statSync(path).size, queuedAt: Number(name.slice(0, 13)) });
    } catch {}
  }
  return pending;
}

/** Whether every item is gone. One that is not would be sent again on the next pass. */
export function removePending(items: Pending[]): boolean {
  let removed = true;
  for (const item of items) {
    try {
      // `rmSync` rather than `unlinkSync`, so a directory that ended up under new/ goes too.
      rmSync(item.path, { recursive: true, force: true });
    } catch {
      removed = false;
    }
  }
  return removed;
}

/**
 * Enforce the caps by dropping the oldest events, and count them so the next batch reports the
 * loss. The local log still holds every dropped event: this drops the upload, not the record.
 */
export function trimToCaps(dir: string, now = Date.now(), limits = LIMITS): number {
  let orphans: string[] = [];
  try {
    orphans = readdirSync(tmpDir(dir));
  } catch {}
  for (const name of orphans) {
    const path = join(tmpDir(dir), name);
    try {
      if (now - statSync(path).mtimeMs > ORPHAN_TMP_MS) unlinkSync(path);
    } catch {}
  }

  const pending = listPending(dir);
  let bytes = pending.reduce((sum, p) => sum + p.bytes, 0);
  let count = pending.length;
  const dropped: Pending[] = [];
  for (const item of pending) {
    if (
      count <= limits.maxEvents &&
      bytes <= limits.maxBytes &&
      now - item.queuedAt <= limits.maxAgeMs
    ) {
      break;
    }
    dropped.push(item);
    count -= 1;
    bytes -= item.bytes;
  }
  if (dropped.length === 0) return 0;

  // Counted one by one: a file that would not go is still in the queue and is judged again on the
  // next pass, so counting it now would report the same loss twice.
  const removed = dropped.filter((item) => removePending([item])).length;
  if (removed === 0) return 0;
  const state = readState(dir);
  writeState({ ...state, droppedSinceLastSend: (state.droppedSinceLastSend ?? 0) + removed }, dir);
  return removed;
}

export interface Lock {
  /** Touch the lock; false once it is no longer ours, and the holder must stop sending. */
  refresh(): boolean;
  release(): void;
}

function ownsLock(dir: string, nonce: string): boolean {
  try {
    return readFileSync(lockPath(dir), "utf-8").split("\n")[1] === nonce;
  } catch {
    return false;
  }
}

/**
 * Take the single-flusher lock, or return undefined when a live flusher holds it. A stale lock is
 * moved aside with a rename, and staleness is judged again on what was moved: if another taker
 * got there first, the file moved is its fresh lock, which is put back. The lock carries the pid
 * and a nonce, so a holder whose lock was taken over can tell, and never removes the new one.
 */
export function tryAcquireLock(dir: string, now = Date.now()): Lock | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath(dir), "wx", 0o600);
      writeSync(fd, `${process.pid}\n${nonce}`);
      closeSync(fd);
      return {
        refresh: () => {
          if (!ownsLock(dir, nonce)) return false;
          try {
            const at = new Date();
            utimesSync(lockPath(dir), at, at);
          } catch {}
          return true;
        },
        release: () => {
          if (!ownsLock(dir, nonce)) return;
          try {
            unlinkSync(lockPath(dir));
          } catch {}
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      if (isFlusherLive(dir, now)) return undefined;
      const aside = `${lockPath(dir)}.${nonce}.stale`;
      try {
        renameSync(lockPath(dir), aside);
        if (isLive(statSync(aside).mtimeMs, now)) {
          try {
            linkSync(aside, lockPath(dir));
          } catch {}
          unlinkSync(aside);
          return undefined;
        }
        unlinkSync(aside);
      } catch {}
    }
  }
  return undefined;
}

// A lock stamped well in the future was written before the clock went backwards. Counting it as
// live would keep every hook from starting a flusher until the clock caught up. A small negative
// age is only filesystem timestamp granularity.
function isLive(touchedAt: number, now: number): boolean {
  const age = now - touchedAt;
  return age > -LOCK_STALE_MS && age < LOCK_STALE_MS;
}

export function isFlusherLive(dir: string, now = Date.now()): boolean {
  try {
    return isLive(statSync(lockPath(dir)).mtimeMs, now);
  } catch {
    return false;
  }
}

export function removeOutbox(root = OUTBOX_ROOT): void {
  rmSync(root, { recursive: true, force: true });
}
