import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The reference backend's /ingest/batch, over a real socket: it is what a self-hoster copies.

const serverPath = join(import.meta.dirname, "..", "examples", "backend-node", "server.js");

let server: ChildProcess;
let dir: string;
let base: string;

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

async function startServer(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), EVENTS_FILE: join(dir, "events.jsonl") },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${base}/ingest`, { method: "GET" });
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("example backend never came up");
}

async function stopServer(): Promise<void> {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
}

function envelope(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    timestamp: "2026-10-20T00:00:00.000Z",
    source: "hook",
    event: "tool_use_completed",
    codebase: "test/batch",
    ai_tool: "claude_code",
    session_id: "s1",
    version: "test",
    ...overrides,
  };
}

function postBatch(events: unknown[], token = "pheebs_local"): Promise<Response> {
  return fetch(`${base}/ingest/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
}

function storedRows(): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const ID_A = "0192a8f0-0000-7000-8000-00000000000a";
const ID_B = "0192a8f0-0000-7000-8000-00000000000b";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pheebs-backend-"));
  await startServer();
});

afterEach(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe("example backend /ingest/batch", () => {
  it("stores a batch once and reports a resend as duplicates", async () => {
    const first = await postBatch([envelope(ID_A), envelope(ID_B)]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

    const resend = await postBatch([envelope(ID_A), envelope(ID_B)]);
    expect(await resend.json()).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(storedRows()).toHaveLength(2);
  });

  it("keeps one token from claiming another's ids", async () => {
    await postBatch([envelope(ID_A)]);
    const other = await postBatch([envelope(ID_A)], "pheebs_local_consented");
    expect(await other.json()).toMatchObject({ accepted: 1, duplicates: 0 });
  });

  it("remembers stored ids across a restart", async () => {
    await postBatch([envelope(ID_A)]);
    await stopServer();
    await startServer();
    expect(await (await postBatch([envelope(ID_A)])).json()).toMatchObject({ duplicates: 1 });
    expect(storedRows()).toHaveLength(1);
  });

  it("rejects bad envelopes by index and still stores the good ones", async () => {
    const res = await postBatch([
      envelope(ID_A),
      envelope("not-a-uuid"),
      { ...envelope(ID_B), session_id: undefined },
    ]);
    expect(await res.json()).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        { index: 1, reason: "invalid_event_id" },
        { index: 2, reason: "missing_field" },
      ],
    });
  });

  it("stamps identity from the token and ignores a client-supplied developer", async () => {
    await postBatch([envelope(ID_A, { developer: "someone-else" })]);
    expect(storedRows()[0].developer).toBe("dev-local-1");
  });

  it("answers 413 to a body over its cap, so the client sends less", async () => {
    const big = envelope(ID_A, { pad: "x".repeat(1_100_000) });
    expect((await postBatch([big])).status).toBe(413);
  });

  it("answers 400 to an empty batch, as the schema requires at least one event", async () => {
    expect((await postBatch([])).status).toBe(400);
  });

  it("answers 401 to an unknown token and 413 past the batch cap", async () => {
    expect((await postBatch([envelope(ID_A)], "nope")).status).toBe(401);
    const tooMany = Array.from({ length: 501 }, (_, i) =>
      envelope(`0192a8f0-0000-7000-8000-${String(i).padStart(12, "0")}`),
    );
    expect((await postBatch(tooMany)).status).toBe(413);
    expect(storedRows()).toHaveLength(0);
  });

  it("deduplicates a single /ingest that carries an already-stored id", async () => {
    await postBatch([envelope(ID_A)]);
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pheebs_local" },
      body: JSON.stringify(envelope(ID_A)),
    });
    expect(res.status).toBe(202);
    expect(storedRows()).toHaveLength(1);
  });
});
