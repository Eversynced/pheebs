import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/developer-id.js", () => ({
  getDeveloperHandle: () => "dev-test",
}));

const { applyInit } = await import("../src/commands/init.js");
const { isPheebsEntry } = await import("../src/hooks/definitions.js");

type HookEntry = Record<string, unknown>;

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "pheebs-init-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmp, relPath), "utf-8"));
}

describe("applyInit — Cursor", () => {
  const HOOKS_PATH = ".cursor/hooks.json";

  it("writes a fresh config with pheebs hooks", () => {
    const result = applyInit("cursor", true, false);

    expect(result.level).toBe("project-level");
    const config = readJson(HOOKS_PATH);
    expect(config.version).toBe(1);

    const hooks = config.hooks as Record<string, HookEntry[]>;
    expect(hooks.sessionStart).toHaveLength(1);
    expect(hooks.sessionStart[0].command).toContain("pheebs hook-cursor session_started");
  });

  it("preserves foreign hooks and replaces stale pheebs entries", () => {
    mkdirSync(join(tmp, ".cursor"), { recursive: true });
    writeFileSync(
      join(tmp, HOOKS_PATH),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            { command: "my-custom-hook" },
            { command: "pheebs hook-cursor session_started --stale" },
          ],
        },
      }),
    );

    applyInit("cursor", true, false);

    const hooks = readJson(HOOKS_PATH).hooks as Record<string, HookEntry[]>;
    const sessionStart = hooks.sessionStart;
    expect(sessionStart.some((e) => e.command === "my-custom-hook")).toBe(true);
    expect(sessionStart.filter(isPheebsEntry)).toHaveLength(1);
    // the stale entry (with --stale) must be gone, replaced by the fresh one
    expect(sessionStart.some((e) => String(e.command).includes("--stale"))).toBe(false);
  });
});

describe("applyInit — Claude Code", () => {
  const SETTINGS_PATH = ".claude/settings.local.json";

  it("merges pheebs hooks into Claude settings", () => {
    applyInit("claude_code", true, false);

    const hooks = readJson(SETTINGS_PATH).hooks as Record<string, HookEntry[]>;
    expect(hooks.SessionStart.some(isPheebsEntry)).toBe(true);
    expect(hooks.PreCompact).toHaveLength(2);
  });

  it("keeps unrelated settings untouched", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, SETTINGS_PATH), JSON.stringify({ model: "opus", hooks: {} }));

    applyInit("claude_code", true, false);

    expect(readJson(SETTINGS_PATH).model).toBe("opus");
  });
});
