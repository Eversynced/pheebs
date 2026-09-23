import { homedir } from "node:os";
import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { detectCodebaseId, parseCodebaseId, resolveLogPath } from "../src/config.js";

// Drive the mocked git calls by their argument list. A value of null makes that
// git invocation throw (as a missing remote / non-repo would).
function gitResponds(map: Record<string, string | null>): void {
  execFileSyncMock.mockImplementation((_cmd: string, argv: string[]) => {
    const key = argv.join(" ");
    const value = key in map ? map[key] : null;
    if (value === null) throw new Error(`git failed: ${key}`);
    return Buffer.from(value);
  });
}

describe("parseCodebaseId", () => {
  it("parses SSH remotes", () => {
    expect(parseCodebaseId("git@github.com:Eversynced/pheebs.git")).toBe("Eversynced/pheebs");
    expect(parseCodebaseId("git@github.com:Eversynced/pheebs")).toBe("Eversynced/pheebs");
  });

  it("parses HTTPS remotes", () => {
    expect(parseCodebaseId("https://github.com/Eversynced/pheebs.git")).toBe("Eversynced/pheebs");
    expect(parseCodebaseId("https://github.com/Eversynced/pheebs")).toBe("Eversynced/pheebs");
  });

  it("preserves dots and dashes inside org/repo segments", () => {
    expect(parseCodebaseId("git@github.com:my-org/my.repo.git")).toBe("my-org/my.repo");
  });

  it("rejects dot-prefixed segments", () => {
    expect(parseCodebaseId("git@github.com:.secret/repo.git")).toBe("unknown");
    expect(parseCodebaseId("https://github.com/org/.repo")).toBe("unknown");
  });

  it("returns 'unknown' when no org/repo can be extracted", () => {
    expect(parseCodebaseId("not-a-url")).toBe("unknown");
    expect(parseCodebaseId("")).toBe("unknown");
  });
});

describe("detectCodebaseId", () => {
  const prevId = process.env.PHEEBS_CODEBASE_ID;

  beforeEach(() => {
    delete process.env.PHEEBS_CODEBASE_ID;
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    if (prevId === undefined) delete process.env.PHEEBS_CODEBASE_ID;
    else process.env.PHEEBS_CODEBASE_ID = prevId;
    vi.restoreAllMocks();
  });

  it("prefers the PHEEBS_CODEBASE_ID override and skips git", () => {
    process.env.PHEEBS_CODEBASE_ID = "acme/widgets";
    expect(detectCodebaseId()).toBe("acme/widgets");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("uses the git remote origin as org/repo when available", () => {
    gitResponds({ "remote get-url origin": "git@github.com:Eversynced/pheebs.git" });
    expect(detectCodebaseId()).toBe("Eversynced/pheebs");
  });

  it("falls back to local/<repo-folder> when a repo has no usable remote", () => {
    gitResponds({
      "remote get-url origin": null,
      "rev-parse --show-toplevel": "/home/dev/projects/my-repo",
    });
    expect(detectCodebaseId()).toBe("local/my-repo");
  });

  it("falls back to local/<launch-folder> when outside any git work tree", () => {
    gitResponds({ "remote get-url origin": null, "rev-parse --show-toplevel": null });
    vi.spyOn(process, "cwd").mockReturnValue("/tmp/scratch-dir");
    expect(detectCodebaseId()).toBe("local/scratch-dir");
  });

  it("falls back to the repo folder when the remote URL is unparseable", () => {
    gitResponds({
      "remote get-url origin": "not-a-real-url",
      "rev-parse --show-toplevel": "/srv/weird",
    });
    expect(detectCodebaseId()).toBe("local/weird");
  });

  it("never leaks the full path — only the final folder segment", () => {
    gitResponds({ "remote get-url origin": null, "rev-parse --show-toplevel": null });
    const cwd = "/home/someone/private/secret-project";
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const id = detectCodebaseId();
    expect(id).toBe(`local/${basename(cwd)}`);
    expect(id).not.toContain("someone");
    expect(id).not.toContain("private");
  });
});

describe("resolveLogPath", () => {
  const prev = process.env.PHEEBS_LOG_PATH;

  beforeEach(() => {
    delete process.env.PHEEBS_LOG_PATH;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.PHEEBS_LOG_PATH;
    else process.env.PHEEBS_LOG_PATH = prev;
  });

  it("defaults to ~/.pheebs/logs with the tilde expanded", () => {
    const path = resolveLogPath();
    expect(path.startsWith(homedir())).toBe(true);
    expect(path).toContain(".pheebs/logs");
  });

  it("expands a tilde in the env override", () => {
    process.env.PHEEBS_LOG_PATH = "~/custom-logs";
    expect(resolveLogPath()).toBe(`${homedir()}/custom-logs`);
  });

  it("passes through an absolute env override", () => {
    process.env.PHEEBS_LOG_PATH = "/var/log/pheebs";
    expect(resolveLogPath()).toBe("/var/log/pheebs");
  });
});
