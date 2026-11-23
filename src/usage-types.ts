import type { AiTool } from "./hooks/types.js";

/** The tool whose transcripts carry usage here. Cursor's carry none (ledger: Cursor transcripts carry no token usage). */
export type UsageTool = Extract<AiTool, "claude_code">;

/** Integers only. An optional field is absent, never 0, when the transcript does not carry it. */
export interface TokenCounts {
  /** Excludes cache reads. */
  input_tokens: number;
  /** Includes reasoning tokens. */
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** A subset of output_tokens. Absent when no line of the read carried it. */
  reasoning_tokens?: number;
}

export interface UsageRow extends TokenCounts {
  model: string;
  from_subagent: boolean;
}

/** Where the last read of one transcript file stopped. Offsets and counters, never content. */
export interface FileCursor {
  /** Byte offset just past the last complete line read. */
  offset: number;
}

/** Keyed by file name relative to the transcript: "" for the parent, "agent-<id>.jsonl" below it. */
export type Cursors = Record<string, FileCursor>;

export interface UsageRead {
  rows: UsageRow[];
  /** Cursors as they would be once these rows are accepted. The reader never persists them. */
  cursors: Cursors;
  /** Offsets each file was read between, so the caller can name this pass. */
  ranges: Record<string, [from: number, to: number]>;
}

/** Written by the hook, read by the flusher. Never part of an event. Holds no path. */
export interface SessionRecord {
  tool: UsageTool;
  session_id: string;
  codebase: string;
  ended: boolean;
  /** The backend and token the hook saw (`scopeKey`), so usage is only ever sent to that one. */
  scope: string;
  /** ms epoch of the first hook that recorded the session, and of the last one that touched it. */
  started_at: number;
  touched_at: number;
}

/** The flusher's own file for a session, so the hook and the flusher never write the same one. */
export interface SessionMark {
  cursors: Cursors;
  /** `<touched_at>:<ended>` of the record a pass last settled, so an unchanged one is not rescanned. */
  settled?: string;
  /** ms epoch before which a transcript that could not be found is not searched for again. */
  retryAt?: number;
  /** The earliest `started_at` seen, kept past the record's expiry so a resumed session still
   *  finds its date folder. */
  startedAt?: number;
}

/** The fields the new event carries beside the envelope. */
export interface SessionTokenUsageEvent extends UsageRow {
  event: "session_token_usage";
  session_id: string;
  ai_tool: UsageTool;
  codebase: string;
  version: string;
  event_id: string;
  timestamp: string;
  source: "hook";
  usage_source: "transcript";
}
