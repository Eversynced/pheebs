import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/logger.js";
import { getTransport } from "../src/transport.js";
import { DebugTransport } from "../src/transports/debug.js";
import { HttpTransport } from "../src/transports/http.js";

const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
const existsSyncMock = vi.fn();

const enqueueMock = vi.fn();
const isFlusherLiveMock = vi.fn(() => false);
const readStateMock = vi.fn(() => ({}) as { nextAttemptAt?: number });
const spawnMock = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));

vi.mock("../src/outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/outbox.js")>()),
  enqueue: (...a: unknown[]) => enqueueMock(...a),
  isFlusherLive: () => isFlusherLiveMock(),
  readState: () => readStateMock(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  writeFileSync: (...a: unknown[]) => writeFileSyncMock(...a),
  mkdirSync: (...a: unknown[]) => mkdirSyncMock(...a),
  chmodSync: (...a: unknown[]) => chmodSyncMock(...a),
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
}));

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "hook",
    event: "tool_use_completed",
    developer: "dev-x",
    codebase: "org/repo",
    ai_tool: "claude_code",
    session_id: "s1",
    version: "9.9.9",
    ...overrides,
  };
}

// Path-aware fs: config.json drives the endpoint, .token holds the (optional) token.
function fsWith(token: string | null) {
  return (p: unknown) => {
    const path = String(p);
    if (path.endsWith("config.json")) return JSON.stringify({ baseUrl: "https://api.test" });
    if (path.endsWith(".token") && token !== null) return JSON.stringify({ token });
    throw new Error("ENOENT");
  };
}

function withToken(token: string): void {
  readFileSyncMock.mockImplementation(fsWith(token));
}

function withoutToken(): void {
  readFileSyncMock.mockImplementation(fsWith(null));
}

// A machine that ran `pheebs init` and never set an endpoint: config exists, baseUrl does not.
function withoutBackend(token: string): void {
  readFileSyncMock.mockImplementation((p: unknown) => {
    const path = String(p);
    if (path.endsWith("config.json")) return JSON.stringify({});
    if (path.endsWith(".token")) return JSON.stringify({ token });
    throw new Error("ENOENT");
  });
}

function stubFetchStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status }))),
  );
}

beforeEach(() => {
  for (const m of [
    readFileSyncMock,
    writeFileSyncMock,
    mkdirSyncMock,
    chmodSyncMock,
    existsSyncMock,
  ]) {
    m.mockReset();
  }
  withoutToken();
  stubFetchStatus(204);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PHEEBS_DEBUG;
});

describe("getTransport", () => {
  it("returns the debug transport when PHEEBS_DEBUG is set", () => {
    process.env.PHEEBS_DEBUG = "1";
    expect(getTransport()).toBeInstanceOf(DebugTransport);
  });

  it("returns the HTTP transport otherwise", () => {
    delete process.env.PHEEBS_DEBUG;
    expect(getTransport()).toBeInstanceOf(HttpTransport);
  });
});

describe("HttpTransport", () => {
  beforeEach(() => {
    for (const m of [enqueueMock, spawnMock]) m.mockClear();
    isFlusherLiveMock.mockReturnValue(false);
    readStateMock.mockReturnValue({});
  });

  it("queues nothing when no backend is configured, even with a token stored", () => {
    withoutBackend("pheebs_tok");
    new HttpTransport().send(entry());
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("queues nothing when no token is stored", () => {
    withoutToken();
    new HttpTransport().send(entry());
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("queues the envelope without developer or logPath, and never touches the network", () => {
    withToken("pheebs_secret");
    new HttpTransport().send(
      entry({ tool_name: "Bash", logPath: "/tmp/x", event_id: "id-1" } as Partial<LogEntry>),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledOnce();
    const [payload] = enqueueMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      event: "tool_use_completed",
      tool_name: "Bash",
      event_id: "id-1",
    });
    expect(payload).not.toHaveProperty("developer");
    expect(payload).not.toHaveProperty("logPath");
  });

  it("scopes the queue to the backend and token without exposing the token", () => {
    withToken("pheebs_secret");
    new HttpTransport().send(entry());
    const [, queueDir] = enqueueMock.mock.calls[0] as [unknown, string];
    const scope = queueDir.split(/[\\/]/).pop() ?? "";
    expect(scope).toMatch(/^[0-9a-f]{16}$/);
    expect(scope).not.toContain("pheebs_secret");
  });

  it("starts a detached flusher that re-invokes this CLI", () => {
    withToken("pheebs_x");
    new HttpTransport().send(entry());
    expect(spawnMock).toHaveBeenCalledOnce();
    const [exe, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(exe).toBe(process.execPath);
    expect(args).toEqual([process.argv[1], "flush", "--linger"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", cwd: homedir() });
  });

  it("leaves a live flusher to pick the event up", () => {
    withToken("pheebs_x");
    isFlusherLiveMock.mockReturnValue(true);
    new HttpTransport().send(entry());
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("holds off starting a flusher while a backoff is pending", () => {
    withToken("pheebs_x");
    readStateMock.mockReturnValue({ nextAttemptAt: Date.now() + 60_000 });
    new HttpTransport().send(entry());
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ignores a pause further out than any the flusher sets, as a clock that went backwards", () => {
    withToken("pheebs_x");
    readStateMock.mockReturnValue({ nextAttemptAt: Date.now() + 24 * 60 * 60 * 1000 });
    new HttpTransport().send(entry());
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("never throws into the hook when the queue cannot be written", () => {
    withToken("pheebs_x");
    enqueueMock.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => new HttpTransport().send(entry())).not.toThrow();
  });
});

function stubFetchBody(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

describe("HttpTransport.classify", () => {
  it("POSTs the prompt to /classify-prompt with a Bearer token and returns the verdict", async () => {
    withToken("pheebs_secret");
    stubFetchBody({
      allowed: true,
      result: {
        label: "task",
        requests_verification: false,
        classifier_version: "or@cb3",
        task_scope: "bounded",
      },
    });
    const result = await new HttpTransport().classify("build the thing");

    expect(result).toEqual({
      label: "task",
      requests_verification: false,
      classifier_version: "or@cb3",
      task_scope: "bounded",
    });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.test/classify-prompt");
    expect(init.headers.Authorization).toBe("Bearer pheebs_secret");
    expect(JSON.parse(init.body)).toEqual({ prompt: "build the thing" });
  });

  it("returns undefined and sends nothing when no token is stored", async () => {
    withoutToken();
    expect(await new HttpTransport().classify("hi")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns undefined and sends no prompt when no backend is configured", async () => {
    withoutBackend("pheebs_tok");
    expect(await new HttpTransport().classify("hi")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns undefined when the backend gates the request", async () => {
    withToken("pheebs_x");
    stubFetchBody({ allowed: false, reason: "no_consent" });
    expect(await new HttpTransport().classify("hi")).toBeUndefined();
  });

  it("returns undefined on a non-2xx", async () => {
    withToken("pheebs_x");
    stubFetchStatus(503);
    expect(await new HttpTransport().classify("hi")).toBeUndefined();
  });
});

describe("DebugTransport.classify", () => {
  it("resolves to undefined without any remote call", async () => {
    expect(await new DebugTransport().classify("hi")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a task_scope that is not a string, as it does for a bad label", async () => {
    withToken("pheebs_secret");
    stubFetchBody({
      allowed: true,
      result: { label: "task", classifier_version: "or@cb3", task_scope: 7 },
    });
    // Copied unguarded, a number would reach the JSONL row and the ingest body typed as a string.
    const result = await new HttpTransport().classify("build the thing");
    expect(result).not.toHaveProperty("task_scope");
  });
});
