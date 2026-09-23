import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/logger.js";
import { getTransport } from "../src/transport.js";
import { DebugTransport } from "../src/transports/debug.js";
import { HttpTransport, TRANSPORT_ERROR_PATH } from "../src/transports/http.js";

const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
const existsSyncMock = vi.fn();

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
  it("sends nothing when no backend is configured, even with a token stored", async () => {
    withoutBackend("pheebs_tok");
    stubFetchStatus(200);
    new HttpTransport().send(entry());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs the envelope to /ingest with a Bearer token, omitting developer and logPath", async () => {
    withToken("pheebs_secret");
    new HttpTransport().send(entry({ tool_name: "Bash", logPath: "/tmp/x" } as Partial<LogEntry>));

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.test/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer pheebs_secret");
    const body = JSON.parse(init.body);
    expect(body.event).toBe("tool_use_completed");
    expect(body.tool_name).toBe("Bash");
    expect(body).not.toHaveProperty("developer");
    expect(body).not.toHaveProperty("logPath");
  });

  it("skips the remote send entirely when no token is stored", () => {
    withoutToken();
    new HttpTransport().send(entry());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes the transport-error marker on a 401", async () => {
    withToken("pheebs_x");
    stubFetchStatus(401);
    new HttpTransport().send(entry());
    await vi.waitFor(() => expect(writeFileSyncMock).toHaveBeenCalled());
    expect(String(writeFileSyncMock.mock.calls[0][0])).toBe(TRANSPORT_ERROR_PATH);
  });

  it("warns on a 422 without writing a marker or throwing", async () => {
    withToken("pheebs_x");
    stubFetchStatus(422);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    new HttpTransport().send(entry());
    await vi.waitFor(() => expect(stderr).toHaveBeenCalled());
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("writes no marker on success", async () => {
    withToken("pheebs_x");
    new HttpTransport().send(entry());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(writeFileSyncMock).not.toHaveBeenCalled();
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
      result: { label: "task", requests_verification: false, classifier_version: "or@cb2" },
    });
    const result = await new HttpTransport().classify("build the thing");

    expect(result).toEqual({
      label: "task",
      requests_verification: false,
      classifier_version: "or@cb2",
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
});
