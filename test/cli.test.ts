import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const cliPath = join(repoRoot, "dist", "cli.js");

type RunResult = { stdout: string; stderr: string; status: number };

function runCli(...args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

// Run a hook, feeding the payload on stdin and writing logs to a throwaway dir.
function runHookRows(args: string[], payload: unknown): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "pheebs-test-"));
  try {
    execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      input: JSON.stringify(payload),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PHEEBS_LOG_PATH: dir,
        PHEEBS_CODEBASE_ID: "test/hooks",
        PHEEBS_DEBUG: "1", // route the remote transport to the no-network debug sink
      },
    });
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(dir, f), "utf-8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CLI dispatch", () => {
  it("prints the version with --version", () => {
    const { stdout, status } = runCli("--version");
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help with --help and with no args", () => {
    for (const args of [["--help"], []]) {
      const { stdout, status } = runCli(...args);
      expect(status).toBe(0);
      expect(stdout).toContain("pheebs <command>");
      expect(stdout).toContain("Commands:");
    }
  });

  it("exits 1 with the help text on an unknown command", () => {
    const { stderr, status } = runCli("random-command");
    expect(status).toBe(1);
    expect(stderr).toContain("Unknown command: random-command");
    // The unknown-command error reuses the single HELP source, so it lists all commands.
    expect(stderr).toContain("config <cmd>");
    expect(stderr).toContain("pheebs <command>");
  });
});

describe("Codex test-outcome synthesis", () => {
  it("synthesizes tool_use_failed from a failing tool_response, without persisting it", () => {
    const rows = runHookRows(["hook-codex", "tool_use_completed"], {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pytest" },
      tool_response: { exit_code: 1 },
    });
    const toolRow = rows.find((r) => r.tool_intent !== undefined);
    expect(toolRow).toBeDefined();
    expect(toolRow?.event).toBe("tool_use_failed");
    expect(toolRow?.tool_intent).toBe("test_run");
    expect(toolRow).not.toHaveProperty("tool_response");
    expect(JSON.stringify(toolRow)).not.toContain("pytest");
  });

  it("keeps tool_use_completed for a passing tool_response", () => {
    const rows = runHookRows(["hook-codex", "tool_use_completed"], {
      session_id: "s2",
      tool_name: "Bash",
      tool_input: { command: "pytest" },
      tool_response: { exit_code: 0 },
    });
    const toolRow = rows.find((r) => r.tool_intent !== undefined);
    expect(toolRow?.event).toBe("tool_use_completed");
    expect(toolRow?.tool_intent).toBe("test_run");
  });
});

// spawnSync rather than the execFileSync helper above: the scope assertions below are about
// warnings, which land on stderr even when the command succeeds.
function runIn(cwd: string, home: string, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

// The scope default is what `pheebs init` picks with no flags, so it is only meaningful
// end-to-end: run the built CLI in a throwaway HOME + cwd and see which file it wrote.
describe("init and doctor scope", () => {
  let home: string;
  let cwd: string;

  const runScoped = (...args: string[]) => runIn(cwd, home, args);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
    cwd = mkdtempSync(join(tmpdir(), "pheebs-cwd-"));
    // doctor with no tool flag checks only the tools it detects, and detection looks for a
    // `claude` binary or ~/.claude. Neither exists on CI, so the marker stands in for an install.
    mkdirSync(join(home, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes project-local settings by default", () => {
    const result = runScoped("init", "--no-otel");

    expect(result.stdout).toContain("project-level");
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("writes user-level settings with --global", () => {
    const result = runScoped("init", "--global", "--no-otel");

    expect(result.stdout).toContain("user-level");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("warns that events fire twice when a user-level install is also present", () => {
    runScoped("init", "--global", "--no-otel");
    const result = runScoped("init", "--no-otel");

    expect(result.stderr).toContain("fires twice");
    expect(result.stderr).toContain("pheebs uninstall");
  });

  it("does not warn about a user-level install when there is none", () => {
    const result = runScoped("init", "--no-otel");

    expect(result.stderr).not.toContain("fires twice");
  });

  it("warns that project-local Codex hooks need project trust", () => {
    const init = runScoped("init", "--codex", "--no-otel");
    const doctor = runScoped("doctor", "--codex");

    expect(init.stderr).toContain("trust this project");
    expect(doctor.stdout).toContain("trust this project");
  });

  it("does not warn about Codex trust on a user-level install", () => {
    const init = runScoped("init", "--codex", "--global", "--no-otel");
    const doctor = runScoped("doctor", "--codex", "--global");

    expect(init.stderr).not.toContain("trust this project");
    expect(doctor.stdout).not.toContain("trust this project");
  });

  it("does not claim it wrote OTel config when no backend makes it inert", () => {
    const result = runScoped("init");

    expect(result.stdout).not.toContain("wrote OTel config");
    expect(result.stderr).toContain("no backend endpoint is set");
  });

  it("reports OTel written once the endpoint and token are both set", () => {
    runScoped("config", "set", "base-url", "https://example.invalid");
    runScoped("config", "set", "token", "pheebs_test_token");
    const result = runScoped("init");

    expect(result.stdout).toContain("wrote OTel config");
    expect(result.stderr).not.toContain("stays inactive");
  });

  it("includes project-local settings in the default check", () => {
    runScoped("init", "--no-otel");
    const result = runScoped("doctor");

    expect(result.stdout).toContain(join(cwd, ".claude", "settings.local.json"));
  });

  it("reports a user-level-only install as healthy instead of sending you to init", () => {
    runScoped("init", "--global", "--no-otel");
    const result = runScoped("doctor");

    expect(result.stdout).toContain(join(home, ".claude", "settings.json"));
    expect(result.stdout).not.toContain("not found");
  });

  it("fails on a double install rather than reporting one scope healthy", () => {
    runScoped("init", "--global", "--no-otel");
    runScoped("init", "--no-otel");
    const result = runScoped("doctor");

    expect(result.stdout).toContain("every event fires twice");
    expect(result.status).toBe(1);
  });

  it("does not count a settings file Claude Code wrote itself as an install", () => {
    // A permissions-only .claude/settings.local.json is Claude Code's own. Counting it would
    // report a double install against someone who has one, and the remedy it prints,
    // `pheebs uninstall`, would clear the real one.
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
    );
    runScoped("init", "--global", "--no-otel");

    const result = runScoped("doctor");

    // On the report rather than the exit code: doctor also exits 1 when `pheebs` is missing
    // from PATH, which it always is where the package is never installed globally.
    expect(result.stdout).not.toContain("every event fires twice");
    expect(result.stdout).toContain(join(home, ".claude", "settings.json"));
    expect(result.stdout).not.toContain(join(cwd, ".claude", "settings.local.json"));
  });

  it("names both paths when nothing is registered in either scope", () => {
    const result = runScoped("doctor");

    expect(result.stdout).toContain("also checked");
    expect(result.status).toBe(1);
  });

  it("restricts to one scope when the scope is named", () => {
    runScoped("init", "--global", "--no-otel");
    const result = runScoped("doctor", "--project");

    expect(result.stdout).toContain("not found");
    expect(result.stdout).not.toContain("also checked");
  });
});

// Codex and Cursor keep their config at the same path in both scopes, so running from $HOME
// resolves them to one file. Everything that contrasts the two scopes has to notice.
describe("init from $HOME", () => {
  let home: string;

  const runFromHome = (...args: string[]) => runIn(home, home, args);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not claim a second Codex install that is the same file", () => {
    runFromHome("init", "--codex", "--no-otel");
    const again = runFromHome("init", "--codex", "--no-otel");

    expect(again.stderr).not.toContain("fires twice");
  });

  it("does not warn about project trust for what is really a user-level file", () => {
    const result = runFromHome("init", "--codex", "--no-otel");

    expect(result.stderr).not.toContain("trust this project");
  });

  it("still reports the doubled install for Claude Code, whose paths differ", () => {
    runFromHome("init", "--global", "--no-otel");
    const result = runFromHome("init", "--no-otel");

    expect(result.stderr).toContain("fires twice");
  });

  it("still keeps the token out of git when $HOME is a dotfiles repo", () => {
    execFileSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
    runFromHome("config", "set", "base-url", "https://example.invalid");
    runFromHome("config", "set", "token", "pheebs_test_token");

    const result = runFromHome("init", "--codex");

    expect(result.stderr).toContain(".git/info/exclude");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: home, encoding: "utf-8" });
    expect(status).not.toContain(".codex");
  });
});

// The default scope puts hooks and the token in a file per repo, so the commands that clear
// or rewrite them have to reach repos they were not run from.
describe("installs outside the current directory", () => {
  let home: string;
  let repoA: string;
  let repoB: string;

  const run = (cwd: string, ...args: string[]) => runIn(cwd, home, args);

  const settingsOf = (repo: string) => join(repo, ".claude", "settings.local.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
    repoA = mkdtempSync(join(tmpdir(), "pheebs-repo-a-"));
    repoB = mkdtempSync(join(tmpdir(), "pheebs-repo-b-"));
  });

  afterEach(() => {
    for (const dir of [home, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
  });

  it("records every path init writes", () => {
    run(repoA, "init", "--no-otel");
    run(repoB, "init", "--no-otel");

    const registry = JSON.parse(readFileSync(join(home, ".pheebs", "installs.json"), "utf-8"));
    expect(registry.map((e: { path: string }) => e.path).sort()).toEqual(
      [settingsOf(repoA), settingsOf(repoB)].sort(),
    );
  });

  it("uninstall clears a repo it was not run from", () => {
    run(repoA, "init", "--no-otel");
    run(repoB, "init", "--no-otel");

    run(home, "uninstall");

    expect(JSON.parse(readFileSync(settingsOf(repoA), "utf-8")).hooks).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsOf(repoB), "utf-8")).hooks).toBeUndefined();
  });

  it("clearing the endpoint strips the exporter config from every repo, not just this one", () => {
    run(home, "config", "set", "base-url", "https://example.invalid");
    run(home, "config", "set", "token", "pheebs_test_token");
    run(repoA, "init");
    run(repoB, "init");

    // Precondition: the token really did land in a repo-local file.
    expect(readFileSync(settingsOf(repoA), "utf-8")).toContain("pheebs_test_token");

    run(home, "config", "unset", "base-url");

    for (const repo of [repoA, repoB]) {
      const env = JSON.parse(readFileSync(settingsOf(repo), "utf-8")).env ?? {};
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    }
  });

  it("never turns OTel on in a repo that installed with --no-otel", () => {
    // The resync re-applies the gate with enabled=true. If it does not first check that the
    // file already opted in, `config set base-url` writes the token into a repo that
    // deliberately kept it out.
    run(repoA, "init", "--no-otel");
    run(home, "config", "set", "token", "pheebs_test_token");

    run(home, "config", "set", "base-url", "https://example.invalid");

    const settings = JSON.parse(readFileSync(settingsOf(repoA), "utf-8"));
    expect(settings.env).toBeUndefined();
  });

  it("strips a stale endpoint from an install that predates the registry", () => {
    run(home, "config", "set", "base-url", "https://example.invalid");
    run(home, "config", "set", "token", "pheebs_test_token");
    run(repoA, "init");
    expect(readFileSync(settingsOf(repoA), "utf-8")).toContain("pheebs_test_token");

    // Every v1.0.0 `init --project` install has no registry entry; the current directory has
    // to be reached anyway.
    rmSync(join(home, ".pheebs", "installs.json"), { force: true });
    run(repoA, "config", "unset", "base-url");

    const env = JSON.parse(readFileSync(settingsOf(repoA), "utf-8")).env ?? {};
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it("keeps the registry entry for a repo it could not clear", () => {
    run(repoA, "init", "--no-otel");
    run(repoB, "init", "--no-otel");
    writeFileSync(settingsOf(repoB), "{ not json");

    run(home, "uninstall");

    const registry = JSON.parse(readFileSync(join(home, ".pheebs", "installs.json"), "utf-8"));
    const paths = registry.map((e: { path: string }) => e.path);
    expect(paths).toContain(settingsOf(repoB));
    expect(paths).not.toContain(settingsOf(repoA));
  });

  it("restricts a token-bearing settings file to its owner", () => {
    run(home, "config", "set", "base-url", "https://example.invalid");
    run(home, "config", "set", "token", "pheebs_test_token");
    run(repoA, "init");

    expect(statSync(settingsOf(repoA)).mode & 0o077).toBe(0);
  });

  it("keeps a token-bearing project config out of git", () => {
    execFileSync("git", ["init", "-q"], { cwd: repoA, stdio: "ignore" });
    run(home, "config", "set", "base-url", "https://example.invalid");
    run(home, "config", "set", "token", "pheebs_test_token");

    const result = run(repoA, "init");

    expect(result.stderr).toContain(".git/info/exclude");
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoA,
      encoding: "utf-8",
    });
    expect(status).not.toContain(".claude");
  });
});
