import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { classifyPrompt } = await import("../src/classify.js");

let storedToken: object | null = null;
let cfg: object = { baseUrl: "https://api.test" };

function withStored(value: object | null): void {
  storedToken = value;
}

function stubFetch(response: Response | Error): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))),
  );
}

beforeEach(() => {
  readFileSyncMock.mockReset();
  existsSyncMock.mockReset();
  storedToken = null;
  cfg = { baseUrl: "https://api.test" };
  readFileSyncMock.mockImplementation((p: unknown) => {
    const path = String(p);
    if (path.endsWith("config.json")) return JSON.stringify(cfg);
    if (path.endsWith(".token") && storedToken !== null) return JSON.stringify(storedToken);
    throw new Error("ENOENT");
  });
  stubFetch(new Response(JSON.stringify({ allowed: true, result: { label: "task" } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyPrompt — off / no-op", () => {
  it("returns undefined and sends nothing when classify is disabled in config", async () => {
    cfg = { baseUrl: "https://api.test", classify: false };
    withStored({ token: "pheebs_x", prompt_collection: true });
    expect(await classifyPrompt("build me a thing")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty prompt", async () => {
    withStored({ token: "pheebs_x", prompt_collection: true });
    expect(await classifyPrompt("")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("classifyPrompt — gated (unclassified, no prompt text sent)", () => {
  it("returns unclassified and sends nothing when no token is set", async () => {
    withStored(null);
    expect(await classifyPrompt("build me a thing")).toEqual({ prompt_intent: "unclassified" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns unclassified and sends nothing without tenant consent", async () => {
    withStored({ token: "pheebs_x" }); // no prompt_collection
    expect(await classifyPrompt("build me a thing")).toEqual({ prompt_intent: "unclassified" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("classifyPrompt — consented", () => {
  beforeEach(() => {
    withStored({ token: "pheebs_secret", prompt_collection: true });
  });

  it("POSTs the prompt to /classify-prompt with a Bearer token and maps the result", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          allowed: true,
          result: { label: "repair", requests_verification: true, classifier_version: "or@cb2" },
        }),
      ),
    );
    const result = await classifyPrompt("the build is broken");
    expect(result).toEqual({
      prompt_intent: "repair",
      requests_verification: true,
      classifier_version: "or@cb2",
    });

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.test/classify-prompt");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pheebs_secret");
    expect(JSON.parse(init.body)).toEqual({ prompt: "the build is broken" });
  });

  it("omits requests_verification when the backend leaves it unset", async () => {
    stubFetch(new Response(JSON.stringify({ allowed: true, result: { label: "unclassified" } })));
    expect(await classifyPrompt("hmm")).toEqual({ prompt_intent: "unclassified" });
  });

  it("returns unclassified when the backend gates the request (allowed:false)", async () => {
    stubFetch(new Response(JSON.stringify({ allowed: false, reason: "no_consent" })));
    expect(await classifyPrompt("do the thing")).toEqual({ prompt_intent: "unclassified" });
  });

  it("returns unclassified on a non-2xx", async () => {
    stubFetch(new Response(null, { status: 503 }));
    expect(await classifyPrompt("do the thing")).toEqual({ prompt_intent: "unclassified" });
  });

  it("returns unclassified on a network error", async () => {
    stubFetch(new Error("network down"));
    expect(await classifyPrompt("do the thing")).toEqual({ prompt_intent: "unclassified" });
  });
});
