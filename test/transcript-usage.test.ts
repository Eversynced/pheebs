import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeUsage } from "../src/transcript-usage.js";

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

  it("drops usage whose model is not shaped like a model id", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(
        assistant("m1", "r1", "text that is not a model id", { input: 5, output: 5 }),
        assistant("m2", "r2", "claude-opus-5-5", { input: 1, output: 1 }),
      ),
    );
    expect((await readClaudeUsage(path)).rows).toMatchObject([{ model: "claude-opus-5-5" }]);
  });

  it("drops a line whose counts are not whole non-negative integers, and keeps a hostile model name inert", async () => {
    const path = write(
      join(dir, "s.jsonl"),
      lines(
        assistant("m1", "r1", "__proto__", { input: 5, output: 5 }),
        assistant("m2", "r2", "claude-opus-5-5", { input: 1.5, output: 2 }),
        assistant("m3", "r3", "claude-opus-5-5", { input: Number.MAX_VALUE, output: 3 }),
        assistant("m4", "r4", "claude-opus-5-5", { input: -4, output: 4 }),
        assistant("m5", "r5", "x".repeat(101), { input: 9, output: 9 }),
      ),
    );
    const { rows } = await readClaudeUsage(path);
    expect(rows).toMatchObject([{ model: "__proto__", input_tokens: 5, output_tokens: 5 }]);
    expect(rows).toHaveLength(1);
    expect(({} as Record<string, unknown>).input_tokens).toBeUndefined();
  });

  it("skips the lines of a background session's file, so a copied history is not counted twice", async () => {
    const mark = (line: string, extra: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(line), ...extra });
    const original = assistant("m1", "r1", "claude-opus-5-5", { input: 10, output: 20 });
    const parent = write(join(dir, "parent.jsonl"), lines(original));
    const background = write(
      join(dir, "background.jsonl"),
      lines(
        mark(original, { sessionKind: "bg", requestSessionId: "parent" }),
        mark(assistant("m2", "r2", "claude-opus-5-5", { input: 3, output: 4 }), {
          sessionKind: "bg",
        }),
        mark(assistant("m3", "r3", "claude-opus-5-5", { input: 5, output: 6 }), {
          requestSessionId: "parent",
        }),
      ),
    );
    expect((await readClaudeUsage(parent)).rows).toMatchObject([
      { input_tokens: 10, output_tokens: 20 },
    ]);
    expect((await readClaudeUsage(background)).rows).toEqual([]);
  });

  it("counts a line that carries neither marker, even beside marked ones", async () => {
    const own = assistant("m9", "r9", "claude-opus-5-5", { input: 7, output: 8 });
    const path = write(
      join(dir, "mixed.jsonl"),
      lines(
        JSON.stringify({
          ...JSON.parse(assistant("m8", "r8", "claude-opus-5-5", { input: 1, output: 1 })),
          sessionKind: "bg",
        }),
        own,
      ),
    );
    expect((await readClaudeUsage(path)).rows).toMatchObject([
      { input_tokens: 7, output_tokens: 8 },
    ]);
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
