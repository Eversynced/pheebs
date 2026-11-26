import { describe, expect, it } from "vitest";
import {
  AI_TOOLS,
  ALL_DEFINITIONS,
  buildHooksConfig,
  EVENTS,
  getHookDefinitionsForTool,
  isPheebsEntry,
} from "../src/hooks/definitions.js";

const EVENT_VALUES = new Set(Object.values(EVENTS));

describe("hook definitions", () => {
  it("registers Claude Code only", () => {
    expect(ALL_DEFINITIONS).toHaveLength(15);
    expect(Object.values(AI_TOOLS)).toEqual(["claude_code"]);
    expect(ALL_DEFINITIONS.every((d) => d.tool === AI_TOOLS.CLAUDE_CODE)).toBe(true);
  });

  it("only emits known event names", () => {
    for (const def of ALL_DEFINITIONS) {
      expect(EVENT_VALUES.has(def.eventName)).toBe(true);
    }
  });

  it("registers Claude PostModelSwitch async, and never its Pre counterpart", () => {
    const claudeKeys = getHookDefinitionsForTool(AI_TOOLS.CLAUDE_CODE).map((d) => d.hookKey);
    expect(claudeKeys).toContain("PostModelSwitch");
    expect(claudeKeys).not.toContain("PreModelSwitch");

    const entries = buildHooksConfig().PostModelSwitch;
    expect(entries).toEqual([
      { hooks: [{ type: "command", command: "pheebs hook model_switched", async: true }] },
    ]);
  });

  it("registers Claude PreCompact twice with auto/manual triggers", () => {
    const preCompact = getHookDefinitionsForTool(AI_TOOLS.CLAUDE_CODE).filter(
      (d) => d.hookKey === "PreCompact",
    );
    expect(preCompact).toHaveLength(2);
    expect(preCompact.map((d) => d.matcher).sort()).toEqual(["auto", "manual"]);
    expect(preCompact.every((d) => d.cliArgs?.startsWith("--trigger-type"))).toBe(true);
  });
});

describe("isPheebsEntry", () => {
  it("recognizes the flat format an old Cursor install wrote", () => {
    expect(isPheebsEntry({ command: "pheebs hook-cursor session_started" })).toBe(true);
  });

  it("recognizes the nested format, including an old Codex install's", () => {
    expect(
      isPheebsEntry({ hooks: [{ type: "command", command: "pheebs hook session_started" }] }),
    ).toBe(true);
    expect(
      isPheebsEntry({ hooks: [{ type: "command", command: "pheebs hook-codex tool_invoked" }] }),
    ).toBe(true);
  });

  it("rejects non-pheebs entries in both formats", () => {
    expect(isPheebsEntry({ command: "echo hello" })).toBe(false);
    expect(isPheebsEntry({ hooks: [{ command: "some-other-tool run" }] })).toBe(false);
  });

  it("rejects malformed values without throwing", () => {
    expect(isPheebsEntry(null)).toBe(false);
    expect(isPheebsEntry(undefined)).toBe(false);
    expect(isPheebsEntry("pheebs hook")).toBe(false);
    expect(isPheebsEntry({})).toBe(false);
  });
});

describe("buildHooksConfig", () => {
  it("defaults to the Claude Code shape", () => {
    const claude = buildHooksConfig();
    const [sessionStart] = claude.SessionStart as Array<Record<string, unknown>>;
    const hook = (sessionStart.hooks as Array<Record<string, unknown>>)[0];
    expect(hook).toMatchObject({ type: "command", async: true });
    expect(hook.command).toContain("pheebs hook session_started");
  });

  it("carries PreCompact matchers and cliArgs into the command", () => {
    const claude = buildHooksConfig();
    const preCompact = claude.PreCompact as Array<Record<string, unknown>>;
    expect(preCompact).toHaveLength(2);
    const commands = preCompact.map(
      (e) => (e.hooks as Array<Record<string, unknown>>)[0].command as string,
    );
    expect(commands.some((c) => c.includes("--trigger-type auto"))).toBe(true);
    expect(commands.some((c) => c.includes("--trigger-type manual"))).toBe(true);
    expect(preCompact.map((e) => e.matcher).sort()).toEqual(["auto", "manual"]);
  });

  it("emits an entry for every definition of the tool", () => {
    const total = Object.values(buildHooksConfig()).reduce((n, entries) => n + entries.length, 0);
    expect(total).toBe(ALL_DEFINITIONS.length);
  });
});
