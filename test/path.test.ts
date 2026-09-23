import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSettingsPath } from "../src/commands/path.js";
import { AI_TOOLS } from "../src/hooks/definitions.js";

describe("resolveSettingsPath", () => {
  it("resolves user-level paths under the home directory", () => {
    expect(resolveSettingsPath(AI_TOOLS.CLAUDE_CODE, false)).toEqual({
      path: join(homedir(), ".claude", "settings.json"),
      level: "user-level",
    });
    expect(resolveSettingsPath(AI_TOOLS.CURSOR, false)).toEqual({
      path: join(homedir(), ".cursor", "hooks.json"),
      level: "user-level",
    });
    expect(resolveSettingsPath(AI_TOOLS.CODEX, false)).toEqual({
      path: join(homedir(), ".codex", "config.toml"),
      level: "user-level",
    });
  });

  it("resolves project-level paths under the cwd", () => {
    expect(resolveSettingsPath(AI_TOOLS.CLAUDE_CODE, true)).toEqual({
      path: join(process.cwd(), ".claude", "settings.local.json"),
      level: "project-level",
    });
    expect(resolveSettingsPath(AI_TOOLS.CURSOR, true)).toEqual({
      path: join(process.cwd(), ".cursor", "hooks.json"),
      level: "project-level",
    });
    expect(resolveSettingsPath(AI_TOOLS.CODEX, true)).toEqual({
      path: join(process.cwd(), ".codex", "config.toml"),
      level: "project-level",
    });
  });
});
