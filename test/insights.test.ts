import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { fetchInsights } = await import("../src/insights.js");

let storedToken: object | null = { token: "pheebs_x", id: "gustavo" };
let cfg: object = { baseUrl: "https://api.test" };

function stubFetch(response: Response | Error): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))),
  );
}

beforeEach(() => {
  readFileSyncMock.mockReset();
  storedToken = { token: "pheebs_x", id: "gustavo" };
  cfg = { baseUrl: "https://api.test" };
  readFileSyncMock.mockImplementation((p: unknown) => {
    const path = String(p);
    if (path.endsWith("config.json")) return JSON.stringify(cfg);
    if (path.endsWith(".token") && storedToken !== null) return JSON.stringify(storedToken);
    throw new Error("ENOENT");
  });
  stubFetch(new Response(JSON.stringify({ days: 30, sections: {} })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchInsights — nothing to ask", () => {
  it("does not call out with no endpoint configured", async () => {
    cfg = {};
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error).toContain("config set base-url");
  });

  it("does not call out with no token", async () => {
    storedToken = null;
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error).toContain("config set token");
  });
});

describe("fetchInsights — the request", () => {
  it("GETs /insights with the stored token as a bearer credential", async () => {
    await fetchInsights();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.test/insights");
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pheebs_x");
  });

  it("passes the window through as a query parameter", async () => {
    await fetchInsights(7);
    const [url] = vi.mocked(fetch).mock.calls[0] as [URL];
    expect(String(url)).toBe("https://api.test/insights?days=7");
  });

  it("sends no window when none was asked for, leaving the default to the backend", async () => {
    await fetchInsights();
    const [url] = vi.mocked(fetch).mock.calls[0] as [URL];
    expect(String(url)).not.toContain("days");
  });
});

describe("fetchInsights — answers", () => {
  it("returns the parsed payload alongside the untouched body", async () => {
    const body = '{"days":30,"sections":{"cost":{"enabled":false,"reason":"not_implemented"}}}';
    stubFetch(new Response(body));
    const result = await fetchInsights();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe(body);
      expect((result.payload as { days: number }).days).toBe(30);
    }
  });

  it("names a rejected token as the cause, not a network failure", async () => {
    stubFetch(new Response("nope", { status: 401 }));
    const result = await fetchInsights();
    if (!result.ok) expect(result.error).toContain("token was rejected");
  });

  it("distinguishes a backend that does not serve the optional route", async () => {
    for (const status of [404, 405]) {
      stubFetch(new Response("nope", { status }));
      const result = await fetchInsights();
      if (!result.ok) expect(result.error).toContain("does not serve /insights");
    }
  });

  it("reports the status for any other refusal", async () => {
    stubFetch(new Response("boom", { status: 503 }));
    const result = await fetchInsights();
    if (!result.ok) expect(result.error).toContain("503");
  });

  it("does not crash on a body that is not JSON", async () => {
    stubFetch(new Response("<html>a proxy login page</html>"));
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not JSON");
  });

  it("reports an unreachable backend rather than throwing", async () => {
    stubFetch(new TypeError("fetch failed"));
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Could not reach");
  });
});

describe("fetchInsights — refusing what it should not render", () => {
  it("does not follow a redirect to a host the developer never configured", async () => {
    stubFetch(new Response("", { status: 302, headers: { location: "https://elsewhere.test/x" } }));
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("redirected");
  });

  it("asks fetch not to follow one in the first place", async () => {
    await fetchInsights();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  // The abort does not bound a fast link: a huge body arrives before the timeout can fire.
  it("stops reading a body past the size cap instead of buffering it", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024);
    stubFetch(new Response(oversized));
    const result = await fetchInsights();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too large");
  });

  it("still reads a body comfortably under the cap", async () => {
    const body = JSON.stringify({ days: 30, sections: {}, filler: "y".repeat(100_000) });
    stubFetch(new Response(body));
    const result = await fetchInsights();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe(body);
  });
});
