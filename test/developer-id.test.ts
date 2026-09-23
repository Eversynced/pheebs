import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:child_process", () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }));
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

const { getDeveloperHandle } = await import("../src/developer-id.js");

function expectedHash(email: string): string {
  return `dev-${createHash("sha256").update(email).digest("hex").substring(0, 6)}`;
}

describe("getDeveloperHandle", () => {
  beforeEach(() => {
    for (const m of [
      execSyncMock,
      existsSyncMock,
      readFileSyncMock,
      writeFileSyncMock,
      mkdirSyncMock,
    ]) {
      m.mockReset();
    }
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a fresh cached handle without shelling out", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(`${Date.now()}\noctocat`);

    expect(getDeveloperHandle()).toBe("octocat");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("ignores an expired cache and resolves again", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(`${Date.now() - 48 * 60 * 60 * 1000}\nstale`);
    execSyncMock.mockReturnValue("octocat\n");

    expect(getDeveloperHandle()).toBe("octocat");
  });

  it("prefers the GitHub login and caches it", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("gh")) return "octocat\n";
      throw new Error("unused");
    });

    expect(getDeveloperHandle()).toBe("octocat");
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
  });

  it("falls back to a hashed git email", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("gh")) throw new Error("no gh");
      return "dev@example.com\n";
    });

    expect(getDeveloperHandle()).toBe(expectedHash("dev@example.com"));
  });

  it("returns 'unknown' and does not cache when nothing resolves", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("nope");
    });

    expect(getDeveloperHandle()).toBe("unknown");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
