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
const revalidateMock = vi.fn();
const optOutStatusMock = vi.fn();
vi.mock("../src/token.js", () => ({
  optOutStatus: () => optOutStatusMock(),
  revalidateStoredTokenIfStale: (...a: unknown[]) => revalidateMock(...a),
  setToken: (...a: unknown[]) => setTokenMock(...a),
  clearStoredToken: (...a: unknown[]) => clearStoredTokenMock(...a),
  readStoredToken: (...a: unknown[]) => readStoredTokenMock(...a),
  tokenLast4: (t: string) => t.slice(-4),
}));

const resyncMock = vi.fn();
vi.mock("../src/otel-resync.js", () => ({
  resyncOtelConfigs: () => resyncMock(),
}));

const canRunClaudeMock = vi.fn();
vi.mock("../src/classify-local.js", () => ({
  canRunClaude: () => canRunClaudeMock(),
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
  revalidateMock.mockReset();
  revalidateMock.mockResolvedValue(false);
  optOutStatusMock.mockReset();
  optOutStatusMock.mockReturnValue("clear");
  canRunClaudeMock.mockReset();
  canRunClaudeMock.mockResolvedValue(true);
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

  it("sets classify to local", async () => {
    await runConfig(["set", "classify", "local"]);
    // `classify: false` is what a client from before local mode reads, so it sends nothing.
    expect(written()).toMatchObject({
      baseUrl: "https://cfg.test",
      classify: false,
      classifyLocally: true,
    });
  });

  it("leaves local mode when classify is set on or off", async () => {
    config = { classify: false, classifyLocally: true };
    await runConfig(["set", "classify", "on"]);
    expect(written()).toEqual({ classify: true });
  });

  it("forces a narrowing revalidation, never setToken, when switching to local", async () => {
    optOutStatusMock.mockReturnValue("opted_out");
    await runConfig(["set", "classify", "local"]);
    expect(revalidateMock).toHaveBeenCalledWith({ force: true });
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("opted out");
  });

  it("warns when switching to local cannot confirm the opt-out", async () => {
    optOutStatusMock.mockReturnValue("unknown");
    await runConfig(["set", "classify", "local"]);
    expect(logs.join("\n")).toContain("could not confirm");
  });

  it("does not promise a later check when there is no backend to ask", async () => {
    optOutStatusMock.mockReturnValue("unchecked");
    await runConfig(["set", "classify", "local"]);
    expect(logs.join("\n")).toContain("no backend is configured");
  });

  it("warns when switching to local cannot start claude", async () => {
    canRunClaudeMock.mockResolvedValue(false);
    await runConfig(["set", "classify", "local"]);
    expect(logs.join("\n")).toContain("could not run `claude`");
  });

  it("says so when switching to local finds the token revoked, and pulls it from OTel", async () => {
    revalidateMock.mockResolvedValue(true);
    resyncMock.mockReset();
    await runConfig(["set", "classify", "local"]);
    expect(logs.join("\n")).toContain("revoked");
    expect(resyncMock).toHaveBeenCalledOnce();
  });

  it("rejects local for a toggle that has no local mode", async () => {
    await expect(runConfig(["set", "auto-update", "local"])).rejects.toThrow("exit:1");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
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

  it("leaves local mode on unset classify", async () => {
    config = { classify: false, classifyLocally: true };
    await runConfig(["unset", "classify"]);
    expect(written()).toEqual({});
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
