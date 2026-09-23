import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  writeFileSync: (...a: unknown[]) => writeFileSyncMock(...a),
  existsSync: () => true,
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const setTokenMock = vi.fn();
const clearStoredTokenMock = vi.fn();
const readStoredTokenMock = vi.fn();
vi.mock("../src/token.js", () => ({
  setToken: (...a: unknown[]) => setTokenMock(...a),
  clearStoredToken: (...a: unknown[]) => clearStoredTokenMock(...a),
  readStoredToken: (...a: unknown[]) => readStoredTokenMock(...a),
  tokenLast4: (t: string) => t.slice(-4),
}));

const { runConfig } = await import("../src/commands/config.js");

let config: object;
let logs: string[];

// `config set base-url` also re-syncs the agents' OTel config, so more than one file is
// written; pick the pheebs config rather than whichever write happened to land last.
function written(): Record<string, unknown> {
  const call = [...writeFileSyncMock.mock.calls]
    .reverse()
    .find((c) => String(c[0]).endsWith("config.json"));
  if (!call) throw new Error("no config.json write");
  return JSON.parse(call[1] as string);
}

beforeEach(() => {
  config = { baseUrl: "https://cfg.test" };
  logs = [];
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(() => JSON.stringify(config));
  writeFileSyncMock.mockReset();
  setTokenMock.mockReset();
  clearStoredTokenMock.mockReset();
  readStoredTokenMock.mockReset();
  readStoredTokenMock.mockReturnValue(undefined);
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as (code?: number) => never);
});

afterEach(() => vi.restoreAllMocks());

describe("config set", () => {
  it("sets a boolean toggle", async () => {
    await runConfig(["set", "classify", "off"]);
    expect(written()).toMatchObject({ baseUrl: "https://cfg.test", classify: false });
  });

  it("rejects a non on/off value for a toggle", async () => {
    await expect(runConfig(["set", "auto-update", "maybe"])).rejects.toThrow("exit:1");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("sets and trims a valid base-url", async () => {
    await runConfig(["set", "base-url", "https://api.test/"]);
    expect(written()).toMatchObject({ baseUrl: "https://api.test" });
  });

  it("rejects a malformed base-url", async () => {
    await expect(runConfig(["set", "base-url", "nope"])).rejects.toThrow("exit:1");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("delegates token to setToken (validated)", async () => {
    setTokenMock.mockResolvedValue({ status: "set", message: "Token set for octocat (…c1d4)." });
    await runConfig(["set", "token", "pheebs_abc123"]);
    expect(setTokenMock).toHaveBeenCalledWith("pheebs_abc123");
    expect(writeFileSyncMock).not.toHaveBeenCalled(); // token lives in its own file
  });

  it("rejects a token without the pheebs_ prefix", async () => {
    await expect(runConfig(["set", "token", "nope"])).rejects.toThrow("exit:1");
    expect(setTokenMock).not.toHaveBeenCalled();
  });
});

describe("config unset", () => {
  it("removes a config key", async () => {
    config = { baseUrl: "https://cfg.test", classify: false };
    await runConfig(["unset", "classify"]);
    expect(written()).not.toHaveProperty("classify");
    expect(written()).toMatchObject({ baseUrl: "https://cfg.test" });
  });

  it("clears the token", async () => {
    clearStoredTokenMock.mockReturnValue(true);
    await runConfig(["unset", "token"]);
    expect(clearStoredTokenMock).toHaveBeenCalledOnce();
  });
});

describe("config get / list", () => {
  it("prints the resolved base-url", async () => {
    await runConfig(["get", "base-url"]);
    expect(logs).toContain("https://cfg.test");
  });

  it("lists all settings and the token identity", async () => {
    readStoredTokenMock.mockReturnValue({ token: "pheebs_c1d4", developer: "octocat" });
    await runConfig(["list"]);
    const out = logs.join("\n");
    expect(out).toContain("base-url");
    expect(out).toContain("auto-update");
    expect(out).toContain("classify");
    expect(out).toContain("octocat");
  });

  it("exits non-zero on an unknown subcommand", async () => {
    await expect(runConfig(["bogus"])).rejects.toThrow("exit:1");
  });
});
