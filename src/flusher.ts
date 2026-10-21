import { readFileSync } from "node:fs";
import { baseUrl, hasBackend, ingestBatchUrl, ingestUrl } from "./backend-config.js";
import { readCapped } from "./insights.js";
import {
  discardOtherScopes,
  type Lock,
  listPending,
  MAX_PAUSE_MS,
  type Pending,
  readState,
  removePending,
  scopeDir,
  scopeKey,
  trimToCaps,
  tryAcquireLock,
  UNSUPPORTED_RECHECK_MS,
  updateState,
} from "./outbox.js";
import { readStoredToken } from "./token.js";
import { writeMarker } from "./transports/http.js";

// How long the oldest queued event waits before a send, so one request carries what a burst of
// hooks produced. It also bounds how late an event reaches the backend. The variable exists for
// tests, which cannot wait a minute.
const LINGER_MS = (() => {
  const configured = Number(process.env.PHEEBS_FLUSH_LINGER_MS ?? Number.NaN);
  return Number.isFinite(configured) && configured >= 0 ? configured : 60_000;
})();

const MAX_BATCH_EVENTS = 500;
const MAX_BATCH_BYTES = 512 * 1024;
const SEND_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 5_000;
// Only `accepted` and `rejected` are read from a batch answer, so a body past this is not worth
// reading.
const MAX_ANSWER_BYTES = 64 * 1024;

// Failures that happen before a request leaves the machine, so the backend cannot have stored it:
// no route, no address, no connection, or a TLS handshake that failed before any body was sent.
// ETIMEDOUT is left out: it can also end a connection whose request already went out.
const NEVER_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UNREADABLE_FOR_GOOD = new Set(["EACCES", "EISDIR", "ENOTDIR"]);
const TLS_FAILURE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

export type FlushOutcome = "empty" | "sent" | "retry" | "stop";

export interface FlushContext {
  token: string;
  // Fixed when the flusher starts. Events go only to the backend they were queued for, even if
  // the configured one changes while the flusher runs.
  batchUrl: string;
  singleUrl: string;
  /** The queue for that backend and token, and only that one. */
  dir: string;
  lock?: Pick<Lock, "refresh">;
  /** False once the developer has pointed Pheebs elsewhere, and sending must stop. */
  stillScoped?: () => boolean;
  fetchImpl?: typeof fetch;
  now?: number;
  random?: () => number;
}

interface BatchResult {
  accepted?: unknown;
  rejected?: unknown[];
}

function takeBatch(pending: Pending[], maxEvents: number): Pending[] {
  const batch: Pending[] = [];
  let bytes = 0;
  for (const item of pending) {
    if (batch.length >= maxEvents) break;
    if (batch.length > 0 && bytes + item.bytes > MAX_BATCH_BYTES) break;
    batch.push(item);
    bytes += item.bytes;
  }
  return batch;
}

// A file that no longer parses is dropped rather than blocking the queue forever. One that cannot
// be read right now, say held open by a virus scanner, is left for the next pass.
function readEvents(batch: Pending[]): { sendable: Pending[]; events: unknown[]; corrupt: number } {
  const sendable: Pending[] = [];
  const events: unknown[] = [];
  const corrupt: Pending[] = [];
  for (const item of batch) {
    let raw: string;
    try {
      raw = readFileSync(item.path, "utf-8");
    } catch (err) {
      // A file this process may never read would otherwise sit at the head of the queue and
      // hold back everything behind it for the whole age cap.
      if (UNREADABLE_FOR_GOOD.has((err as NodeJS.ErrnoException).code ?? "")) corrupt.push(item);
      continue;
    }
    try {
      events.push(JSON.parse(raw));
      sendable.push(item);
    } catch {
      corrupt.push(item);
    }
  }
  // Counted only once they are gone, or the caller would take the queue as moving and spin.
  return { sendable, events, corrupt: removePending(corrupt) ? corrupt.length : 0 };
}

/** Full jitter over a capped exponential, unless the server named its own wait. */
export function backoffMs(
  attempts: number,
  retryAfter: string | null,
  random: () => number,
  now = Date.now(),
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const named = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(named) && named > 0) return Math.min(named, MAX_PAUSE_MS);
  }
  return Math.floor(random() * Math.min(MAX_PAUSE_MS, BACKOFF_BASE_MS * 2 ** attempts));
}

// Redirects are not followed: a followed one would carry the queued events to a host the developer
// never configured.
function post(ctx: FlushContext, url: string, body: unknown): Promise<Response> {
  return (ctx.fetchImpl ?? fetch)(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify(body),
  });
}

const isRedirect = (status: number) => status >= 300 && status < 400;

// Worth another try later. 408, 425 and 499 come from proxies in front of the backend and say
// nothing about what was sent.
const isTransient = (status: number) =>
  status === 429 || status === 408 || status === 425 || status === 499 || status >= 500;

function neverSent(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && (NEVER_SENT.has(code) || TLS_FAILURE.test(code));
}

// The number of rejected envelopes, or undefined when the 2xx is not a batch result at all. A
// captive portal or a catch-all host answers 200 with a page of HTML, and taking that as delivery
// would empty the queue into nowhere.
async function rejectedCount(res: Response): Promise<number | undefined> {
  try {
    const body = await readCapped(res, MAX_ANSWER_BYTES);
    if (body === undefined) return undefined;
    const result = JSON.parse(body) as BatchResult;
    if (typeof result?.accepted !== "number") return undefined;
    return Array.isArray(result.rejected) ? result.rejected.length : 0;
  } catch {
    return undefined;
  }
}

function retryLater(
  dir: string,
  now: number,
  random: () => number,
  retryAfter: string | null,
  lastError: string,
): FlushOutcome {
  const attempts = (readState(dir).attempts ?? 0) + 1;
  updateState(
    { attempts, nextAttemptAt: now + backoffMs(attempts, retryAfter, random, now), lastError },
    dir,
  );
  return "retry";
}

// A file that was sent but could not be deleted, often one a virus scanner holds for a moment,
// would be sent again at once. Waiting turns that into a rare duplicate instead of a tight loop.
function stuck(dir: string, now: number, random: () => number): FlushOutcome {
  return retryLater(dir, now, random, null, "a sent event could not be removed from the queue");
}

// Keeps the queue, since a rejection can be transient. A fix that changes the base URL or token
// starts a new queue and discards this one, which the message says, because the developer would
// otherwise expect these events to follow; the local log still holds them.
function pauseFor(dir: string, now: number, lastError: string): FlushOutcome {
  updateState(
    {
      nextAttemptAt: now + MAX_PAUSE_MS,
      lastError: `${lastError}; changing base-url or token discards the events queued so far`,
    },
    dir,
  );
  return "stop";
}

// The fallback for a backend without /ingest/batch: one /ingest per event. An event is kept only
// when the backend cannot have stored it (a connection that never opened, a 429, a rejected token,
// a redirect); anything else gets one try, because resending would duplicate rows on a backend
// that never promised to recognise a resend. The exception is the first event after a 404 or 405
// from the batch route, which stays queued until /ingest gives a verdict on it (see `confirming`).
async function sendSingly(
  ctx: FlushContext,
  batch: Pending[],
  events: unknown[],
  probe = false,
): Promise<FlushOutcome> {
  const dir = ctx.dir;
  // Read at the point of failure: a run of single sends can last minutes, and a pause measured
  // from its start would already be over.
  const now = () => ctx.now ?? Date.now();
  const random = ctx.random ?? Math.random;
  let answered = false;
  let lastError: string | undefined;
  // A backend that accepts again ends whatever backoff an earlier failure left, or every hook
  // would keep waiting it out; an accepted send also clears a problem an earlier run left, so
  // doctor stops reporting it. Recorded even when the run stops partway.
  const settle = () => {
    if (!answered && !lastError) return;
    updateState(
      answered ? { attempts: 0, nextAttemptAt: undefined, lastError } : { lastError },
      dir,
    );
  };
  for (const [index, event] of events.entries()) {
    // Each send can take the full timeout, so the lock and the destination are checked per event:
    // a flusher that lost its lock stops before a second one sends the same event, and one whose
    // backend was replaced stops before sending more to it.
    if ((ctx.lock && !ctx.lock.refresh()) || (ctx.stillScoped && !ctx.stillScoped())) {
      settle();
      return "stop";
    }
    // A 404 from the batch route may be a proxy mid-deploy rather than an old backend. Falling
    // back means a day of sends that are never retried, so the first single send has to land
    // before the route is written off; until then nothing is dropped.
    const confirming = probe && index === 0;
    let res: Response;
    try {
      res = await post(ctx, ctx.singleUrl, event);
    } catch (err) {
      if (neverSent(err) || confirming) {
        return retryLater(dir, now(), random, null, "backend unreachable");
      }
      if (!removePending([batch[index]])) return stuck(dir, now(), random);
      lastError = "event dropped, its send failed after it may have arrived";
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      writeMarker(res.status);
      return pauseFor(dir, now(), `token rejected (${res.status})`);
    }
    if (isRedirect(res.status)) {
      return pauseFor(
        dir,
        now(),
        `backend redirected (${res.status}); set base-url to its address`,
      );
    }
    if (res.status === 429) {
      return retryLater(dir, now(), random, res.headers.get("retry-after"), "backend answered 429");
    }
    if (confirming) {
      // Any verdict on the event itself shows /ingest is there; only an answer that could also
      // come from a missing route or a proxy leaves the question open.
      if (isTransient(res.status) || res.status === 404 || res.status === 405) {
        return retryLater(
          dir,
          now(),
          random,
          null,
          `batch route missing, /ingest answered ${res.status}`,
        );
      }
      updateState({ batchUnsupportedUntil: now() + UNSUPPORTED_RECHECK_MS }, dir);
    }
    if (!removePending([batch[index]])) return stuck(dir, now(), random);
    if (res.ok) {
      answered = true;
    } else {
      // Doctor reports the drop, or a base URL with the wrong path would lose every event without
      // a word.
      lastError = `event dropped, backend answered ${res.status}`;
    }
  }
  settle();
  return "sent";
}

// "retry" means the batch is still queued behind a backoff; "stop" means the flusher should end
// its run, keeping the queue for a later one.
export async function flushOnce(ctx: FlushContext): Promise<FlushOutcome> {
  const dir = ctx.dir;
  const now = ctx.now ?? Date.now();
  const random = ctx.random ?? Math.random;
  const state = readState(dir);
  const pending = listPending(dir);
  if (pending.length === 0) return "empty";

  // A size a 413 taught is kept for a day: the backend's limit does not change between batches,
  // and forgetting it after each success would mean another run of 413s for every batch.
  const learnedUntil = state.maxBatchUntil ?? 0;
  const learned = now < learnedUntil && learnedUntil - now <= UNSUPPORTED_RECHECK_MS;
  const batch = takeBatch(pending, (learned && state.maxBatch) || MAX_BATCH_EVENTS);
  const { sendable, events, corrupt } = readEvents(batch);
  if (sendable.length === 0) {
    // Corrupt files were dropped and the queue moved on; files that could not be read are still
    // there, and trying again at once would only spin.
    return corrupt > 0
      ? "sent"
      : retryLater(dir, now, random, null, "queued events could not be read");
  }

  // A stamp further out than the recheck interval was written before the clock went backwards.
  const until = state.batchUnsupportedUntil ?? 0;
  if (now < until && until - now <= UNSUPPORTED_RECHECK_MS) {
    return sendSingly(ctx, sendable, events);
  }

  const reportedDrops = state.droppedSinceLastSend ?? 0;
  let res: Response;
  try {
    res = await post(ctx, ctx.batchUrl, { events, droppedSinceLastSend: reportedDrops });
  } catch (err) {
    return retryLater(dir, now, random, null, `network: ${(err as Error).name ?? "error"}`);
  }

  if (res.ok) {
    const rejected = await rejectedCount(res);
    if (rejected === undefined) {
      return retryLater(
        dir,
        now,
        random,
        null,
        `backend answered ${res.status} without a batch result`,
      );
    }
    const removed = removePending(sendable);
    updateState(
      {
        attempts: 0,
        nextAttemptAt: undefined,
        // Only what this batch reported: the caps may have dropped more while it was in flight.
        droppedSinceLastSend: Math.max(
          0,
          (readState(dir).droppedSinceLastSend ?? 0) - reportedDrops,
        ),
        lastError: rejected > 0 ? `${rejected} events rejected by the backend` : undefined,
      },
      dir,
    );
    return removed ? "sent" : stuck(dir, now, random);
  }

  const { status } = res;
  if (status === 401 || status === 403) {
    writeMarker(status);
    return pauseFor(dir, now, `token rejected (${status})`);
  }
  if (isRedirect(status)) {
    return pauseFor(dir, now, `backend redirected (${status}); set base-url to its address`);
  }
  if (status === 404 || status === 405) {
    return sendSingly(ctx, sendable, events, true);
  }
  if (status === 413) {
    if (sendable.length === 1) {
      if (!removePending(sendable)) return stuck(dir, now, random);
      updateState({ lastError: "an event larger than the backend accepts was dropped" }, dir);
      return "sent";
    }
    // Progress rather than a failure: the next pass, straight away, sends a smaller batch.
    updateState(
      {
        maxBatch: Math.ceil(sendable.length / 2),
        maxBatchUntil: now + UNSUPPORTED_RECHECK_MS,
        lastError: "batch too large, sending smaller ones",
      },
      dir,
    );
    return "sent";
  }
  if (isTransient(status)) {
    return retryLater(
      dir,
      now,
      random,
      res.headers.get("retry-after"),
      `backend answered ${status}`,
    );
  }
  // Any other 4xx is a verdict on the batch, not the moment: sending it again changes nothing.
  if (!removePending(sendable)) return stuck(dir, now, random);
  updateState({ lastError: `batch dropped, backend answered ${status}` }, dir);
  return "sent";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The configuration the flusher started under is the only one it may send for. A developer who
// points pheebs elsewhere, or changes token, mid-linger has withdrawn the old destination.
function stillScoped(scope: string): boolean {
  const stored = readStoredToken();
  return hasBackend() && stored !== undefined && scopeKey(baseUrl(), stored.token) === scope;
}

// Returns true when it stopped on an empty queue, so the caller re-checks after letting go of the
// lock: an event queued in between saw the lock held and started no flusher of its own.
async function drain(ctx: FlushContext, lock: Lock, linger: boolean) {
  const { dir } = ctx;
  let honourBackoff = linger;
  for (;;) {
    if (!lock.refresh() || !ctx.stillScoped?.()) return false;
    trimToCaps(dir);
    const pending = listPending(dir);
    if (pending.length === 0) return true;

    // Stamps from the future were written before the clock went backwards. Each is taken as
    // already due, as the hook does: honouring one would hold the queue until the clock caught up.
    const now = Date.now();
    const queuedAt = pending[0].queuedAt;
    const next = readState(dir).nextAttemptAt ?? 0;
    const wait = Math.max(
      linger && queuedAt <= now ? queuedAt + LINGER_MS - now : 0,
      honourBackoff && next - now <= MAX_PAUSE_MS ? next - now : 0,
      0,
    );
    if (wait > LINGER_MS) return false;
    if (wait > 0) {
      await sleep(wait);
      continue;
    }

    const outcome = await flushOnce({ ...ctx, lock });
    if (outcome === "stop" || (outcome === "retry" && !linger)) return false;
    // A bare flush was asked to send now, so only the background one waits out a backoff.
    honourBackoff = linger;
  }
}

/**
 * `pheebs flush --linger` is what a hook starts, detached. It sends until the queue is empty, then
 * exits, so it lives for as long as a session keeps producing events and no longer. A backoff
 * longer than the linger window is left to the next hook, which starts a new flusher once it has
 * passed. A bare `pheebs flush` is the developer asking: it sends at once, past any backoff, and
 * stops at the first failure rather than waiting one out.
 */
export async function runFlush({ linger = false }: { linger?: boolean } = {}): Promise<string> {
  // Debug mode promises no network; a queue left from before it was set waits for it to be unset.
  const stored = readStoredToken();
  if (process.env.PHEEBS_DEBUG || !hasBackend() || !stored) {
    return "nothing sent: no backend and token are set, or PHEEBS_DEBUG is on";
  }

  const base = baseUrl();
  const scope = scopeKey(base, stored.token);
  const ctx: FlushContext = {
    token: stored.token,
    batchUrl: ingestBatchUrl(base),
    singleUrl: ingestUrl(base),
    dir: scopeDir(scope),
    stillScoped: () => stillScoped(scope),
  };

  for (let first = true; ; first = false) {
    let lock: Lock | undefined;
    try {
      lock = tryAcquireLock(ctx.dir);
    } catch {
      return "nothing sent: the send queue's folder cannot be written";
    }
    if (!lock)
      return first ? "a background flusher is already sending the queue" : summary(ctx.dir);
    let recheck = false;
    try {
      discardOtherScopes(scope);
      recheck = await drain(ctx, lock, linger);
    } catch {
      // A detached run has nothing to report to. Whatever is still queued waits for the next run.
    } finally {
      lock.release();
    }
    if (!recheck || listPending(ctx.dir).length === 0) return summary(ctx.dir);
  }
}

// What a bare `pheebs flush` prints, so the developer who asked can see whether it worked.
function summary(dir: string): string {
  const pending = listPending(dir).length;
  if (pending === 0) return "the send queue is empty";
  const { lastError } = readState(dir);
  return `${pending} events still queued${lastError ? `; last problem: ${lastError}` : ""}`;
}
