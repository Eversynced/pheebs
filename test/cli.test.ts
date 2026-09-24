import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// The scope default is what `pheebs init` picks with no flags, so it is only meaningful
// end-to-end: run the built CLI in a throwaway HOME + cwd and see which file it wrote.
describe("init and doctor scope", () => {
  let home: string;
  let cwd: string;

  // spawnSync rather than the execFileSync helper above: these assertions are about warnings,
  // which land on stderr even when the command succeeds.
  function runScoped(...args: string[]): RunResult {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
    cwd = mkdtempSync(join(tmpdir(), "pheebs-cwd-"));
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

  it("checks project-local settings by default", () => {
    runScoped("init", "--no-otel");
    const result = runScoped("doctor");

    expect(result.stdout).toContain(join(cwd, ".claude", "settings.local.json"));
  });
});
