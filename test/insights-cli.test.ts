import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliPath, runHookRows } from "./hook-runner.js";

// End to end against the example backend in examples/backend-node/, over a real socket.

const repoRoot = join(import.meta.dirname, "..");
const serverPath = join(repoRoot, "examples", "backend-node", "server.js");

let server: ChildProcess;
let home: string;
let noTokenHome: string;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(found));
    });
  });
}

function writePheebsHome(baseUrl?: string, token?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pheebs-home-"));
  mkdirSync(join(dir, ".pheebs"), { recursive: true });
  writeFileSync(join(dir, ".pheebs", "config.json"), JSON.stringify(baseUrl ? { baseUrl } : {}));
  if (token) {
    writeFileSync(join(dir, ".pheebs", ".token"), JSON.stringify({ token, id: "gustavo" }));
  }
  return dir;
}

type RunResult = { stdout: string; stderr: string; status: number };

// os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, which is what lets the CLI
// be pointed at a throwaway config and token instead of the developer's own.
function runCli(cwdHome: string, ...args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: cwdHome, USERPROFILE: cwdHome },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: "Bearer pheebs_local" } });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`example backend never came up on ${url}`);
}

beforeAll(async () => {
  port = await freePort();
  const eventsDir = mkdtempSync(join(tmpdir(), "pheebs-server-"));
  server = spawn(process.execPath, [serverPath], {
    cwd: eventsDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });

  await waitForServer(`http://127.0.0.1:${port}/insights`);

  home = writePheebsHome(`http://127.0.0.1:${port}`, "pheebs_local");
  noTokenHome = writePheebsHome(`http://127.0.0.1:${port}`);
}, 60_000);

afterAll(() => {
  server?.kill();
  for (const dir of [home, noTokenHome]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("pheebs insights — against the example backend", () => {
  it("prints one reason line per section and exits 0", () => {
    const { stdout, status } = runCli(home, "insights");
    expect(status).toBe(0);
    expect(stdout).toContain("Repertoire: this backend does not produce it");
    expect(stdout).toContain("Judgement signals: this backend does not produce it");
  });

  it("reports nothing as a zero when nothing was computed", () => {
    const { stdout } = runCli(home, "insights");
    expect(stdout).not.toMatch(/0%|\$0/);
  });

  // Compared as raw text, not through JSON.parse: re-serializing would reorder keys and the
  // assertion would still pass, which is the one thing "unchanged" has to rule out.
  it("emits the payload byte-for-byte unchanged with --json", async () => {
    const { stdout, status } = runCli(home, "insights", "--json");
    expect(status).toBe(0);

    const res = await fetch(`http://127.0.0.1:${port}/insights`, {
      headers: { Authorization: "Bearer pheebs_local" },
    });
    const body = await res.text();
    expect(stdout.trimEnd()).toBe(body.trimEnd());
    expect(JSON.parse(stdout).sections.judgement_signals.reason).toBe("not_implemented");
  });

  it("passes --days through and reports the window the backend applied", () => {
    expect(runCli(home, "insights", "--days", "7").stdout).toContain("Your last 7 days");
    expect(runCli(home, "insights", "--days=7").stdout).toContain("Your last 7 days");
  });

  it("refuses a window the contract does not allow, without calling out", () => {
    for (const arg of [
      ["--days", "0"],
      ["--days", "400"],
      ["--days", "abc"],
      ["--days=1.5"],
      ["--days="],
    ]) {
      const { status, stderr } = runCli(home, "insights", ...arg);
      expect(status).toBe(1);
      expect(stderr).toContain("pheebs: --days takes a whole number");
    }
  });

  it("says which credential is missing rather than failing opaquely", () => {
    const { status, stderr } = runCli(noTokenHome, "insights");
    expect(status).toBe(1);
    expect(stderr).toContain("config set token");
  });

  it("lists the command in the help", () => {
    expect(runCli(home, "--help").stdout).toContain("insights");
  });
});

describe("session start revalidation, against the example backend", () => {
  it("resolves the id of a token stored offline, and does not widen consent", () => {
    // What `config set token` leaves behind when the backend was unreachable: no id, no consent.
    const offlineHome = writePheebsHome(`http://127.0.0.1:${port}`);
    writeFileSync(
      join(offlineHome, ".pheebs", ".token"),
      JSON.stringify({ token: "pheebs_local_consented" }),
    );
    // The example backend is the sink here, so the debug sink is off.
    const opts = { home: offlineHome, extraEnv: { PHEEBS_DEBUG: "" } };
    try {
      const started = runHookRows(
        ["hook", "session_started"],
        { session_id: "reval-1" },
        undefined,
        opts,
      );
      // Revalidation runs after the write, so the id reaches the session's later events.
      expect(started.find((r) => r.event === "session_started")?.developer).not.toBe("dev-local-2");
      const later = runHookRows(
        ["hook", "session_end"],
        { session_id: "reval-1" },
        undefined,
        opts,
      );
      expect(later.find((r) => r.event === "session_end")?.developer).toBe("dev-local-2");

      const stored = JSON.parse(readFileSync(join(offlineHome, ".pheebs", ".token"), "utf-8"));
      expect(stored.id).toBe("dev-local-2");
      expect(stored.prompt_collection).toBe(false);
    } finally {
      rmSync(offlineHome, { recursive: true, force: true });
    }
  });

  it("deletes a revoked token and strips it from the exporter config", async () => {
    // The example backend has no revoked token, so a stub that revokes everything stands in.
    const revokePort = await freePort();
    const revoker = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((_, res) => res.end('{"allowed":false,"reason":"revoked"}')).listen(${revokePort}, "127.0.0.1")`,
      ],
      { stdio: "ignore" },
    );
    const revokedHome = writePheebsHome(`http://127.0.0.1:${revokePort}`, "pheebs_gone");
    const settingsPath = join(revokedHome, ".claude", "settings.json");
    mkdirSync(join(revokedHome, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer pheebs_gone", KEEP: "1" },
      }),
    );
    try {
      await waitForServer(`http://127.0.0.1:${revokePort}/`);
      runHookRows(["hook", "session_started"], { session_id: "revoked-1" }, undefined, {
        home: revokedHome,
      });

      expect(existsSync(join(revokedHome, ".pheebs", ".token"))).toBe(false);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8")).env).toEqual({ KEEP: "1" });
    } finally {
      revoker.kill();
      rmSync(revokedHome, { recursive: true, force: true });
    }
  });
});
