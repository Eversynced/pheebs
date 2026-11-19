// Target: test/transcript-usage.test.ts
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeUsage, readCodexUsage } from "../src/transcript-usage.js";

// Every fixture is synthetic. CANARY stands for prompt text and tool output, which must never
// reach a row.
const CANARY = "CANARY-prompt-text-and-a-secret-path /home/dev/secret/app.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pheebs-usage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Usage {
  input?: number;
  output?: number;
  read?: number;
  write?: number;
  thinking?: number;
}

function assistant(id: string, req: string, model: string, u: Usage, sidechain = false): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: sidechain,
    requestId: req,
    message: {
      id,
      model,
      content: [{ type: "text", text: CANARY }],
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
        ...(u.thinking === undefined
          ? {}
          : { output_tokens_details: { thinking_tokens: u.thinking } }),
      },
    },
  });
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("readClaudeUsage", () => {
  it("counts a streamed response once, at its final value", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(
        assistant("m1", "r1", "claude-opus-5-5", { input: 10, output: 5, read: 100 }),
        assistant("m1", "r1", "claude-opus-5-5", { input: 10, output: 40, read: 100 }),
        assistant("m1", "r1", "claude-opus-5-5", { input: 10, output: 90, read: 100 }),
        assistant("m2", "r2", "claude-opus-5-5", { input: 3, output: 7, write: 20 }),
      ),
    );
    const { rows } = await readClaudeUsage(path);
    expect(rows).toEqual([
      {
        model: "claude-opus-5-5",
        from_subagent: false,
        input_tokens: 13,
        output_tokens: 97,
        cache_read_tokens: 100,
        cache_write_tokens: 20,
      },
    ]);
  });

  it("splits by model and by subagent scope, reading agent files below the parent", async () => {
    const parent = write(
      join(dir, "s.jsonl"),
      lines(
        assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 2 }),
        assistant("m2", "r2", "<synthetic>", {}),
      ),
    );
    write(
      join(dir, "s", "subagents", "agent-a.jsonl"),
      lines(assistant("m3", "r3", "claude-haiku-5-5", { input: 5, output: 6 }, true)),
    );
    write(
      join(dir, "s", "subagents", "workflows", "wf1", "agent-b.jsonl"),
      lines(assistant("m4", "r4", "claude-opus-5-5", { input: 7, output: 8 }, true)),
    );
    const { rows } = await readClaudeUsage(parent);
    const key = (r: { model: string; from_subagent: boolean }) => `${r.model}|${r.from_subagent}`;
    expect(rows.map(key).sort()).toEqual([
      "claude-haiku-5-5|true",
      "claude-opus-5-5|false",
      "claude-opus-5-5|true",
    ]);
    const sub = rows.find((r) => r.from_subagent && r.model === "claude-opus-5-5");
    expect(sub).toMatchObject({ input_tokens: 7, output_tokens: 8 });
  });

  it("reports reasoning tokens only when a line carried them", async () => {
    const withThinking = write(
      join(dir, "a.jsonl"),
      lines(assistant("m1", "r1", "claude-opus-5-5", { output: 50, thinking: 30 })),
    );
    const without = write(
      join(dir, "b.jsonl"),
      lines(assistant("m1", "r1", "claude-opus-5-5", { output: 50 })),
    );
    expect((await readClaudeUsage(withThinking)).rows[0].reasoning_tokens).toBe(30);
    expect("reasoning_tokens" in (await readClaudeUsage(without)).rows[0]).toBe(false);
  });

  it("skips a malformed line and holds a half-written last line for the next read", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      `${lines(assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 1 }), "{not json")}${assistant("m2", "r2", "claude-opus-5-5", { input: 10, output: 10 }).slice(0, 40)}`,
    );
    const first = await readClaudeUsage(path);
    expect(first.rows).toMatchObject([{ input_tokens: 1, output_tokens: 1 }]);
    appendFileSync(
      path,
      `${assistant("m2", "r2", "claude-opus-5-5", { input: 10, output: 10 }).slice(40)}\n`,
    );
    const second = await readClaudeUsage(path, first.cursors);
    expect(second.rows).toMatchObject([{ input_tokens: 10, output_tokens: 10 }]);
  });

  it("returns only what was added since the cursors, so a resumed session never double counts", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(assistant("m1", "r1", "claude-opus-5-5", { input: 4, output: 4 })),
    );
    const first = await readClaudeUsage(path);
    expect((await readClaudeUsage(path, first.cursors)).rows).toEqual([]);
    appendFileSync(path, lines(assistant("m2", "r2", "claude-opus-5-5", { input: 6, output: 6 })));
    const resumed = await readClaudeUsage(path, first.cursors);
    expect(resumed.rows).toMatchObject([{ input_tokens: 6, output_tokens: 6 }]);
    expect(resumed.ranges[""][0]).toBe(first.ranges[""][1]);
  });

  it("carries integers and the model, never content", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 1 })),
    );
    const read = await readClaudeUsage(path);
    const text = JSON.stringify(read);
    expect(text).not.toContain("CANARY");
    expect(text).not.toContain("secret");
    expect(text).not.toContain(dir);
  });

  it("reads a missing file as nothing, without throwing", async () => {
    expect((await readClaudeUsage(join(dir, "gone.jsonl"))).rows).toEqual([]);
  });

  it("takes the largest value of a repeated response, not the last", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(
        assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 90 }),
        assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 40 }),
      ),
    );
    expect((await readClaudeUsage(path)).rows).toMatchObject([{ output_tokens: 90 }]);
  });

  it("skips a line that names usage but is not JSON", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines('{"usage": broken', assistant("m1", "r1", "claude-opus-5-5", { input: 2, output: 3 })),
    );
    expect((await readClaudeUsage(path)).rows).toMatchObject([
      { input_tokens: 2, output_tokens: 3 },
    ]);
  });

  it("drops a usage line past the size bound instead of reading it", async () => {
    const huge = JSON.parse(assistant("big", "r", "claude-opus-5-5", { input: 999, output: 999 }));
    huge.message.content[0].text = "x".repeat(40 * 1024 * 1024);
    const path = write(
      join(dir, "s.jsonl"),
      lines(
        JSON.stringify(huge),
        assistant("m1", "r1", "claude-opus-5-5", { input: 1, output: 1 }),
      ),
    );
    expect((await readClaudeUsage(path)).rows).toMatchObject([
      { input_tokens: 1, output_tokens: 1 },
    ]);
  });

  it("streams a very large file and skips a line past the size bound", async () => {
    const path = join(dir, "big.jsonl");
    const one = `${assistant("m", "r", "claude-opus-5-5", { input: 1, output: 1 })}\n`;
    writeFileSync(path, "");
    for (let i = 0; i < 100; i++) {
      const block = Array.from({ length: 1000 }, (_, j) =>
        assistant(`m${i}_${j}`, `r${i}_${j}`, "claude-opus-5-5", { input: 1, output: 1 }),
      ).join("\n");
      appendFileSync(path, `${block}\n`);
    }
    appendFileSync(path, `${"x".repeat(40 * 1024 * 1024)}\n`);
    appendFileSync(path, one);
    const { rows } = await readClaudeUsage(path);
    expect(rows).toMatchObject([{ input_tokens: 100_001, output_tokens: 100_001 }]);
  });
});

function codexLines(...entries: unknown[]): string {
  return lines(...entries.map((e) => JSON.stringify(e)));
}
const turn = (model: string) => ({ type: "turn_context", payload: { model } });
const total = (input: number, cached: number, output: number, reasoning: number) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

describe("readCodexUsage", () => {
  it("turns cumulative totals into per-model deltas, input net of cache", async () => {
    const path = write(
      join(dir, "r.jsonl"),
      codexLines(
        { type: "session_meta", payload: { id: "s" } },
        turn("gpt-5.5"),
        total(100, 60, 20, 5),
        total(150, 90, 30, 8),
        turn("gpt-5.5-mini"),
        total(200, 100, 50, 10),
      ),
    );
    const { rows } = await readCodexUsage(path);
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(byModel["gpt-5.5"]).toEqual({
      model: "gpt-5.5",
      from_subagent: false,
      input_tokens: 60,
      cache_read_tokens: 90,
      output_tokens: 30,
      reasoning_tokens: 8,
    });
    expect(byModel["gpt-5.5-mini"]).toMatchObject({
      input_tokens: 40,
      cache_read_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 2,
    });
    expect("cache_write_tokens" in byModel["gpt-5.5"]).toBe(false);
  });

  it("continues from the stored totals on a later read", async () => {
    const path = write(join(dir, "r.jsonl"), codexLines(turn("gpt-5.5"), total(100, 0, 20, 0)));
    const first = await readCodexUsage(path);
    appendFileSync(path, codexLines(total(130, 0, 25, 0)));
    const next = await readCodexUsage(path, first.cursors);
    expect(next.rows).toMatchObject([{ model: "gpt-5.5", input_tokens: 30, output_tokens: 5 }]);
  });

  it("reports nothing for a run whose totals are null, and for a forked rollout", async () => {
    const nulls = write(
      join(dir, "n.jsonl"),
      codexLines(turn("gpt-5.5"), {
        type: "event_msg",
        payload: { type: "token_count", info: null },
      }),
    );
    const fork = write(
      join(dir, "f.jsonl"),
      codexLines(
        { type: "session_meta", payload: { id: "s", forked_from_id: "p" } },
        turn("gpt-5.5"),
        total(900, 0, 90, 0),
      ),
    );
    expect((await readCodexUsage(nulls)).rows).toEqual([]);
    expect((await readCodexUsage(fork)).rows).toEqual([]);
  });

  it("never lets a decreasing total produce a negative count", async () => {
    const path = write(
      join(dir, "r.jsonl"),
      codexLines(turn("gpt-5.5"), total(100, 0, 20, 0), total(50, 0, 10, 0)),
    );
    for (const row of (await readCodexUsage(path)).rows) {
      expect(row.input_tokens).toBeGreaterThanOrEqual(0);
      expect(row.output_tokens).toBeGreaterThanOrEqual(0);
    }
  });
  it("counts nothing from a total that went down, then continues from it", async () => {
    const path = write(
      join(dir, "r.jsonl"),
      codexLines(turn("gpt-5.5"), total(100, 0, 20, 0), total(50, 0, 10, 0), total(70, 0, 15, 0)),
    );
    expect((await readCodexUsage(path)).rows).toMatchObject([
      { input_tokens: 120, output_tokens: 25 },
    ]);
  });

  it("leaves cache and reasoning off a row whose totals do not report them", async () => {
    const bare = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } },
      },
    };
    const path = write(join(dir, "r.jsonl"), codexLines(turn("gpt-5.5"), bare));
    const [row] = (await readCodexUsage(path)).rows;
    expect(row).toEqual({
      model: "gpt-5.5",
      from_subagent: false,
      input_tokens: 10,
      output_tokens: 2,
    });
  });
});
