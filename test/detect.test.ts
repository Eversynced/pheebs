import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onPlatform } from "./platform.js";

const whichMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => whichMock(...args),
}));
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

const { isClaudeCodeInstalled } = await import("../src/commands/detect.js");

function commandNotFound(): never {
  throw new Error("not found");
}

describe("isClaudeCodeInstalled", () => {
  beforeEach(() => {
    whichMock.mockReset();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false when claude is neither on PATH nor on disk", () => {
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockReturnValue(false);
    expect(isClaudeCodeInstalled()).toBe(false);
  });

  it("detects it by its config directory", () => {
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockImplementation((p: string) => p.endsWith(".claude"));
    expect(isClaudeCodeInstalled()).toBe(true);
  });

  it("detects it by its CLI binary", () => {
    whichMock.mockImplementation((_cmd: string, args: string[]) => {
      // Windows looks the name up as `$PATH:claude`.
      if (args[0].replace(/^\$PATH:/, "") === "claude") return Buffer.from("");
      return commandNotFound();
    });
    existsSyncMock.mockReturnValue(false);
    expect(isClaudeCodeInstalled()).toBe(true);
  });

  it("looks a binary up on PATH alone with System32's `where` on Windows", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockReturnValue(false);
    onPlatform("win32", isClaudeCodeInstalled);
    expect(whichMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["$PATH:claude"],
      expect.anything(),
    );
    expect(whichMock).not.toHaveBeenCalledWith("which", expect.anything(), expect.anything());
    vi.unstubAllEnvs();
  });
});
