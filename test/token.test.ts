import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  writeFileSync: (...a: unknown[]) => writeFileSyncMock(...a),
  mkdirSync: (...a: unknown[]) => mkdirSyncMock(...a),
  chmodSync: (...a: unknown[]) => chmodSyncMock(...a),
  unlinkSync: (...a: unknown[]) => unlinkSyncMock(...a),
}));

const backend = vi.hoisted(() => ({ configured: true }));
vi.mock("../src/backend-config.js", () => ({
  validateUrl: () => "https://api.test/validate-token",
  hasBackend: () => backend.configured,
}));

const {
  readStoredToken,
  writeStoredToken,
  getStoredTokenId,
  clearStoredToken,
  tokenLast4,
  validateToken,
  setToken,
  revalidateStoredTokenIfStale,
} = await import("../src/token.js");

function stubFetch(response: Response | Error): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))),
  );
}

beforeEach(() => {
  for (const m of [
    existsSyncMock,
    readFileSyncMock,
    writeFileSyncMock,
    mkdirSyncMock,
    chmodSyncMock,
    unlinkSyncMock,
  ]) {
    m.mockReset();
  }
  existsSyncMock.mockReturnValue(false);
  backend.configured = true;
  delete process.env.PHEEBS_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readStoredToken", () => {
  it("returns undefined when the file is missing", () => {
    expect(readStoredToken()).toBeUndefined();
  });

  it("parses a stored token", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ token: "pheebs_abcd", id: "tok-1", developer: "octocat" }),
    );
    expect(readStoredToken()).toEqual({ token: "pheebs_abcd", id: "tok-1", developer: "octocat" });
  });

  it("returns undefined for empty, malformed, or token-less content", () => {
    existsSyncMock.mockReturnValue(true);
    for (const raw of ["", "not json", JSON.stringify({ id: "no-token" })]) {
      readFileSyncMock.mockReturnValue(raw);
      expect(readStoredToken()).toBeUndefined();
    }
  });
});

describe("writeStoredToken", () => {
  it("writes JSON with 0600 perms and enforces the mode", () => {
    writeStoredToken({ token: "pheebs_xyz", id: "tok-2", developer: "dev" });
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    const [, body, opts] = writeFileSyncMock.mock.calls[0];
    expect(String(body)).toContain("pheebs_xyz");
    expect(opts).toEqual({ mode: 0o600 });
    expect(chmodSyncMock).toHaveBeenCalledWith(expect.any(String), 0o600);
  });
});

describe("getStoredTokenId / tokenLast4", () => {
  it("returns the id only when one is stored", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ token: "pheebs_abcd", id: "tok-3" }));
    expect(getStoredTokenId()).toBe("tok-3");

    readFileSyncMock.mockReturnValue(JSON.stringify({ token: "pheebs_abcd" }));
    expect(getStoredTokenId()).toBeUndefined();
  });

  it("returns the last 4 characters", () => {
    expect(tokenLast4("pheebs_abcd1234")).toBe("1234");
  });
});

describe("clearStoredToken", () => {
  it("removes the token file and reports true when one exists", () => {
    existsSyncMock.mockReturnValue(true);
    expect(clearStoredToken()).toBe(true);
    expect(unlinkSyncMock).toHaveBeenCalledOnce();
  });

  it("reports false and does nothing when no token is stored", () => {
    existsSyncMock.mockReturnValue(false);
    expect(clearStoredToken()).toBe(false);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});

describe("validateToken", () => {
  it("returns the parsed body on a 2xx", async () => {
    stubFetch(
      new Response(JSON.stringify({ id: "i", developer: "d", allowed: true }), { status: 200 }),
    );
    expect(await validateToken("pheebs_x")).toEqual({ id: "i", developer: "d", allowed: true });
  });

  it("makes no request at all when no backend is configured", async () => {
    backend.configured = false;
    stubFetch(new Response("{}", { status: 200 }));
    // Indistinguishable from unreachable, so setToken degrades down its existing offline path.
    expect(await validateToken("pheebs_x")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the token to the /validate-token route with no anon key", async () => {
    stubFetch(new Response(JSON.stringify({ id: "i", allowed: true }), { status: 200 }));
    await validateToken("pheebs_x");
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toMatch(/\/validate-token$/);
    expect(JSON.parse(String(init.body))).toEqual({ token: "pheebs_x" });
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it("surfaces the tenant prompt_collection gate", async () => {
    stubFetch(
      new Response(JSON.stringify({ id: "i", allowed: true, prompt_collection: true }), {
        status: 200,
      }),
    );
    expect(await validateToken("pheebs_x")).toMatchObject({ prompt_collection: true });
  });

  it("maps a 4xx to an unknown rejection", async () => {
    stubFetch(new Response(null, { status: 401 }));
    expect(await validateToken("pheebs_x")).toEqual({ allowed: false, reason: "unknown" });
  });

  it("treats a 5xx as unreachable (undefined), not a rejection", async () => {
    stubFetch(new Response('relation "dev_tokens" does not exist', { status: 500 }));
    expect(await validateToken("pheebs_x")).toBeUndefined();
  });

  it("returns undefined when the backend is unreachable", async () => {
    stubFetch(new Error("network down"));
    expect(await validateToken("pheebs_x")).toBeUndefined();
  });
});

describe("setToken", () => {
  it("stores id, developer, tenant and prompt_collection and reports 'set' on success", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          id: "tok-9",
          developer: "octocat",
          tenant: "acme",
          allowed: true,
          prompt_collection: true,
        }),
        { status: 200 },
      ),
    );
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("set");
    expect(JSON.parse(writeFileSyncMock.mock.calls[0][1] as string)).toMatchObject({
      token: "pheebs_secret",
      id: "tok-9",
      developer: "octocat",
      tenant: "acme",
      prompt_collection: true,
    });
  });

  it("still stores the id but reports 'opted_out'", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          id: "tok-9",
          developer: "g",
          allowed: false,
          opt_out: true,
          reason: "opted_out",
        }),
        { status: 200 },
      ),
    );
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("opted_out");
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
  });

  it("rejects a revoked token without storing it", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ id: "tok-9", developer: "g", allowed: false, reason: "revoked" }),
        { status: 200 },
      ),
    );
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("rejected");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown token without storing it", async () => {
    stubFetch(new Response(null, { status: 401 }));
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("rejected");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("stores the token alone and reports 'offline' when unreachable", async () => {
    stubFetch(new Error("network down"));
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("offline");
    expect(JSON.parse(writeFileSyncMock.mock.calls[0][1] as string)).toEqual({
      token: "pheebs_secret",
    });
  });

  it("treats a backend 5xx as offline rather than rejecting the token", async () => {
    stubFetch(new Response("boom", { status: 500 }));
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("offline");
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
  });

  it("preserves an already-resolved identity on an offline re-set of the same token", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ token: "pheebs_secret", id: "tok-9", developer: "octocat" }),
    );
    stubFetch(new Error("network down"));
    const outcome = await setToken("pheebs_secret");
    expect(outcome.status).toBe("offline");
    expect(JSON.parse(writeFileSyncMock.mock.calls[0][1] as string)).toMatchObject({
      token: "pheebs_secret",
      id: "tok-9",
      developer: "octocat",
    });
  });
});

describe("revalidateStoredTokenIfStale", () => {
  function storeReturns(stored: Record<string, unknown>): void {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify(stored));
  }

  it("does nothing when no id has been resolved yet", async () => {
    storeReturns({ token: "pheebs_x" });
    stubFetch(new Error("must not be called"));
    await revalidateStoredTokenIfStale();
    expect(fetch).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("does nothing while the last validation is within the TTL", async () => {
    storeReturns({ token: "pheebs_x", id: "tok-1", last_validated_at: new Date().toISOString() });
    stubFetch(new Error("must not be called"));
    await revalidateStoredTokenIfStale();
    expect(fetch).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("refreshes id/developer/tenant when stale and still valid", async () => {
    storeReturns({ token: "pheebs_x", id: "old", last_validated_at: "2000-01-01T00:00:00.000Z" });
    stubFetch(
      new Response(
        JSON.stringify({ id: "tok-1", developer: "octocat", tenant: "acme", allowed: true }),
        { status: 200 },
      ),
    );
    await revalidateStoredTokenIfStale();
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string);
    expect(written).toMatchObject({
      token: "pheebs_x",
      id: "tok-1",
      developer: "octocat",
      tenant: "acme",
    });
    expect(written.last_validated_at).toBeTypeOf("string");
  });

  it("drops the id when the token has been revoked server-side", async () => {
    storeReturns({ token: "pheebs_x", id: "old", last_validated_at: "2000-01-01T00:00:00.000Z" });
    stubFetch(
      new Response(
        JSON.stringify({ id: "old", developer: "g", allowed: false, reason: "revoked" }),
        { status: 200 },
      ),
    );
    await revalidateStoredTokenIfStale();
    expect(JSON.parse(writeFileSyncMock.mock.calls[0][1] as string)).toEqual({ token: "pheebs_x" });
  });

  it("keeps the cache untouched when the backend is unreachable", async () => {
    storeReturns({ token: "pheebs_x", id: "tok-1", last_validated_at: "2000-01-01T00:00:00.000Z" });
    stubFetch(new Error("network down"));
    await revalidateStoredTokenIfStale();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
