import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "./pheebs-store.js";
import type { SessionMark, SessionRecord, UsageTool } from "./usage-types.js";

/**
 * The sessions whose transcripts the flusher will read for token usage. A record holds the session
 * id, tool and codebase, the backend endpoint and two timestamps, never a path: the flusher finds
 * the transcript from the id (see `locateTranscript`).
 *
 * The hook writes `<key>.json`, one small file per session, and the flusher writes everything else
 * to the one `usage-state.json`. Hooks run at once in many sessions and must never wait, so they
 * cannot share a file that needs a lock; the flusher can, so its marks and claims share one file
 * under a lock and a change of backend resets all of it in one step.
 */
export const SESSIONS_ROOT = join(homedir(), ".pheebs", "sessions");
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// A mark outlives its record: a resumed session gets a new record and must carry on from the old
// offsets, or its whole transcript would be counted again.
const KEEP_MARK_MS = 180 * 24 * 60 * 60 * 1000;

// The state names the backend endpoint it was built for. Built for another, it is dropped and every
// session is read from 0: that backend has never seen them, and no history of the earlier endpoint
// is kept, so going back to an endpoint sends the whole session again.
const STATE_FILE = "usage-state.json";
// Requests already counted, across sessions: a resumed, forked or background session's file starts
// with another session's lines, and only this tells the copy from the original. Kept as long as a
// mark is, because a session can be resumed and copy its history for that long, and no longer. The
// caps stop the file growing without bound.
const MAX_CLAIMS = 250_000;
const MAX_MARKS = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TOOLS = new Set<string>(["claude_code"]);

export interface Options {
  root?: string;
  now?: number;
}

export function sessionKey(tool: UsageTool, sessionId: string): string {
  return createHash("sha256").update(`${tool}\n${sessionId}`).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as SessionRecord;
  return (
    TOOLS.has(r.tool) &&
    typeof r.session_id === "string" &&
    typeof r.codebase === "string" &&
    typeof r.ended === "boolean" &&
    typeof r.endpoint === "string" &&
    Number.isFinite(r.touched_at)
  );
}

// Staged and renamed, so a reader never sees half a file.
function writeAtomic(path: string, value: unknown): void {
  const staged = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
}

/**
 * Called from a hook, so it is one small write and nothing more. The transcript is never opened
 * here. It throws on an unwritable folder, and the caller treats that as nothing to record.
 */
export function noteSession(
  record: Omit<SessionRecord, "touched_at" | "ended"> & { ended?: boolean },
  { root = SESSIONS_ROOT, now = Date.now() }: Options = {},
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${sessionKey(record.tool, record.session_id)}.json`);
  const previous = readJsonFile<Partial<SessionRecord>>(path);
  // Only a start or an end says whether the session is over. A Stop that lands after SessionEnd
  // must not reopen it.
  const ended = record.ended ?? previous?.ended === true;
  writeAtomic(path, { ...record, ended, touched_at: now });
}

/** Every record the hook wrote, whatever it was recorded under. */
export function listSessions(root = SESSIONS_ROOT): { key: string; record: SessionRecord }[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const sessions: { key: string; record: SessionRecord }[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const record = readJsonFile<unknown>(join(root, name));
    if (isRecord(record)) sessions.push({ key: name.slice(0, -5), record });
  }
  return sessions;
}

/**
 * Drops a record, for one recorded under a backend that is no longer the configured one. It stays
 * a hook's file: the flusher only ever removes it.
 */
export function forgetRecord(key: string, root = SESSIONS_ROOT): void {
  try {
    rmSync(join(root, `${key}.json`), { force: true });
  } catch {}
}

/** Drops records untouched for 30 days, and files left by earlier layouts. */
export function pruneRecords(now = Date.now(), root = SESSIONS_ROOT): Set<string> {
  const live = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {}
  for (const name of names) {
    const drop = () => {
      try {
        rmSync(join(root, name), { force: true });
      } catch {}
    };
    // Written by earlier layouts of this feature, before the state moved into one file.
    if (/^[0-9a-f]{32}\.(?:[0-9a-f]{16}\.)?mark\.json$/.test(name)) drop();
    else if (/^claims(?:\.[0-9a-f]{16})?\.json$/.test(name)) drop();
    else if (/^[0-9a-f]{32}\.json$/.test(name)) {
      const record = readJsonFile<unknown>(join(root, name));
      if (!isRecord(record) || now - record.touched_at >= KEEP_MS) drop();
      else live.add(name.slice(0, -5));
    }
  }
  return live;
}

/** Forgets every session, for `uninstall`. */
export function removeSessions(root = SESSIONS_ROOT): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

type StoredMark = SessionMark & { at: number };

// An offset that is not a whole non-negative number would reach the reader as a start position.
function validCursors(cursors: unknown): boolean {
  if (typeof cursors !== "object" || cursors === null) return false;
  return Object.values(cursors).every(
    (c) =>
      Number.isSafeInteger((c as { offset?: unknown })?.offset) &&
      (c as { offset: number }).offset >= 0,
  );
}

export interface UsageState {
  markOf(key: string): SessionMark;
  setMark(key: string, mark: SessionMark): void;
  ownerOf(key: string): string | undefined;
  /** Records requests no one has claimed. */
  addClaims(claimed: Record<string, string>): void;
  /** Drops marks with no live record that nothing has written for 180 days. */
  prune(live: Set<string>): void;
  /** Writes the state if anything changed. */
  save(): void;
}

/**
 * The flusher's marks and claims, for one backend endpoint. Read and written under the lock the
 * caller holds (see `collectUsage`), so two flushers cannot overwrite each other's.
 */
export function loadUsageState(
  endpoint: string,
  root = SESSIONS_ROOT,
  now = Date.now(),
): UsageState {
  const today = Math.floor(now / DAY_MS);
  const oldest = today - Math.floor(KEEP_MARK_MS / DAY_MS);
  const marks = new Map<string, StoredMark>();
  const claims = new Map<string, [owner: string, day: number]>();
  const stored = readJsonFile<{ endpoint?: unknown; marks?: unknown; claims?: unknown }>(
    join(root, STATE_FILE),
  );
  let dirty = false;
  if (stored?.endpoint === endpoint) {
    for (const [key, value] of Object.entries((stored.marks ?? {}) as Record<string, StoredMark>)) {
      if (/^[0-9a-f]{32}$/.test(key) && Number.isFinite(value?.at) && validCursors(value.cursors)) {
        marks.set(key, value);
      }
    }
    for (const [key, value] of Object.entries((stored.claims ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(value) || typeof value[0] !== "string" || !Number.isFinite(value[1])) {
        continue;
      }
      if (value[1] >= oldest) claims.set(key, [value[0], value[1]]);
    }
  } else if (stored) {
    // Built for another backend: nothing of it carries over, and the file is replaced at save.
    dirty = true;
  }
  return {
    markOf: (key) => marks.get(key) ?? { cursors: {} },
    setMark(key, mark) {
      marks.set(key, { ...mark, at: now });
      dirty = true;
    },
    ownerOf: (key) => claims.get(key)?.[0],
    addClaims(claimed) {
      for (const [key, owner] of Object.entries(claimed)) {
        if (claims.has(key)) continue;
        claims.set(key, [owner, today]);
        dirty = true;
      }
    },
    prune(live) {
      for (const [key, mark] of marks) {
        if (!live.has(key) && now - mark.at >= KEEP_MARK_MS) {
          marks.delete(key);
          dirty = true;
        }
      }
    },
    save() {
      if (!dirty) return;
      let markEntries = [...marks];
      if (markEntries.length > MAX_MARKS) {
        markEntries = markEntries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_MARKS);
      }
      let claimEntries = [...claims];
      if (claimEntries.length > MAX_CLAIMS) {
        // Reversed first, so among entries of one day the newest insertions are the ones kept, and
        // back to oldest first afterwards, so the next load sees the order they were added in.
        claimEntries = claimEntries
          .reverse()
          .sort((a, b) => b[1][1] - a[1][1])
          .slice(0, MAX_CLAIMS)
          .reverse();
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeAtomic(join(root, STATE_FILE), {
        v: 1,
        endpoint,
        marks: Object.fromEntries(markEntries),
        claims: Object.fromEntries(claimEntries),
      });
      dirty = false;
    },
  };
}
