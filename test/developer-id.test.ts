import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const getStoredTokenIdMock = vi.fn();

vi.mock("node:child_process", () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }));
vi.mock("../src/token.js", () => ({ getStoredTokenId: () => getStoredTokenIdMock() }));

const { getDeveloperHandle } = await import("../src/developer-id.js");

function expectedHash(email: string): string {
  return `dev-${createHash("sha256").update(email).digest("hex").substring(0, 6)}`;
}

describe("getDeveloperHandle", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    getStoredTokenIdMock.mockReset().mockReturnValue(undefined);
  });

  it("returns the stored token id without spawning anything", () => {
    getStoredTokenIdMock.mockReturnValue("tok-1");

    expect(getDeveloperHandle()).toBe("tok-1");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to a hashed git email when no token id is stored", () => {
    execSyncMock.mockReturnValue("dev@example.com\n");

    expect(getDeveloperHandle()).toBe(expectedHash("dev@example.com"));
    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execSyncMock.mock.calls[0][0]).toBe("git config user.email");
  });

  it("returns 'unknown' when git has no email", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("no email");
    });

    expect(getDeveloperHandle()).toBe("unknown");
  });

  it("never asks gh for a GitHub handle", () => {
    execSyncMock.mockReturnValue("dev@example.com\n");

    getDeveloperHandle();
    for (const [cmd] of execSyncMock.mock.calls) expect(String(cmd)).not.toMatch(/^gh\b/);
  });
});
