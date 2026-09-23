import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bucketFor, collectArtifacts } from "../src/scanner.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe("bucketFor", () => {
  it("buckets by age relative to now", () => {
    expect(bucketFor(NOW - 0.5 * DAY, NOW)).toBe("today");
    expect(bucketFor(NOW - 3 * DAY, NOW)).toBe("this_week");
    expect(bucketFor(NOW - 15 * DAY, NOW)).toBe("this_month");
    expect(bucketFor(NOW - 60 * DAY, NOW)).toBe("this_quarter");
    expect(bucketFor(NOW - 200 * DAY, NOW)).toBe("older");
  });
});

describe("collectArtifacts", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pheebs-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function touch(relPath: string): void {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
  }

  function write(relPath: string, contents: unknown): void {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, JSON.stringify(contents));
  }

  const pheebsHook = { hooks: [{ type: "command", command: "pheebs hook session_started" }] };

  function typesFound(): Record<string, number> {
    return Object.fromEntries(
      collectArtifacts(root).map((a) => [a.artifact_type, a.mtimes.length]),
    );
  }

  it("returns nothing for an empty repo", () => {
    expect(collectArtifacts(root)).toEqual([]);
  });

  it("detects each artifact type with its file count", () => {
    touch(".claude/agents/reviewer.md");
    touch(".claude/agents/nested/planner.md");
    mkdirSync(join(root, ".claude/skills/my-skill"), { recursive: true });
    mkdirSync(join(root, ".agents/skills/codex-skill"), { recursive: true });
    touch(".cursor/commands/deploy.md");
    touch(".mcp.json");

    const found = typesFound();
    expect(found).toEqual({
      claude_agents: 2,
      claude_skills: 1,
      codex_skills: 1,
      cursor_commands: 1,
      mcp_config: 1,
    });
  });

  it("counts MCP configs across all known locations", () => {
    touch(".mcp.json");
    touch(".cursor/mcp.json");
    touch(".vscode/mcp.json");

    const mcp = collectArtifacts(root).find((a) => a.artifact_type === "mcp_config");
    expect(mcp?.mtimes).toHaveLength(3);
  });

  it("detects an eval set directory by its hallmark children", () => {
    touch("evals/rubric.md");
    touch("evals/cases/happy.md");

    expect(typesFound().eval_harness).toBe(1);
  });

  it("detects eval configs and *.eval.* files by name", () => {
    touch("promptfooconfig.yaml");
    touch("src/login.eval.ts");

    expect(typesFound().eval_harness).toBe(2);
  });

  it("detects an eval-named skill and its co-located eval set", () => {
    touch(".claude/skills/demo-eval/SKILL.md");
    touch(".claude/skills/demo-eval/evals/rubric.md");
    touch(".claude/skills/demo-eval/evals/cases/happy.md");

    const found = typesFound();
    // the skill dir (name match) + its co-located evals/ set
    expect(found.eval_harness).toBe(2);
    expect(found.claude_skills).toBe(1);
  });

  it("ignores an evals dir without hallmark children and unrelated skill names", () => {
    touch("evals/notes.md"); // no rubric.md / cases/ → not an eval set
    touch(".claude/skills/retrieval-helper/SKILL.md"); // 'eval' substring, not a token

    const found = typesFound();
    expect(found.eval_harness).toBeUndefined();
    expect(found.claude_skills).toBe(1);
  });
  it("detects context files at each known location", () => {
    touch("CLAUDE.md");
    touch("AGENTS.md");
    touch(".cursorrules");
    touch(".github/copilot-instructions.md");
    touch(".cursor/rules/style.mdc");

    const context = collectArtifacts(root).find((a) => a.artifact_type === "context_file");
    expect(context?.mtimes).toHaveLength(5);
  });

  it("reports no context file when the repo carries none", () => {
    touch(".mcp.json");

    expect(typesFound()).not.toHaveProperty("context_file");
  });

  it("detects hooks a human configured, in both the Claude and Cursor shapes", () => {
    write(".claude/settings.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./bin/notify" }] }] },
    });
    write(".cursor/hooks.json", {
      version: 1,
      hooks: { beforeShellExecution: [{ command: "./bin/audit" }] },
    });

    const hooks = collectArtifacts(root).find((a) => a.artifact_type === "hook_config");
    expect(hooks?.mtimes).toHaveLength(2);
  });

  it("does not report hook_config for a repo carrying only pheebs-installed hooks", () => {
    write(".claude/settings.json", {
      hooks: { SessionStart: [pheebsHook], SessionEnd: [pheebsHook] },
    });
    write(".cursor/hooks.json", {
      version: 1,
      hooks: { beforeShellExecution: [{ command: "pheebs hook-cursor tool_use_started" }] },
    });

    expect(typesFound()).not.toHaveProperty("hook_config");
  });

  it("reports hook_config when a human hook sits alongside the pheebs ones", () => {
    write(".claude/settings.json", {
      hooks: {
        SessionStart: [pheebsHook],
        PreToolUse: [{ hooks: [{ type: "command", command: "./bin/guard" }] }],
      },
    });

    const hooks = collectArtifacts(root).find((a) => a.artifact_type === "hook_config");
    expect(hooks?.mtimes).toHaveLength(1);
  });

  it("detects a plugin switched on", () => {
    write(".claude/settings.json", { enabledPlugins: { "some-plugin@marketplace": true } });

    const plugins = collectArtifacts(root).find((a) => a.artifact_type === "plugin_enabled");
    expect(plugins?.mtimes).toHaveLength(1);
  });

  it("ignores a plugin switched off", () => {
    write(".claude/settings.json", { enabledPlugins: { "some-plugin@marketplace": false } });

    expect(typesFound()).not.toHaveProperty("plugin_enabled");
  });

  it.each([
    ["false"],
    [0],
    [{ enabled: true }],
    [[]],
  ])("ignores a plugin whose enablement value is %o rather than true", (value) => {
    write(".claude/settings.json", { enabledPlugins: { "some-plugin@marketplace": value } });

    expect(typesFound()).not.toHaveProperty("plugin_enabled");
  });

  it("reads hooks and plugins from settings.local.json too", () => {
    write(".claude/settings.local.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./bin/notify" }] }] },
      enabledPlugins: { "some-plugin@marketplace": true },
    });

    expect(typesFound()).toMatchObject({ hook_config: 1, plugin_enabled: 1 });
  });

  it("detects a human hook in the Codex TOML config", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "./bin/audit"\n',
    );

    const hooks = collectArtifacts(root).find((a) => a.artifact_type === "hook_config");
    expect(hooks?.mtimes).toHaveLength(1);
  });

  it("does not report hook_config for a Codex config carrying only pheebs hooks", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "pheebs hook-codex session_started"\n',
    );

    expect(typesFound()).not.toHaveProperty("hook_config");
  });

  it.each([
    ["an empty entry", { SessionStart: [{}] }],
    ["a matcher block with no hooks", { PreToolUse: [{ matcher: "Bash", hooks: [] }] }],
    ["an array where an entry belongs", { PreToolUse: [[]] }],
    ["a bare string entry", { PreToolUse: ["./bin/x"] }],
    ["a hooks map with no keys", {}],
    ["a hook key with no entries", { PreToolUse: [] }],
    ["a blank nested command", { PreToolUse: [{ hooks: [{ type: "command", command: "  " }] }] }],
    ["a blank flat command", { PreToolUse: [{ command: "  " }] }],
  ])("does not report hook_config for %s", (_label, hooks) => {
    write(".claude/settings.json", { hooks });

    expect(typesFound()).not.toHaveProperty("hook_config");
  });

  it("ignores a settings file that is empty or malformed", () => {
    write(".claude/settings.local.json", {});
    writeFileSync(join(root, ".claude", "settings.json"), "{ not json");

    const found = typesFound();
    expect(found).not.toHaveProperty("hook_config");
    expect(found).not.toHaveProperty("plugin_enabled");
  });
});
