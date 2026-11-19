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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End to end through the built CLI: a session_end hook records the session, the detached flusher
// reads the transcript and the example backend stores the usage event.

const repoRoot = join(import.meta.dirname, "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const serverPath = join(repoRoot, "examples", "backend-node", "server.js");
const CANARY = "CANARY-prompt-text /home/dev/secret/app.ts";

let home: string;
let logDir: string;
let backend: ChildProcess | undefined;
let eventsFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pheebs-home-"));
  logDir = mkdtempSync(join(tmpdir(), "pheebs-logs-"));
  eventsFile = join(logDir, "backend-events.jsonl");
});

afterEach(() => {
  try {
    const root = join(home, ".pheebs", "outbox");
    for (const scope of readdirSync(root)) {
      const lock = join(root, scope, "flush.lock");
      if (existsSync(lock)) process.kill(Number(readFileSync(lock, "utf-8").split("\n")[0]));
    }
  } catch {}
  backend?.kill();
  backend = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

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

async function startBackend(): Promise<string> {
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

function configure(baseUrl: string): void {
  const dir = join(home, ".pheebs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ baseUrl }));
  writeFileSync(join(dir, ".token"), JSON.stringify({ token: "pheebs_local" }));
  writeFileSync(join(dir, ".developer-handle"), `${Date.now()}\ntest-dev`);
}

function runHook(args: string[], payload: unknown): number {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PHEEBS_LOG_PATH: logDir,
      PHEEBS_CODEBASE_ID: "test/usage",
      PHEEBS_DEBUG: "",
      PHEEBS_FLUSH_LINGER_MS: "0",
    },
  });
  return result.status ?? 1;
}

function stored(): Record<string, unknown>[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function transcript(): string {
  const path = join(home, ".claude", "projects", "proj", "sess-0001-abcd.jsonl");
  mkdirSync(join(home, ".claude", "projects", "proj"), { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    requestId: "r1",
    message: {
      id: "m1",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: CANARY }],
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 },
    },
  });
  writeFileSync(path, `${line}\n`);
  return path;
}

describe("session token usage delivery", () => {
  it("sends the usage after session_end, without the path or any content", async () => {
    configure(await startBackend());
    const path = transcript();
    expect(runHook(["hook", "session_end"], { session_id: "sess-0001-abcd" })).toBe(0);
    await until(() => stored().some((e) => e.event === "session_token_usage"));
    const usage = stored().filter((e) => e.event === "session_token_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      session_id: "sess-0001-abcd",
      ai_tool: "claude_code",
      model: "claude-opus-5-5",
      input_tokens: 11,
      output_tokens: 7,
      cache_read_tokens: 5,
      from_subagent: false,
      usage_source: "transcript",
    });
    const everything = readFileSync(eventsFile, "utf-8");
    expect(everything).not.toContain(path);
    expect(everything).not.toContain("CANARY");
    const log = readdirSync(logDir)
      .filter((f) => f.endsWith(".jsonl") && f !== "backend-events.jsonl")
      .map((f) => readFileSync(join(logDir, f), "utf-8"))
      .join("");
    expect(log).toContain("session_token_usage");
    expect(log).not.toContain("CANARY");
  });

  it("never records a Cursor session", async () => {
    configure(await startBackend());
    transcript();
    runHook(["hook-cursor", "session_end"], { conversation_id: "c1" });
    expect(existsSync(join(home, ".pheebs", "sessions"))).toBe(false);
  });

  it("records nothing without a backend", () => {
    transcript();
    runHook(["hook", "session_end"], { session_id: "sess-0001-abcd" });
    expect(existsSync(join(home, ".pheebs", "sessions"))).toBe(false);
  });
});
