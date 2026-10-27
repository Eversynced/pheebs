import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End to end through the built CLI: a hook queues, a detached flusher sends.

const repoRoot = join(import.meta.dirname, "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const serverPath = join(repoRoot, "examples", "backend-node", "server.js");

let home: string;
let logDir: string;
let backend: ChildProcess | undefined;
let oldBackend: Server | undefined;
let eventsFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
  logDir = mkdtempSync(join(tmpdir(), "pheebs-logs-"));
  eventsFile = join(logDir, "backend-events.jsonl");
});

afterEach(async () => {
  try {
    for (const lock of scopeFiles("flush.lock")) process.kill(flusherPid(lock));
  } catch {}
  backend?.kill();
  backend = undefined;
  await new Promise<void>((resolve) =>
    oldBackend ? oldBackend.close(() => resolve()) : resolve(),
  );
  oldBackend = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

// The scope directory's name is a hash the test does not compute, so files are found by name.
function scopeFiles(name: string): string[] {
  const root = join(home, ".pheebs", "outbox");
  try {
    return readdirSync(root)
      .map((scope) => join(root, scope, name))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

// A flusher outlives its hook by design, so a test needs the pid to stop the one it started.
function flusherPid(lock: string): number {
  return Number(readFileSync(lock, "utf-8").split("\n")[0]);
}

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

async function startExampleBackend(): Promise<string> {
  const port = await freePort();
  backend = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), EVENTS_FILE: eventsFile },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${base}/ingest`, { method: "GET" });
      return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("example backend never came up");
}

// A backend written against contract 1.3.0: /ingest only.
async function startOldBackend(received: unknown[]): Promise<string> {
  const port = await freePort();
  oldBackend = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/ingest") {
        received.push(JSON.parse(raw));
        res.writeHead(202).end();
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => oldBackend?.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${port}`;
}

// A configured install: endpoint, token, and a cached handle so the hook never reaches `gh`.
function configure(baseUrl: string): void {
  const dir = join(home, ".pheebs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ baseUrl }));
  writeFileSync(join(dir, ".token"), JSON.stringify({ token: "pheebs_local" }));
  writeFileSync(join(dir, ".developer-handle"), `${Date.now()}\ntest-dev`);
}

const env = (lingerMs: number): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PHEEBS_LOG_PATH: logDir,
  PHEEBS_CODEBASE_ID: "test/delivery",
  PHEEBS_DEBUG: "",
  PHEEBS_FLUSH_LINGER_MS: String(lingerMs),
});

function runHook(
  args: string[],
  payload: unknown,
  lingerMs = 60_000,
): { status: number; ms: number } {
  const started = Date.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: env(lingerMs),
    timeout: 30_000,
  });
  return { status: result.status ?? 1, ms: Date.now() - started };
}

function loggedIds(): string[] {
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl") && f !== "backend-events.jsonl")
    .flatMap((f) => readFileSync(join(logDir, f), "utf-8").trim().split("\n"))
    .map((line) => JSON.parse(line).event_id);
}

function storedRows(): Record<string, unknown>[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const queued = () => {
  try {
    return scopeFiles("new").reduce((sum, dir) => sum + readdirSync(dir).length, 0);
  } catch {
    return 0;
  }
};

describe("hook delivery", () => {
  // Cursor and Codex wait for the hook process, so its lifetime is the agent's stall.
  it("exits promptly when the backend is unreachable", () => {
    configure("http://10.255.255.1");
    const { status, ms } = runHook(["hook-codex", "turn_ended"], { session_id: "s1" });
    expect(status).toBe(0);
    expect(ms).toBeLessThan(3000);
  });

  // A timed-out classify request is answered for, but its pending connect would hold the process
  // until the platform's own ~10s timeout.
  it("exits promptly when a prompt's classify request times out", () => {
    configure("http://10.255.255.1");
    writeFileSync(
      join(home, ".pheebs", ".token"),
      JSON.stringify({ token: "pheebs_local", id: "dev-local-1", prompt_collection: true }),
    );
    const { status, ms } = runHook(["hook", "prompt_submitted"], {
      session_id: "s1",
      prompt: "hi",
    });
    expect(status).toBe(0);
    expect(ms).toBeLessThan(6000);
  });

  it("queues in the hook and delivers from a background flusher, once per event", async () => {
    configure(await startExampleBackend());
    for (let i = 0; i < 3; i++) {
      const { status, ms } = runHook(["hook-codex", "turn_ended"], { session_id: "s1" }, 500);
      expect(status).toBe(0);
      expect(ms).toBeLessThan(3000);
    }

    await until(() => storedRows().length === 3 && queued() === 0);
    expect(
      storedRows()
        .map((r) => r.event_id)
        .sort(),
    ).toEqual(loggedIds().sort());
    expect(storedRows().every((r) => r.developer === "dev-local-1" && !("logPath" in r))).toBe(
      true,
    );
  });

  it("falls back to one /ingest per event against a backend that does not batch", async () => {
    const received: Array<Record<string, unknown>> = [];
    configure(await startOldBackend(received));
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" }, 300);
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" }, 300);

    await until(() => received.length === 2 && queued() === 0);
    expect(received.map((r) => r.event_id).sort()).toEqual(loggedIds().sort());
  });

  it("keeps the queue while offline and drains it once the backend is reachable", async () => {
    const port = await freePort();
    configure(`http://127.0.0.1:${port}`);
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" }, 200);
    await until(() => {
      try {
        return JSON.parse(readFileSync(scopeFiles("state.json")[0], "utf-8")).attempts >= 1;
      } catch {
        return false;
      }
    });
    expect(queued()).toBe(1);

    backend = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port), EVENTS_FILE: eventsFile },
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 500));
    const flush = spawnSync(process.execPath, [cliPath, "flush"], {
      env: env(0),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(flush.status).toBe(0);
    expect(flush.stdout.trim()).toBe("pheebs: the send queue is empty");
    await until(() => storedRows().length === 1 && queued() === 0, 15_000);
  });

  it("doctor reports the queue for the configured backend and token", () => {
    configure("http://10.255.255.1");
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" });
    const doctor = (): string =>
      spawnSync(process.execPath, [cliPath, "doctor", "--codex"], {
        cwd: home,
        env: env(60_000),
        encoding: "utf-8",
        timeout: 30_000,
      }).stdout;
    expect(doctor()).toContain("Queued events: 1");

    rmSync(join(home, ".pheebs", ".token"));
    expect(doctor()).not.toContain("Queued events");
  });

  it("unsetting the token discards the queue, since nothing would send or expire it", () => {
    configure("http://10.255.255.1");
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" });
    const flushers = scopeFiles("flush.lock").map(flusherPid);
    const result = spawnSync(process.execPath, [cliPath, "config", "unset", "token"], {
      env: env(60_000),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".pheebs", "outbox"))).toBe(false);
    for (const pid of flushers) {
      try {
        process.kill(pid);
      } catch {}
    }
  });

  it("uninstall removes the send queue along with the hooks", () => {
    configure("http://10.255.255.1");
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" });
    expect(queued()).toBe(1);
    // Uninstall removes the lock along with the queue, so the flusher is found before it goes.
    const flushers = scopeFiles("flush.lock").map(flusherPid);

    const result = spawnSync(process.execPath, [cliPath, "uninstall"], {
      cwd: home,
      env: env(60_000),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".pheebs", "outbox"))).toBe(false);
    for (const pid of flushers) {
      try {
        process.kill(pid);
      } catch {}
    }
  });

  it("never sends queued events to a backend configured after they were queued", async () => {
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    configure(await startOldBackend(atA));
    const first = oldBackend;
    runHook(["hook-codex", "turn_ended"], { session_id: "s1" }, 1500);
    oldBackend = undefined;
    const b = await startOldBackend(atB);
    writeFileSync(join(home, ".pheebs", "config.json"), JSON.stringify({ baseUrl: b }));

    await new Promise((r) => setTimeout(r, 3000));
    await new Promise<void>((resolve) => first?.close(() => resolve()));
    expect(atA).toEqual([]);
    expect(atB).toEqual([]);
  });
});
