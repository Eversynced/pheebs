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

describe("applyInit — Claude Code", () => {
  const SETTINGS_PATH = ".claude/settings.local.json";

  it("merges pheebs hooks into Claude settings", () => {
    applyInit(true, false);

    const hooks = readJson(SETTINGS_PATH).hooks as Record<string, HookEntry[]>;
    expect(hooks.SessionStart.some(isPheebsEntry)).toBe(true);
    expect(hooks.PreCompact).toHaveLength(2);
  });

  it("keeps unrelated settings untouched", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, SETTINGS_PATH), JSON.stringify({ model: "opus", hooks: {} }));

    applyInit(true, false);

    expect(readJson(SETTINGS_PATH).model).toBe("opus");
  });
});
