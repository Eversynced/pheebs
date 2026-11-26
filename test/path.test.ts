import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSettingsPath } from "../src/commands/path.js";

describe("resolveSettingsPath", () => {
  it("resolves the user-level path under the home directory", () => {
    expect(resolveSettingsPath(false)).toEqual({
      path: join(homedir(), ".claude", "settings.json"),
      level: "user-level",
    });
  });

  it("resolves the project-level path under the cwd", () => {
    expect(resolveSettingsPath(true)).toEqual({
      path: join(process.cwd(), ".claude", "settings.local.json"),
      level: "project-level",
    });
  });
});
