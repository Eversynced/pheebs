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

  it("goes through System32's cmd.exe on Windows, where npm is npm.cmd", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    expect(onPlatform("win32", getLatestVersion)).toBe("1.2.3");
    expect(execSyncMock).toHaveBeenCalledWith(
      "npm view pheebs version",
      expect.objectContaining({
        shell: "C:\\Windows\\System32\\cmd.exe",
        windowsHide: true,
        env: expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: "1" }),
      }),
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
