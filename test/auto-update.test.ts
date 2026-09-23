import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

const { maybeAutoUpdate } = await import("../src/auto-update.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// auto-update is opt-in, so every spawning case must enable it. config.json and the throttle
// file share one readFileSync mock, so answer by path.
function enabledWithThrottle(stamp?: string) {
  readFileSyncMock.mockImplementation((p: unknown) =>
    String(p).endsWith("config.json") ? JSON.stringify({ autoUpdate: true }) : (stamp ?? ""),
  );
}

// Minimal child-process double: maybeAutoUpdate only calls .on() and .unref().
function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() };
}

describe("maybeAutoUpdate", () => {
  let originalArgv1: string | undefined;

  beforeEach(() => {
    for (const m of [
      spawnMock,
      existsSyncMock,
      readFileSyncMock,
      writeFileSyncMock,
      mkdirSyncMock,
    ]) {
      m.mockReset();
    }
    spawnMock.mockReturnValue(fakeChild());
    originalArgv1 = process.argv[1];
    process.argv[1] = "/path/to/cli.js";
  });

  afterEach(() => {
    process.argv[1] = originalArgv1 as string;
    vi.restoreAllMocks();
  });

  it("does not spawn on a machine with no config at all", () => {
    // The guarantee for a fresh install: nothing self-updates until someone opts in.
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    maybeAutoUpdate();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does nothing when auto-update is left at its default (off)", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({}));

    maybeAutoUpdate();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("spawns a detached background update and stamps the throttle when no check exists", () => {
    enabledWithThrottle();
    existsSyncMock.mockImplementation((p: unknown) => String(p).endsWith("config.json"));

    maybeAutoUpdate();

    // Stamps BEFORE spawning so concurrent sessions can't both fire.
    expect(writeFileSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, argv, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(argv).toEqual(["/path/to/cli.js", "update"]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("does not spawn or stamp when a check ran within the last day", () => {
    existsSyncMock.mockReturnValue(true);
    enabledWithThrottle(String(Date.now() - 60 * 1000));

    maybeAutoUpdate();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("spawns again once the previous check is older than a day", () => {
    existsSyncMock.mockReturnValue(true);
    enabledWithThrottle(String(Date.now() - 2 * DAY_MS));

    maybeAutoUpdate();

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("treats a malformed throttle file as due", () => {
    existsSyncMock.mockReturnValue(true);
    enabledWithThrottle("not-a-timestamp");

    maybeAutoUpdate();

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("stays silent and does not spawn on an unexpected read failure", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => maybeAutoUpdate()).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never throws when spawn itself fails", () => {
    existsSyncMock.mockReturnValue(false);
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => maybeAutoUpdate()).not.toThrow();
  });

  it("does nothing when the CLI entry path is unknown", () => {
    process.argv[1] = "";
    existsSyncMock.mockReturnValue(false);

    maybeAutoUpdate();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
