import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSettingsPath, scopesCollide } from "../src/commands/path.js";
import { AI_TOOLS } from "../src/hooks/definitions.js";
import { onPlatform } from "./platform.js";

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

describe("scopesCollide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a cwd that differs from home only in case as home on Windows", () => {
    // An editor terminal reports the drive as `c:` where homedir() says `C:`.
    vi.spyOn(process, "cwd").mockReturnValue(homedir().toUpperCase());
    expect(onPlatform("win32", () => scopesCollide(AI_TOOLS.CODEX))).toBe(true);
    expect(onPlatform("linux", () => scopesCollide(AI_TOOLS.CODEX))).toBe(false);
  });
});
