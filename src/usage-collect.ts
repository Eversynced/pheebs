import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { usageEventId } from "./event-id.js";
import { EVENTS } from "./hooks/types.js";
import { enqueue } from "./outbox.js";
import { locateTranscript } from "./transcript-locate.js";
import { readClaudeUsage, readCodexUsage } from "./transcript-usage.js";
import { forgetSession, listSessions, pruneSessions, writeMark } from "./usage-sessions.js";
import type { SessionRecord, UsageRead } from "./usage-types.js";

// A session that never sent SessionEnd, or whose tool has no such hook, is read once it has been
// quiet this long. A transcript is complete at SessionEnd and not at Stop (ledger 2026-11-19).
export const IDLE_MS = 30 * 60 * 1000;

export interface CollectOptions {
  /** The outbox scope directory the events are queued into. */
  dir: string;
  /** The configured backend and token. A record from any other scope is dropped, never sent. */
  scope: string;
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

const read = (path: string, record: SessionRecord, cursors: UsageRead["cursors"]) =>
  record.tool === "codex" ? readCodexUsage(path, cursors) : readClaudeUsage(path, cursors);

/**
 * Reads the transcripts of every session that is due and queues one `session_token_usage` event per
 * model and scope with what was added since the last read. Returns how many it queued. A session's
 * mark moves only after all its events are in the queue, and the event ids come from the offsets
 * read, so a pass repeated after a lost mark is stored once by the backend.
 */
export async function collectUsage({
  dir,
  scope,
  root,
  now = Date.now(),
  idleMs = IDLE_MS,
  version,
  refresh,
  log,
  locate = locateTranscript,
}: CollectOptions): Promise<number> {
  pruneSessions(now, root);
  let queued = 0;
  for (const { key, record, mark } of listSessions(root)) {
    if (refresh && !refresh()) break;
    if (record.scope !== scope) {
      forgetSession(key, root);
      continue;
    }
    const due = record.ended || now - record.touched_at >= idleMs;
    const settled = `${record.touched_at}:${record.ended}`;
    if (!due || mark.settled === settled || now < (mark.retryAt ?? 0)) continue;
    try {
      const startedAt = Math.min(record.started_at, mark.startedAt ?? Number.POSITIVE_INFINITY);
      const path = locate({ ...record, started_at: startedAt });
      if (!path) {
        // Not found yet, or not findable: look again later, until the record expires.
        writeMark(key, { ...mark, retryAt: now + NOT_FOUND_RETRY_MS }, root);
        continue;
      }
      let stamp = now;
      try {
        stamp = Math.floor(statSync(path).mtimeMs);
      } catch {}
      // A session with no SessionEnd is read only once its transcript has gone quiet: the record
      // is touched by the hooks, so a long turn can outlast the window while still being written.
      if (!record.ended && now - stamp < idleMs) continue;
      const result = await read(path, record, mark.cursors);
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
      writeMark(key, { cursors: result.cursors, settled, startedAt }, root);
    } catch {
      // An unreadable file or a queue that refuses leaves the mark where it was, and the next pass
      // reads the same bytes again.
    }
  }
  return queued;
}
