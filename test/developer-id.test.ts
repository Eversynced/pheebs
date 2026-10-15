import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const getStoredTokenIdMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));
vi.mock("../src/token.js", () => ({ getStoredTokenId: () => getStoredTokenIdMock() }));

const { getDeveloperHandle } = await import("../src/developer-id.js");

function expectedHash(email: string): string {
  return `dev-${createHash("sha256").update(email).digest("hex").substring(0, 6)}`;
}

describe("getDeveloperHandle", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    getStoredTokenIdMock.mockReset().mockReturnValue(undefined);
  });

  it("returns the stored token id without spawning anything", () => {
    getStoredTokenIdMock.mockReturnValue("tok-1");

    expect(getDeveloperHandle()).toBe("tok-1");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to a hashed git email when no token id is stored", () => {
    execFileSyncMock.mockReturnValue("dev@example.com\n");

    expect(getDeveloperHandle()).toBe(expectedHash("dev@example.com"));
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual(["git", ["config", "user.email"]]);
  });

  it("ignores a stored id that is not a string, or is empty", () => {
    execFileSyncMock.mockReturnValue("dev@example.com\n");
    for (const id of [123, ""]) {
      getStoredTokenIdMock.mockReturnValue(id);
      expect(getDeveloperHandle()).toBe(expectedHash("dev@example.com"));
    }
  });

  it("returns 'unknown' when git has no email", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("no email");
    });

    expect(getDeveloperHandle()).toBe("unknown");
  });
});
