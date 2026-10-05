import { beforeEach, describe, expect, it, vi } from "vitest";
import { onPlatform } from "./platform.js";

const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

const { getLatestVersion } = await import("../src/commands/update.js");

describe("getLatestVersion", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue("1.2.3\n");
    execSyncMock.mockReset().mockReturnValue("1.2.3\n");
  });

  it("calls npm without a shell off Windows", () => {
    expect(onPlatform("linux", getLatestVersion)).toBe("1.2.3");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npm",
      ["view", "pheebs", "version"],
      expect.anything(),
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("goes through a shell on Windows, where npm is npm.cmd", () => {
    expect(onPlatform("win32", getLatestVersion)).toBe("1.2.3");
    expect(execSyncMock).toHaveBeenCalledWith(
      "npm view pheebs version",
      expect.objectContaining({ windowsHide: true }),
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
