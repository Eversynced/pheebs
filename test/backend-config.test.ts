import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const chmodSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
  readFileSync: (...a: unknown[]) => readFileSyncMock(...a),
  writeFileSync: (...a: unknown[]) => writeFileSyncMock(...a),
  mkdirSync: (...a: unknown[]) => mkdirSyncMock(...a),
  chmodSync: (...a: unknown[]) => chmodSyncMock(...a),
}));

const {
  DEFAULT_BASE_URL,
  autoUpdateEnabled,
  baseUrl,
  classifyEnabled,
  ensureConfig,
  ingestUrl,
  validateUrl,
  otelBaseUrl,
  classifyPromptUrl,
} = await import("../src/backend-config.js");

function withConfig(config: object | null): void {
  if (config === null) {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  } else {
    readFileSyncMock.mockReturnValue(JSON.stringify(config));
  }
}

beforeEach(() => {
  for (const m of [
    existsSyncMock,
    readFileSyncMock,
    writeFileSyncMock,
    mkdirSyncMock,
    chmodSyncMock,
  ]) {
    m.mockReset();
  }
  existsSyncMock.mockReturnValue(true);
  withConfig(null);
});

describe("baseUrl", () => {
  it("resolves to no backend when nothing is configured", () => {
    expect(baseUrl()).toBe(DEFAULT_BASE_URL);
    expect(baseUrl()).toBe("");
  });

  it("uses the stored config base URL", () => {
    withConfig({ baseUrl: "https://example.test" });
    expect(baseUrl()).toBe("https://example.test");
  });

  it("trims trailing slashes", () => {
    withConfig({ baseUrl: "https://cfg.test/" });
    expect(baseUrl()).toBe("https://cfg.test");
  });

  it("ignores a malformed configured URL and falls back to no backend", () => {
    withConfig({ baseUrl: "  not a url  " });
    expect(baseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it("never writes when resolving (hot path)", () => {
    baseUrl();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("autoUpdateEnabled / classifyEnabled", () => {
  it("auto-update is off unless explicitly enabled", () => {
    expect(autoUpdateEnabled()).toBe(false);
    withConfig({ autoUpdate: true });
    expect(autoUpdateEnabled()).toBe(true);
  });

  it("classify defaults to on and is off only when explicitly set to false", () => {
    expect(classifyEnabled()).toBe(true);
    withConfig({ classify: false });
    expect(classifyEnabled()).toBe(false);
  });
});

describe("route builders", () => {
  it("append their signal paths to the base", () => {
    withConfig({ baseUrl: "https://api.test" });
    expect(ingestUrl()).toBe("https://api.test/ingest");
    expect(validateUrl()).toBe("https://api.test/validate-token");
    expect(otelBaseUrl()).toBe("https://api.test/otel");
    expect(classifyPromptUrl()).toBe("https://api.test/classify-prompt");
  });
});

describe("ensureConfig", () => {
  it("materializes an empty config when the file is absent", () => {
    withConfig(null);
    ensureConfig();
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
    expect(JSON.parse(writeFileSyncMock.mock.calls[0][1] as string)).toEqual({});
  });

  it("is a no-op when a config already exists", () => {
    withConfig({ baseUrl: "https://existing.test" });
    ensureConfig();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
