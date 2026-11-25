import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { usageEventId } from "./event-id.js";
import { EVENTS } from "./hooks/types.js";
import { enqueue, tryAcquireLock } from "./outbox.js";
import { locateTranscript } from "./transcript-locate.js";
import { readClaudeUsage } from "./transcript-usage.js";
import {
  forgetRecord,
  listSessions,
  loadUsageState,
  pruneRecords,
  SESSIONS_ROOT,
} from "./usage-sessions.js";
import type { SessionRecord } from "./usage-types.js";

// A session that never sent SessionEnd is read once it has been quiet this long. A transcript is
// complete at SessionEnd and not at Stop (ledger: Claude Code transcripts carry per-response usage).
export const IDLE_MS = 30 * 60 * 1000;

export interface CollectOptions {
  /** The outbox scope directory the events are queued into. */
  dir: string;
  /** `endpointKey` of the configured backend. A record from another is dropped, never sent. */
  endpoint: string;
  root?: string;
  now?: number;
  idleMs?: number;
  version: string;
  /** Called between sessions so a long read keeps the flusher's lock fresh. */
  refresh?: () => boolean;
  /** Finds a session's transcript. Defaults to the search of the agents' config directories. */
  locate?: (record: SessionRecord) => string | undefined;
  /** Writes each queued event to the local log too, so the log holds what the network receives. */
  log?: (event: Record<string, unknown>) => void;
}

// How long before a transcript that could not be found is searched for again.
const NOT_FOUND_RETRY_MS = 10 * 60 * 1000;

/**
 * Reads the transcripts of every session that is due and queues one `session_token_usage` event per
 * model and scope with what was added since the last read. Returns how many it queued. A session's
 * mark moves only after all its events are in the queue, and the event ids come from the offsets
 * read, so a pass repeated after a lost mark is stored once by the backend.
 */
export async function collectUsage({
  dir,
  endpoint,
  root = SESSIONS_ROOT,
  now = Date.now(),
  idleMs = IDLE_MS,
  version,
  refresh,
  log,
  locate = locateTranscript,
}: CollectOptions): Promise<number> {
  // One flusher at a time owns the state: it is read, changed and written whole. A flusher that
  // finds it taken skips this pass, and the next one picks the sessions up.
  const lock = tryAcquireLock(root);
  if (!lock) return 0;
  let queued = 0;
  try {
    const state = loadUsageState(endpoint, root, now);
    state.prune(pruneRecords(now, root));
    for (const { key, record } of listSessions(root)) {
      if (!lock.refresh() || (refresh && !refresh())) break;
      if (record.endpoint !== endpoint) {
        forgetRecord(key, root);
        continue;
      }
      const mark = state.markOf(key);
      const due = record.ended || now - record.touched_at >= idleMs;
      const settled = `${record.touched_at}:${record.ended}`;
      if (!due || mark.settled === settled || now < (mark.retryAt ?? 0)) continue;
      try {
        const path = locate(record);
        if (!path) {
          // Not found yet, or not findable: look again later, until the record expires.
          state.setMark(key, { ...mark, retryAt: now + NOT_FOUND_RETRY_MS });
          continue;
        }
        let stamp = now;
        try {
          stamp = Math.floor(statSync(path).mtimeMs);
        } catch {}
        // A session with no SessionEnd is read only once its transcript has gone quiet: the record
        // is touched by the hooks, so a long turn can outlast the window while still being written.
        if (!record.ended && now - stamp < idleMs) continue;
        const result = await readClaudeUsage(path, mark.cursors, {
          session: key,
          ownerOf: state.ownerOf,
        });
        const pass = createHash("sha256").update(JSON.stringify(result.ranges)).digest("hex");
        for (const row of result.rows) {
          const id = usageEventId(
            stamp,
            [record.tool, record.session_id, row.model, row.from_subagent, pass].join("\n"),
          );
          const event = {
            event_id: id,
            timestamp: new Date(stamp).toISOString(),
            source: "hook",
            event: EVENTS.SessionTokenUsage,
            codebase: record.codebase,
            ai_tool: record.tool,
            session_id: record.session_id,
            version,
            ...row,
            usage_source: "transcript",
          };
          enqueue(event, dir, { now, sendNow: record.ended });
          try {
            log?.(event);
          } catch {}
          queued += 1;
        }
        // Claims and mark move together, after the events are queued: a crash before the save
        // rereads the same bytes under the same owner and names the events the same way.
        state.addClaims(result.claimed);
        state.setMark(key, { cursors: result.cursors, settled });
      } catch {
        // An unreadable file or a queue that refuses leaves the cursors where they were, and a
        // later pass reads the same bytes again, not every 2 seconds.
        state.setMark(key, { ...mark, retryAt: now + NOT_FOUND_RETRY_MS });
      }
    }
    // Only while the lock is still ours: one stolen as stale may have been written over since.
    if (lock.refresh()) state.save();
  } finally {
    lock.release();
  }
  return queued;
}
