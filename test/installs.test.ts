import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_TOOLS } from "../src/hooks/definitions.js";

let home: string;

// homedir() is read once when installs.ts is imported, so the fake HOME has to be in place
// before the module is loaded and the module re-imported per test.
async function loadInstalls() {
  vi.resetModules();
  return await import("../src/installs.js");
}

function registryPath(): string {
  return join(home, ".pheebs", "installs.json");
}

function writeRegistry(value: unknown): void {
  mkdirSync(join(home, ".pheebs"), { recursive: true });
  writeFileSync(registryPath(), typeof value === "string" ? value : JSON.stringify(value));
}

/** A settings file that exists, so listInstalls does not prune the entry. */
function settingsFile(name: string): string {
  const path = join(home, name);
  writeFileSync(path, "{}");
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pheebs-installs-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("installs registry", () => {
  it("records a path and reads it back", async () => {
    const { recordInstall, listInstalls } = await loadInstalls();
    const path = settingsFile("settings.json");

    recordInstall(AI_TOOLS.CLAUDE_CODE, path);

    expect(listInstalls()).toEqual([{ tool: AI_TOOLS.CLAUDE_CODE, path }]);
  });

  it("records one entry per tool and path, not one per init", async () => {
    const { recordInstall, listInstalls } = await loadInstalls();
    const path = settingsFile("settings.json");

    recordInstall(AI_TOOLS.CLAUDE_CODE, path);
    recordInstall(AI_TOOLS.CLAUDE_CODE, path);

    expect(listInstalls()).toHaveLength(1);
  });

  it("hides an unreachable install from consumers but keeps its record", async () => {
    const { recordInstall, listInstalls } = await loadInstalls();
    const here = settingsFile("here.json");
    const offline = settingsFile("offline.json");

    recordInstall(AI_TOOLS.CLAUDE_CODE, here);
    recordInstall(AI_TOOLS.CODEX, offline);
    rmSync(offline);

    // Pruned from the list, because a consumer cannot act on a path that is not there...
    expect(listInstalls()).toEqual([{ tool: AI_TOOLS.CLAUDE_CODE, path: here }]);
    // ...but still on disk, so an unmounted volume does not lose the repo permanently.
    const onDisk = JSON.parse(readFileSync(registryPath(), "utf-8"));
    expect(onDisk.map((e: { path: string }) => e.path)).toContain(offline);
  });

  it("does not let an unrelated init drop an unreachable record", async () => {
    const { recordInstall } = await loadInstalls();
    const offline = settingsFile("offline.json");
    recordInstall(AI_TOOLS.CODEX, offline);
    rmSync(offline);

    recordInstall(AI_TOOLS.CLAUDE_CODE, settingsFile("other.json"));

    const onDisk = JSON.parse(readFileSync(registryPath(), "utf-8"));
    expect(onDisk.map((e: { path: string }) => e.path)).toContain(offline);
  });

  it("forgets only the paths that were cleared", async () => {
    const { recordInstall, forgetInstalls, listInstalls } = await loadInstalls();
    const cleared = settingsFile("cleared.json");
    const skipped = settingsFile("skipped.json");

    recordInstall(AI_TOOLS.CLAUDE_CODE, cleared);
    recordInstall(AI_TOOLS.CODEX, skipped);
    forgetInstalls([cleared]);

    expect(listInstalls()).toEqual([{ tool: AI_TOOLS.CODEX, path: skipped }]);
  });

  it("rejects entries a consumer would act on wrongly", async () => {
    // The resync writes the token into `path`, and uninstall rewrites it in `tool`'s format,
    // so a bad entry is not inert.
    writeRegistry([
      { tool: "claude-code", path: settingsFile("wrong-tool.json") },
      { tool: AI_TOOLS.CLAUDE_CODE, path: "" },
      { tool: AI_TOOLS.CLAUDE_CODE },
      { path: settingsFile("no-tool.json") },
      null,
      { tool: AI_TOOLS.CODEX, path: settingsFile("good.json") },
    ]);
    const { listInstalls } = await loadInstalls();

    expect(listInstalls()).toEqual([{ tool: AI_TOOLS.CODEX, path: join(home, "good.json") }]);
  });

  it("returns nothing when the registry is missing, malformed, or not a list", async () => {
    const { listInstalls } = await loadInstalls();
    expect(listInstalls()).toEqual([]);

    writeRegistry("{ not json");
    expect((await loadInstalls()).listInstalls()).toEqual([]);

    writeRegistry({ tool: AI_TOOLS.CODEX });
    expect((await loadInstalls()).listInstalls()).toEqual([]);
  });

  it("leaves the previous registry intact when a write cannot complete", async () => {
    const { recordInstall, listInstalls } = await loadInstalls();
    const path = settingsFile("settings.json");
    recordInstall(AI_TOOLS.CLAUDE_CODE, path);

    // A directory where the temp file wants to go: the rename never happens.
    mkdirSync(`${registryPath()}.${process.pid}`, { recursive: true });
    recordInstall(AI_TOOLS.CODEX, settingsFile("second.json"));

    expect(listInstalls()).toEqual([{ tool: AI_TOOLS.CLAUDE_CODE, path }]);
  });
});
