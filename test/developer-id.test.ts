import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const getStoredTokenIdMock = vi.fn();
const store = vi.hoisted(() => ({ files: new Map<string, unknown>() }));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));
vi.mock("../src/token.js", () => ({ getStoredTokenId: () => getStoredTokenIdMock() }));
vi.mock("../src/pheebs-store.js", () => ({
  readJsonFile: (path: string) => store.files.get(path),
  writeJsonFile: (path: string, value: unknown) => store.files.set(path, value),
}));

const { getDeveloperHandle } = await import("../src/developer-id.js");

function expectedHash(email: string): string {
  return `dev-${createHash("sha256").update(email).digest("hex").substring(0, 6)}`;
}

describe("getDeveloperHandle", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    getStoredTokenIdMock.mockReset().mockReturnValue(undefined);
    store.files.clear();
  });

  it("returns the stored token id without spawning anything", () => {
    getStoredTokenIdMock.mockReturnValue("tok-1");

    expect(getDeveloperHandle("s-1")).toBe("tok-1");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to a hashed git email when no token id is stored", () => {
    execFileSyncMock.mockReturnValue("dev@example.com\n");

    expect(getDeveloperHandle()).toBe(expectedHash("dev@example.com"));
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual(["git", ["config", "user.email"]]);
  });

  it("spawns git once per session, not once per event", () => {
    execFileSyncMock.mockReturnValue("dev@example.com\n");

    for (let i = 0; i < 3; i++) {
      expect(getDeveloperHandle("s-1")).toBe(expectedHash("dev@example.com"));
    }
    expect(execFileSyncMock).toHaveBeenCalledOnce();

    execFileSyncMock.mockReturnValue("other@example.com\n");
    expect(getDeveloperHandle("s-2")).toBe(expectedHash("other@example.com"));
    expect(getDeveloperHandle("s-1")).toBe(expectedHash("dev@example.com"));
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("keeps only the most recent sessions", () => {
    execFileSyncMock.mockReturnValue("dev@example.com\n");
    for (let i = 0; i < 40; i++) getDeveloperHandle(`s-${i}`);

    const [cache] = [...store.files.values()] as Record<string, string>[];
    expect(Object.keys(cache)).toHaveLength(32);
    expect(cache).toHaveProperty("s-39");
    expect(cache).not.toHaveProperty("s-0");
  });

  it("returns 'unknown' when git has no email, and does not cache it", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("no email");
    });

    expect(getDeveloperHandle("s-1")).toBe("unknown");
    expect(store.files.size).toBe(0);
  });
});
