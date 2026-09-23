import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorCodex, doctorJsonConfig } from "../src/commands/doctor.js";
import { AI_TOOLS, buildHooksConfig } from "../src/hooks/definitions.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pheebs-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, data: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("doctorJsonConfig", () => {
  it("reports healthy when all hooks are registered", () => {
    const path = writeJson("settings.json", { hooks: buildHooksConfig(AI_TOOLS.CLAUDE_CODE) });
    const result = doctorJsonConfig(path, AI_TOOLS.CLAUDE_CODE);
    expect(result.fatal).toBeUndefined();
    expect(result.issues).toEqual([]);
  });

  it("flags a missing settings file as fatal", () => {
    const result = doctorJsonConfig(join(tmp, "missing.json"), AI_TOOLS.CLAUDE_CODE);
    expect(result.fatal).toContain("not found");
  });

  it("flags malformed JSON as fatal", () => {
    const path = join(tmp, "settings.json");
    writeFileSync(path, "{ not valid json");
    const result = doctorJsonConfig(path, AI_TOOLS.CLAUDE_CODE);
    expect(result.fatal).toContain("malformed");
  });

  it("reports a missing hook key", () => {
    const path = writeJson("settings.json", { hooks: {} });
    const result = doctorJsonConfig(path, AI_TOOLS.CLAUDE_CODE);
    expect(result.issues).toContain("SessionStart: missing entirely");
  });

  it("reports a hook key with no pheebs entries", () => {
    const path = writeJson("settings.json", {
      hooks: { SessionStart: [{ hooks: [{ command: "other-tool" }] }] },
    });
    const result = doctorJsonConfig(path, AI_TOOLS.CLAUDE_CODE);
    expect(result.issues).toContain("SessionStart: no pheebs entries found");
  });

  it("reports a partial count for multi-entry hook keys", () => {
    const full = buildHooksConfig(AI_TOOLS.CLAUDE_CODE);
    full.PreCompact = [full.PreCompact[0]]; // drop one of the two expected PreCompact entries
    const path = writeJson("settings.json", { hooks: full });
    const result = doctorJsonConfig(path, AI_TOOLS.CLAUDE_CODE);
    expect(result.issues).toContain("PreCompact: found 1/2 pheebs entries");
  });
});

describe("doctorCodex", () => {
  it("reports healthy when all hooks are registered", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, stringifyToml({ hooks: buildHooksConfig(AI_TOOLS.CODEX) }));
    const result = doctorCodex(path);
    expect(result.fatal).toBeUndefined();
    expect(result.issues).toEqual([]);
  });

  it("flags a missing config file as fatal", () => {
    const result = doctorCodex(join(tmp, "missing.toml"));
    expect(result.fatal).toContain("not found");
  });

  it("reports a missing hook key", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, stringifyToml({ hooks: {} }));
    const result = doctorCodex(path);
    expect(result.issues).toContain("SessionStart: missing entirely");
  });
});
