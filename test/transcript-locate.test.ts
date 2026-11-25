import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateTranscript } from "../src/transcript-locate.js";
import type { SessionRecord } from "../src/usage-types.js";

const ID = "0192a8f0-4c1e-7d3a-9b2f-6e5d4c3b2a10";
const AT = new Date(2026, 10, 19, 12).getTime();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pheebs-locate-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tool: "claude_code",
    session_id: ID,
    codebase: "acme/api",
    endpoint: "aaaaaaaaaaaaaaaa",
    ended: true,
    touched_at: AT,
    ...over,
  };
}

function touch(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
}

describe("locateTranscript", () => {
  it("finds a Claude Code transcript under ~/.claude, ~/.claude-* and CLAUDE_CONFIG_DIR", () => {
    const plain = touch(join(home, ".claude", "projects", "p1", `${ID}.jsonl`));
    expect(locateTranscript(record(), { home, env: {} })).toBe(plain);
    rmSync(plain);
    const work = touch(join(home, ".claude-work", "projects", "p2", `${ID}.jsonl`));
    expect(locateTranscript(record(), { home, env: {} })).toBe(work);
    rmSync(work);
    const custom = touch(join(home, "elsewhere", "projects", "p3", `${ID}.jsonl`));
    expect(
      locateTranscript(record(), { home, env: { CLAUDE_CONFIG_DIR: join(home, "elsewhere") } }),
    ).toBe(custom);
  });

  it("does not find a config directory outside those locations", () => {
    touch(join(home, "custom-dir", "projects", "p", `${ID}.jsonl`));
    expect(locateTranscript(record(), { home, env: {} })).toBeUndefined();
  });

  it("refuses a session id that is not id-shaped", () => {
    touch(join(home, ".claude", "projects", "p", "x.jsonl"));
    expect(locateTranscript(record({ session_id: "../p/x" }), { home, env: {} })).toBeUndefined();
    expect(locateTranscript(record({ session_id: "a/b" }), { home, env: {} })).toBeUndefined();
  });

  it("returns undefined when nothing exists", () => {
    expect(locateTranscript(record(), { home, env: {} })).toBeUndefined();
  });
});
