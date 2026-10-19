import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End to end against the built CLI: the report read from a log on disk, with and without a
// backend configured. The server here counts requests, so "nothing leaves the machine" is asserted
// on the socket rather than inferred from the output.

const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
const DAY = 86_400_000;

let server: Server;
let hits = 0;
let baseUrl: string;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function home(config: Record<string, unknown> = {}, token?: string): string {
  const dir = tempDir("pheebs-home-");
  mkdirSync(join(dir, ".pheebs"), { recursive: true });
  writeFileSync(join(dir, ".pheebs", "config.json"), JSON.stringify(config));
  if (token) {
    writeFileSync(join(dir, ".pheebs", ".token"), JSON.stringify({ token, id: "tok-1" }));
  }
  return dir;
}

// Three sessions a week apart, on a client first seen well before the window opened.
function logDir(): string {
  const dir = tempDir("pheebs-logs-");
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const row = (daysAgo: number, event: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp: at(daysAgo),
      source: "hook",
      event,
      developer: "tok-1",
      codebase: "acme/app",
      ai_tool: "claude_code",
      session_id: `s-${daysAgo}`,
      version: "1.4.0",
      ...fields,
    });
  const lines = [
    row(40, "session_started"),
    row(14, "subagent_spawned"),
    row(7, "subagent_spawned"),
    row(0, "subagent_spawned"),
    row(0, "prompt_submitted", { command_name: "review" }),
    "not json",
  ];
  writeFileSync(join(dir, "acme--app-2026-10-19.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

type RunResult = { stdout: string; stderr: string; status: number };

// Spawned rather than run synchronously: a blocking child would stall this process's event loop,
// and with it the server the child is meant to reach.
function run(homeDir: string, logs: string, ...args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "insights", ...args], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PHEEBS_LOG_PATH: logs },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolve({ stdout, stderr, status: status ?? 1 }));
  });
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ days: 30, sections: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("pheebs insights — from the local log", () => {
  it("reads the log when no backend is configured, and says so first", async () => {
    const { stdout, status } = await run(home(), logDir());
    expect(status).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("Local report, from this machine's log. No backend was asked.");
    expect(stdout).toContain("Orchestration");
    expect(stdout).toContain("Sessions: 3 over 3 active week(s)");
    expect(stdout).toContain("Artifact breadth: 1 distinct skills and commands");
    expect(stdout).toContain("Judgement signals: needs a backend");
  });

  it("marks the --json payload local, so a script can tell it apart", async () => {
    const { stdout, status } = await run(home(), logDir(), "--json");
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.local).toBe(true);
    expect(payload.sections.repertoire).toMatchObject({ enabled: true, sessions: 3 });
    expect(payload.sections.judgement_signals).toEqual({
      enabled: false,
      reason: "needs_backend",
    });
  });

  it("says there is nothing to report yet on an empty log, rather than failing", async () => {
    const { stdout, status } = await run(home(), tempDir("pheebs-logs-"));
    expect(status).toBe(0);
    expect(stdout).toContain("Repertoire: not enough sessions yet to say anything");
  });

  it("asks a configured backend unless --local is given, and then asks nothing", async () => {
    const configured = home({ baseUrl }, "pheebs_e2e");
    const logs = logDir();

    hits = 0;
    const remote = await run(configured, logs);
    expect(remote.status).toBe(0);
    expect(hits).toBe(1);
    expect(remote.stdout).not.toContain("Local report");

    hits = 0;
    const local = await run(configured, logs, "--local");
    expect(local.status).toBe(0);
    expect(hits).toBe(0);
    expect(local.stdout.split("\n")[0]).toBe(
      "Local report, from this machine's log. No backend was asked.",
    );
  });

  it("refuses a local team report", async () => {
    const { stderr, status } = await run(home(), logDir(), "--team", "--local");
    expect(status).toBe(1);
    expect(stderr).toContain("--local has no team report");
  });
});
