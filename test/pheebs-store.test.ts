import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onPlatform } from "./platform.js";

const execFileSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
}));

const { restrictToOwner } = await import("../src/pheebs-store.js");

const WHOAMI = "C:\\Windows\\System32\\whoami.exe";
const ICACLS = "C:\\Windows\\System32\\icacls.exe";
const SETTINGS = "C:\\repo\\.claude\\settings.local.json";

describe("restrictToOwner on Windows", () => {
  beforeEach(() => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    execFileSyncMock.mockReset();
    chmodSyncMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["a local or domain account", "S-1-5-21-1004336348-1177238915-682003330-1001"],
    ["an Entra ID account", "S-1-12-1-3570744463-1145418347-2283147948-2618443913"],
  ])("grants %s alone after dropping inherited entries", (_kind, sid) => {
    execFileSyncMock.mockImplementation((file: string) =>
      file === WHOAMI ? `"desktop\\dev","${sid}"\r\n` : "",
    );

    onPlatform("win32", () => restrictToOwner(SETTINGS));

    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      WHOAMI,
      ["/user", "/fo", "csv", "/nh"],
      expect.anything(),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      ICACLS,
      [SETTINGS, "/inheritance:r", "/grant:r", `*${sid}:F`],
      expect.anything(),
    );
    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it("leaves the ACL alone when no SID resolves", () => {
    execFileSyncMock.mockReturnValue("ERROR: Unable to get user name.\r\n");

    onPlatform("win32", () => restrictToOwner(SETTINGS));

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalledWith(ICACLS, expect.anything(), expect.anything());
  });

  it("does not throw when whoami fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    expect(() => onPlatform("win32", () => restrictToOwner(SETTINGS))).not.toThrow();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when icacls fails", () => {
    execFileSyncMock.mockImplementation((file: string) => {
      if (file === WHOAMI) return '"desktop\\dev","S-1-5-21-1-2-3-1001"';
      throw new Error("Access is denied.");
    });

    expect(() => onPlatform("win32", () => restrictToOwner(SETTINGS))).not.toThrow();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe("restrictToOwner off Windows", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    chmodSyncMock.mockReset();
  });

  it("sets mode 0600 and launches nothing", () => {
    onPlatform("linux", () => restrictToOwner("/home/dev/.claude/settings.json"));

    expect(chmodSyncMock).toHaveBeenCalledWith("/home/dev/.claude/settings.json", 0o600);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
