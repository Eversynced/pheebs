// Target: src/usage-types.ts
import type { AiTool } from "./hooks/types.js";

/** The tools whose transcripts carry usage. Cursor's carry none (ledger 2026-11-19). */
export type UsageTool = Extract<AiTool, "claude_code" | "codex">;

/** Integers only. An optional field is absent, never 0, when the transcript does not carry it. */
export interface TokenCounts {
  /** Excludes cache reads. On Codex it is `input_tokens - cached_input_tokens`. */
  input_tokens: number;
  /** Includes reasoning tokens. */
  output_tokens: number;
  cache_read_tokens?: number;
  /** Absent on Codex. */
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
  /** Codex only: the cumulative totals at that offset, and the model of the turn in force.
   *  `skip` marks a rollout that is never read (a fork, whose totals start non-zero). */
  codex?: {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    model?: string;
    skip?: true;
  };
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

/** Written by the hook, read by the flusher. Never part of an event. */
export interface SessionRecord {
  tool: UsageTool;
  session_id: string;
  codebase: string;
  /** Why it is stored: the flusher has no other way to find the file. Owner-only, local only. */
  transcript_path: string;
  ended: boolean;
  /** ms epoch of the last hook that touched the record. */
  touched_at: number;
}

/** The flusher's own file for a session, so the hook and the flusher never write the same one. */
export interface SessionMark {
  cursors: Cursors;
  /** `<touched_at>:<ended>` of the record a pass last settled, so an unchanged one is not rescanned. */
  settled?: string;
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
