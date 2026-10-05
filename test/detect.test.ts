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

const { detectInstalledTools } = await import("../src/commands/detect.js");
const { AI_TOOLS } = await import("../src/hooks/definitions.js");

function commandNotFound(): never {
  throw new Error("not found");
}

describe("detectInstalledTools", () => {
  beforeEach(() => {
    whichMock.mockReset();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nothing when no tool is on PATH or on disk", () => {
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockReturnValue(false);
    expect(detectInstalledTools()).toEqual([]);
  });

  it("detects a tool by its config directory", () => {
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockImplementation((p: string) => p.endsWith(".claude"));
    expect(detectInstalledTools()).toEqual([AI_TOOLS.CLAUDE_CODE]);
  });

  it("detects a tool by its CLI binary", () => {
    whichMock.mockImplementation((_cmd: string, args: string[]) => {
      // Windows looks the name up as `$PATH:cursor`.
      if (args[0].replace(/^\$PATH:/, "") === "cursor") return Buffer.from("");
      return commandNotFound();
    });
    existsSyncMock.mockReturnValue(false);
    expect(detectInstalledTools()).toEqual([AI_TOOLS.CURSOR]);
  });

  it("detects every installed tool", () => {
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockReturnValue(true);
    expect(detectInstalledTools()).toEqual([AI_TOOLS.CLAUDE_CODE, AI_TOOLS.CURSOR, AI_TOOLS.CODEX]);
  });

  it("looks a binary up on PATH alone with System32's `where` on Windows", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    whichMock.mockImplementation(commandNotFound);
    existsSyncMock.mockReturnValue(false);
    onPlatform("win32", detectInstalledTools);
    expect(whichMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["$PATH:claude"],
      expect.anything(),
    );
    expect(whichMock).not.toHaveBeenCalledWith("which", expect.anything(), expect.anything());
    vi.unstubAllEnvs();
  });
});
