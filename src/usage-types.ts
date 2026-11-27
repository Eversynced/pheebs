import type { AiTool } from "./hooks/types.js";

/** The tool whose transcripts carry usage here. */
export type UsageTool = Extract<AiTool, "claude_code">;

/** Integers only. An optional field is absent, never 0, when the transcript does not carry it. */
export interface TokenCounts {
  /** Excludes cache reads and cache writes. */
  input_tokens: number;
  /** Whether this includes `reasoning_tokens` is not verified. */
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Whether this is part of `output_tokens` is not verified. Absent when no line of the read carried it. */
  reasoning_tokens?: number;
}

export interface UsageRow extends TokenCounts {
  model: string;
  from_subagent: boolean;
}

/** Where the last read of one transcript file stopped. A byte offset, never content. */
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
  /** The requests this read counted, as a digest of their ids, each with the file that counted it. */
  claimed: Record<string, string>;
}

/**
 * Which file counted a request first, across every session. A later file that repeats the request
 * is a copy and is not counted again. Ids only, never content.
 */
export interface Claims {
  /** Names the session, so a file's owner stays the same from one read to the next. */
  session: string;
  /** The owner that counted this request key, or undefined when none has. */
  ownerOf(key: string): string | undefined;
}

/** Written by the hook, read by the flusher. Never part of an event. Holds no path. */
export interface SessionRecord {
  tool: UsageTool;
  session_id: string;
  codebase: string;
  ended: boolean;
  /** `endpointKey` of the backend the hook saw, so usage is only ever sent to that backend. */
  endpoint: string;
  /** ms epoch of the last hook that touched the session. */
  touched_at: number;
  /** ms epoch Pheebs first saw the session, kept across every later note. No usage before it is counted. */
  first_seen: number;
}

/** What the flusher keeps for a session, in its own file, so a hook never writes it. */
export interface SessionMark {
  cursors: Cursors;
  /** `<touched_at>:<ended>` of the record a pass last settled, so an unchanged one is not rescanned. */
  settled?: string;
  /** ms epoch before which a transcript that could not be found is not searched for again. */
  retryAt?: number;
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
