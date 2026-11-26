import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";

// Claude Code is the only supported agent. An install made when Cursor and Codex were supported
// still calls `pheebs hook-cursor` / `hook-codex`, so those must stay harmless until
// `pheebs uninstall` removes them.

const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) =>
    join(e.parentPath, e.name),
  );
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    input,
    timeout: 20_000,
  });
}

describe("legacy hook commands", () => {
  for (const command of ["hook-cursor", "hook-codex"]) {
    it(`${command} exits 0 silently, writes nothing and sends nothing, without reading stdin`, async () => {
      const home = tempDir("pheebs-home-");
      const logs = tempDir("pheebs-logs-");
      const before = listFiles(home);
      // stdin stays open and is never written: a command that waits for it would hang.
      const child = spawn(process.execPath, [cliPath, command, "SessionStart"], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PHEEBS_LOG_PATH: logs,
          PHEEBS_CODEBASE_ID: "test/legacy",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(null);
        }, 5000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(listFiles(home)).toEqual(before);
      expect(listFiles(logs)).toEqual([]);
    });
  }
});

describe("removed tool flags", () => {
  const cases = [
    ["init", "--cursor"],
    ["init", "--codex"],
    ["doctor", "--cursor"],
    ["doctor", "--codex"],
    ["scan", "--cursor"],
    ["scan", "--codex"],
  ];
  for (const args of cases) {
    it(`${args.join(" ")} prints one line pointing at uninstall and exits 1`, () => {
      const home = tempDir("pheebs-home-");
      const cwd = tempDir("pheebs-cwd-");
      const result = runCli(args, { HOME: home, USERPROFILE: home }, cwd);
      expect(result.status).toBe(1);
      const lines = `${result.stdout}${result.stderr}`.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("support was removed");
      expect(lines[0]).toContain("pheebs uninstall");
      expect(listFiles(cwd)).toEqual([]);
      expect(listFiles(home)).toEqual([]);
    });
  }
});

const FOREIGN_CURSOR = { command: "other-tool run", failClosed: false };
const FOREIGN_CODEX = { hooks: [{ type: "command", command: "other-tool codex" }] };

function cursorFixture(): string {
  return JSON.stringify({
    version: 1,
    hooks: {
      sessionStart: [FOREIGN_CURSOR, { command: "pheebs hook-cursor session_started" }],
      stop: [{ command: "pheebs hook-cursor turn_ended", failClosed: false, timeout: 10 }],
    },
  });
}

function codexFixture(): string {
  return [
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    'command = "pheebs hook-codex session_started"',
    "",
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    'command = "other-tool codex"',
    "",
    "[otel]",
    'environment = "production"',
    "[otel.exporter.otlp-http]",
    'endpoint = "https://api.test/otel/v1/logs"',
    'headers = { Authorization = "Bearer pheebs_secret" }',
    "",
    "[model_providers.mine]",
    'name = "keep"',
    "",
  ].join("\n");
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("uninstall of an old Cursor or Codex install", () => {
  it("clears pheebs entries at both scopes and from recorded installs, leaving foreign ones", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const other = tempDir("pheebs-other-");

    write(join(home, ".cursor", "hooks.json"), cursorFixture());
    write(join(home, ".codex", "config.toml"), codexFixture());
    write(join(cwd, ".cursor", "hooks.json"), cursorFixture());
    write(join(cwd, ".codex", "config.toml"), codexFixture());
    const otherCursor = join(other, ".cursor", "hooks.json");
    const otherCodex = join(other, ".codex", "config.toml");
    write(otherCursor, cursorFixture());
    write(otherCodex, codexFixture());
    write(
      join(home, ".pheebs", "installs.json"),
      JSON.stringify([
        { tool: "cursor", path: otherCursor },
        { tool: "codex", path: otherCodex },
      ]),
    );

    const result = runCli(["uninstall"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);

    for (const path of [
      join(home, ".cursor", "hooks.json"),
      join(cwd, ".cursor", "hooks.json"),
      otherCursor,
    ]) {
      const config = JSON.parse(readFileSync(path, "utf-8"));
      expect(config.hooks.sessionStart).toEqual([FOREIGN_CURSOR]);
      expect(config.hooks.stop).toBeUndefined();
    }
    for (const path of [
      join(home, ".codex", "config.toml"),
      join(cwd, ".codex", "config.toml"),
      otherCodex,
    ]) {
      const config = parseToml(readFileSync(path, "utf-8")) as {
        hooks: { SessionStart: unknown[] };
        otel?: unknown;
        model_providers: { mine: { name: string } };
      };
      expect(config.hooks.SessionStart).toEqual([FOREIGN_CODEX]);
      expect(config.otel).toBeUndefined();
      expect(config.model_providers.mine.name).toBe("keep");
    }
    expect(JSON.parse(readFileSync(join(home, ".pheebs", "installs.json"), "utf-8"))).toEqual([]);
  });
});

describe("uninstall leaves what is not pheebs's", () => {
  it("does not rewrite a config with no pheebs entry, and keeps a user's own otel table", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const codex = '# mine\n[otel]\nenvironment = "dev"\n';
    const cursor = '{"hooks":{"stop":[{"command":"other"}]}}';
    write(join(home, ".codex", "config.toml"), codex);
    write(join(home, ".cursor", "hooks.json"), cursor);

    const result = runCli(["uninstall"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe(codex);
    expect(readFileSync(join(home, ".cursor", "hooks.json"), "utf-8")).toBe(cursor);
  });
});

describe("an old Codex install after the token or endpoint changes", () => {
  it("stops exporting with the old token", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const config = join(cwd, "repo", ".codex", "config.toml");
    write(config, codexFixture());
    write(
      join(home, ".pheebs", "installs.json"),
      JSON.stringify([{ tool: "codex", path: config }]),
    );
    write(join(home, ".pheebs", "config.json"), JSON.stringify({ baseUrl: "https://old.example" }));

    const result = runCli(["config", "unset", "base-url"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);
    const after = parseToml(readFileSync(config, "utf-8")) as { otel?: unknown; hooks: unknown };
    expect(after.otel).toBeUndefined();
    expect(after.hooks).toBeDefined();
  });
});

describe("a malformed old Codex config during the token resync", () => {
  it("is skipped without a word, since the resync runs inside a hook", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const bad = join(cwd, "repo", ".codex", "config.toml");
    write(bad, "[[hooks\nnot toml");
    write(join(home, ".pheebs", "installs.json"), JSON.stringify([{ tool: "codex", path: bad }]));
    write(join(home, ".pheebs", "config.json"), JSON.stringify({ baseUrl: "https://old.example" }));

    const result = runCli(["config", "unset", "base-url"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("malformed");
    expect(readFileSync(bad, "utf-8")).toBe("[[hooks\nnot toml");
  });
});

describe("uninstall of a malformed old config", () => {
  it("leaves the file alone and keeps its install record", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const bad = join(cwd, "other", ".codex", "config.toml");
    write(bad, "[[hooks\nnot toml");
    const registry = join(home, ".pheebs", "installs.json");
    write(registry, JSON.stringify([{ tool: "codex", path: bad }]));

    const result = runCli(["uninstall"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);
    expect(readFileSync(bad, "utf-8")).toBe("[[hooks\nnot toml");
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual([{ tool: "codex", path: bad }]);
  });
});

describe("uninstall of a Codex config with unusual shapes", () => {
  it("keeps a non-table analytics value and the file's mode, and says an unreadable path is unreadable", () => {
    const home = tempDir("pheebs-home-");
    const cwd = tempDir("pheebs-cwd-");
    const codex = join(home, ".codex", "config.toml");
    write(
      codex,
      'analytics = true\n[otel]\n[otel.exporter.otlp-http]\nheaders = { Authorization = "Bearer pheebs_x" }\n',
    );
    chmodSync(codex, 0o600);
    mkdirSync(join(cwd, ".codex", "config.toml"), { recursive: true });

    const result = runCli(["uninstall"], { HOME: home, USERPROFILE: home }, cwd);
    expect(result.status).toBe(0);
    const after = parseToml(readFileSync(codex, "utf-8")) as {
      analytics?: unknown;
      otel?: unknown;
    };
    expect(after.otel).toBeUndefined();
    expect(after.analytics).toBe(true);
    expect(statSync(codex).mode & 0o777).toBe(0o600);
    expect(result.stderr).toContain("could not read");
    expect(result.stderr).not.toContain("malformed");
  });
});

describe("a local log from before the removal", () => {
  it("still reports, with Cursor and Codex rows beside Claude Code ones", () => {
    const home = tempDir("pheebs-home-");
    const logs = tempDir("pheebs-logs-");
    mkdirSync(join(home, ".pheebs"), { recursive: true });
    writeFileSync(join(home, ".pheebs", "config.json"), "{}");
    const day = 86_400_000;
    const row = (tool: string, daysAgo: number, event: string, extra = {}) =>
      JSON.stringify({
        timestamp: new Date(Date.now() - daysAgo * day).toISOString(),
        source: "hook",
        event,
        developer: "dev",
        codebase: "acme/app",
        ai_tool: tool,
        session_id: `${tool}-${daysAgo}`,
        version: "1.4.0",
        ...extra,
      });
    const lines = [
      row("claude_code", 3, "session_started"),
      row("cursor", 3, "session_started"),
      row("cursor", 2, "prompt_submitted", { rule_attachment_count: 2 }),
      row("codex", 2, "session_started"),
      row("codex", 1, "tool_use_completed", { tool_intent: "test_run" }),
      row("codex", 1, "compaction_completed"),
    ];
    writeFileSync(join(logs, "acme--app-2026-11-01.jsonl"), `${lines.join("\n")}\n`);

    const result = runCli(
      ["insights", "--local", "--json"],
      { HOME: home, USERPROFILE: home, PHEEBS_LOG_PATH: logs },
      home,
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.local).toBe(true);
    // Counted as the sessions they were, not skipped: the log is history, not a tool filter.
    expect(report.sections.repertoire.sessions).toBe(5);
  });
});
