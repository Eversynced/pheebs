import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeFromJsonConfig, removeFromTomlConfig } from "../src/commands/uninstall.js";
import { AI_TOOLS, buildHooksConfig } from "../src/hooks/definitions.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pheebs-uninstall-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("removeFromJsonConfig", () => {
  it("removes pheebs hooks and OTel env but keeps foreign entries", () => {
    const path = join(tmp, "settings.json");
    const hooks = buildHooksConfig(AI_TOOLS.CLAUDE_CODE) as Record<string, unknown[]>;
    hooks.SessionStart.unshift({ hooks: [{ command: "foreign-tool" }] });
    writeFileSync(
      path,
      JSON.stringify({
        hooks,
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", MY_VAR: "keep" },
      }),
    );

    removeFromJsonConfig(path, AI_TOOLS.CLAUDE_CODE);

    const result = JSON.parse(readFileSync(path, "utf-8"));
    expect(result.hooks.SessionStart).toHaveLength(1);
    expect(result.hooks.PreCompact).toBeUndefined(); // pheebs-only key dropped
    expect(result.env).toEqual({ MY_VAR: "keep" });
  });

  it("drops the hooks block when only pheebs entries existed", () => {
    const path = join(tmp, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: buildHooksConfig(AI_TOOLS.CLAUDE_CODE) }));

    removeFromJsonConfig(path, AI_TOOLS.CLAUDE_CODE);

    expect(JSON.parse(readFileSync(path, "utf-8")).hooks).toBeUndefined();
  });

  it("is a no-op for missing or malformed files", () => {
    const missing = join(tmp, "missing.json");
    expect(() => removeFromJsonConfig(missing, AI_TOOLS.CLAUDE_CODE)).not.toThrow();
    expect(existsSync(missing)).toBe(false);

    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => removeFromJsonConfig(bad, AI_TOOLS.CLAUDE_CODE)).not.toThrow();
  });
});

describe("removeFromTomlConfig", () => {
  it("removes pheebs hooks from a Codex config", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, stringifyToml({ hooks: buildHooksConfig(AI_TOOLS.CODEX) }));

    removeFromTomlConfig(path);

    const result = parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(result.hooks).toBeUndefined();
  });
});
