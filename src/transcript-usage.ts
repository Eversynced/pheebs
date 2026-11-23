import { createReadStream, type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Cursors, UsageRead, UsageRow } from "./usage-types.js";

// A line past this is skipped unread, so one pasted image or tool dump cannot hold a whole line in
// memory. It undercounts nothing in practice: a usage line is a few hundred bytes.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const NEWLINE = 0x0a;

// A model id is the one string read out of a transcript, so it has to look like one: anything else
// could be text, and is dropped with its usage rather than sent. Same shape the hook accepts.
const MODEL_ID = /^[A-Za-z0-9._:@[\]-]{1,100}$/;
const isModelId = (value: unknown): value is string =>
  typeof value === "string" && MODEL_ID.test(value);

/**
 * Calls `onLine` for each complete line from `from` that contains one of `needles`, and returns the
 * offset just past the last complete line. A half-written last line is left for the next read.
 * Matching is done on the raw bytes, so the many lines that carry no usage are never decoded.
 */
async function scanLines(
  path: string,
  from: number,
  needles: Buffer[],
  onLine: (line: string) => void,
): Promise<number> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let oversized = false;
  let consumed = from;

  const finish = (tail: Buffer, lineBytes: number) => {
    consumed += lineBytes + 1;
    if (!oversized) {
      const line = pending.length ? Buffer.concat([...pending, tail]) : tail;
      if (needles.some((needle) => line.includes(needle))) onLine(line.toString("utf-8"));
    }
    pending = [];
    pendingBytes = 0;
    oversized = false;
  };

  for await (const chunk of createReadStream(path, { start: from }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      finish(chunk.subarray(start, at), pendingBytes + (at - start));
      start = at + 1;
    }
    const rest = chunk.subarray(start);
    pendingBytes += rest.length;
    if (pendingBytes > MAX_LINE_BYTES) {
      oversized = true;
      pending = [];
    } else if (!oversized && rest.length) {
      pending.push(rest);
    }
  }
  return consumed;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface Tally {
  model: string;
  from_subagent: boolean;
  input: number;
  output: number;
  read?: number;
  write?: number;
  reasoning?: number;
}

function toRow(tally: Tally): UsageRow {
  return {
    model: tally.model,
    from_subagent: tally.from_subagent,
    input_tokens: tally.input,
    output_tokens: tally.output,
    ...(tally.read === undefined ? {} : { cache_read_tokens: tally.read }),
    ...(tally.write === undefined ? {} : { cache_write_tokens: tally.write }),
    ...(tally.reasoning === undefined ? {} : { reasoning_tokens: tally.reasoning }),
  };
}

const add = (total: number | undefined, value: number | undefined) =>
  value === undefined ? total : (total ?? 0) + value;

/** The size of a file, or undefined when it cannot be read: a transcript that is gone is nothing to read. */
function sizeOf(path: string): number | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

// `<session>.jsonl` keeps its subagents under `<session>/subagents/`, workflows one level deeper.
function subagentFiles(parent: string): string[] {
  const root = join(parent.replace(/\.jsonl$/, ""), "subagents");
  const found: string[] = [];
  const walk = (dir: string, relative: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (/^agent-.*\.jsonl$/.test(entry.name)) found.push(rel);
    }
  };
  walk(root, "");
  return found.sort();
}

const CLAUDE_NEEDLE = [Buffer.from('"usage"')];

/**
 * Sums a Claude Code session's usage by model: the parent transcript plus every subagent file below
 * it, from the offsets in `cursors`. A streamed response repeats its line, so each `message.id` and
 * `requestId` counts once at its largest value per field. Nothing is persisted here. The dedup
 * holds within one read: a read that ends between two lines of one streamed response counts that
 * response again on the next read, so the caller reads a transcript only once it has gone quiet.
 */
export async function readClaudeUsage(
  transcriptPath: string,
  cursors: Cursors = {},
): Promise<UsageRead> {
  const next: Cursors = { ...cursors };
  const ranges: UsageRead["ranges"] = {};
  const tallies = new Map<string, Tally>();

  const files: [string, string][] = [["", transcriptPath]];
  for (const rel of subagentFiles(transcriptPath)) {
    files.push([rel, join(transcriptPath.replace(/\.jsonl$/, ""), "subagents", rel)]);
  }

  for (const [rel, path] of files) {
    const size = sizeOf(path);
    if (size === undefined) continue;
    const from = cursors[rel]?.offset ?? 0;
    // A file smaller than its cursor was replaced; counting it again would double count.
    if (size < from) {
      next[rel] = { offset: size };
      continue;
    }
    const byKey = new Map<string, Tally>();
    const end = await scanLines(path, from, CLAUDE_NEEDLE, (line) => {
      let entry: { type?: unknown; requestId?: unknown; message?: Record<string, unknown> };
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const message = entry.message;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (entry.type !== "assistant" || !message || !usage) return;
      const { id, model } = message;
      if (typeof id !== "string" || !isModelId(model) || model === "<synthetic>") return;
      if (!isCount(usage.input_tokens) || !isCount(usage.output_tokens)) return;
      const key = `${id}:${typeof entry.requestId === "string" ? entry.requestId : ""}`;
      const thinking = (usage.output_tokens_details as Record<string, unknown> | undefined)
        ?.thinking_tokens;
      const seen = byKey.get(key);
      const read = isCount(usage.cache_read_input_tokens)
        ? usage.cache_read_input_tokens
        : undefined;
      const write = isCount(usage.cache_creation_input_tokens)
        ? usage.cache_creation_input_tokens
        : undefined;
      const reasoning = isCount(thinking) ? thinking : undefined;
      const most = (a: number | undefined, b: number | undefined) =>
        a === undefined ? b : b === undefined ? a : Math.max(a, b);
      byKey.set(key, {
        model,
        from_subagent: rel !== "",
        input: Math.max(seen?.input ?? 0, usage.input_tokens),
        output: Math.max(seen?.output ?? 0, usage.output_tokens),
        read: most(seen?.read, read),
        write: most(seen?.write, write),
        reasoning: most(seen?.reasoning, reasoning),
      });
    });
    for (const tally of byKey.values()) {
      const group = `${tally.model}|${tally.from_subagent}`;
      const total = tallies.get(group) ?? {
        model: tally.model,
        from_subagent: tally.from_subagent,
        input: 0,
        output: 0,
      };
      total.input += tally.input;
      total.output += tally.output;
      total.read = add(total.read, tally.read);
      total.write = add(total.write, tally.write);
      total.reasoning = add(total.reasoning, tally.reasoning);
      tallies.set(group, total);
    }
    next[rel] = { offset: end };
    ranges[rel] = [from, end];
  }
  return { rows: [...tallies.values()].map(toRow), cursors: next, ranges };
}

const CODEX_NEEDLES = ["token_count", "turn_context", "session_meta"].map((s) => Buffer.from(s));

/**
 * Sums a Codex rollout's usage by model. The rollout holds cumulative totals, so each count is the
 * difference between consecutive totals, attributed to the model of the turn in force. `input` is
 * net of cache reads, as Claude Code's is. A fork replays its parent's totals, so it is not read.
 */
export async function readCodexUsage(
  rolloutPath: string,
  cursors: Cursors = {},
): Promise<UsageRead> {
  const size = sizeOf(rolloutPath);
  const prior = cursors[""];
  if (size === undefined || prior?.codex?.skip)
    return { rows: [], cursors: { ...cursors }, ranges: {} };
  const from = prior?.offset ?? 0;
  const zero = { input: 0, cached: 0, output: 0, reasoning: 0 };
  // A rollout that shrank is a different file under the same name, so its old totals no longer
  // apply.
  if (size < from)
    return {
      rows: [],
      cursors: { "": { ...prior, offset: size, codex: { ...prior?.codex, ...zero } } },
      ranges: {},
    };

  const state = { ...zero, ...prior?.codex };
  if (!isModelId(state.model)) state.model = undefined;
  let skip = false;
  const tallies = new Map<string, Tally>();

  const end = await scanLines(rolloutPath, from, CODEX_NEEDLES, (line) => {
    let entry: { type?: unknown; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const payload = entry.payload;
    if (!payload) return;
    if (entry.type === "session_meta") {
      if (payload.forked_from_id !== undefined) skip = true;
    } else if (entry.type === "turn_context") {
      if (isModelId(payload.model)) state.model = payload.model;
    } else if (entry.type === "event_msg" && payload.type === "token_count") {
      const totals = (payload.info as { total_token_usage?: Record<string, unknown> } | null)
        ?.total_token_usage;
      if (!totals) return;
      const { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } = totals;
      if (!isCount(input_tokens) || !isCount(output_tokens)) return;
      const cached = isCount(cached_input_tokens) ? cached_input_tokens : 0;
      const reasoning = isCount(reasoning_output_tokens) ? reasoning_output_tokens : 0;
      const decreased = input_tokens < state.input || output_tokens < state.output;
      const dIn = input_tokens - state.input;
      const dCached = cached - state.cached;
      const dOut = output_tokens - state.output;
      const dReasoning = reasoning - state.reasoning;
      Object.assign(state, { input: input_tokens, cached, output: output_tokens, reasoning });
      // A total that went down is a restarted counter, not usage; the next delta counts from it.
      if (decreased || !state.model) return;
      const tally = tallies.get(state.model) ?? {
        model: state.model,
        from_subagent: false,
        input: 0,
        output: 0,
      };
      tally.input += Math.max(0, dIn - dCached);
      tally.output += dOut;
      // Absent is not zero: a rollout that never reports a field leaves it off the row.
      if (isCount(cached_input_tokens)) tally.read = (tally.read ?? 0) + Math.max(0, dCached);
      if (isCount(reasoning_output_tokens)) {
        tally.reasoning = (tally.reasoning ?? 0) + Math.max(0, dReasoning);
      }
      tallies.set(state.model, tally);
    }
  });
  if (skip)
    return {
      rows: [],
      cursors: { "": { offset: end, codex: { ...state, skip: true } } },
      ranges: {},
    };
  return {
    rows: [...tallies.values()].map(toRow),
    cursors: { "": { offset: end, codex: state } },
    ranges: { "": [from, end] },
  };
}
