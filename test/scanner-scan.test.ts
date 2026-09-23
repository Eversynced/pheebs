import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/developer-id.js", () => ({ getDeveloperHandle: () => "dev-test" }));

const { runArtifactScan } = await import("../src/scanner.js");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("runArtifactScan (integration)", () => {
  let repo: string;
  let logDir: string;
  let originalCwd: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "pheebs-scan-repo-"));
    logDir = mkdtempSync(join(tmpdir(), "pheebs-scan-log-"));

    // Git hooks (e.g. pre-push) export GIT_DIR/GIT_WORK_TREE/etc. into the
    // environment. Clear them so the nested git commands below — and the git
    // calls inside runArtifactScan — target the temp repo, not the outer one.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    for (const key of ["PHEEBS_DEBUG", "PHEEBS_LOG_PATH", "PHEEBS_CODEBASE_ID"]) {
      saved[key] = process.env[key];
    }
    process.env.PHEEBS_DEBUG = "1"; // DebugTransport — no network
    process.env.PHEEBS_LOG_PATH = logDir;
    process.env.PHEEBS_CODEBASE_ID = "test/repo";

    git(repo, "init", "-q");
    git(repo, "config", "user.email", "dev@example.com");
    git(repo, "config", "user.name", "Dev");
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    writeFileSync(join(repo, ".claude", "agents", "reviewer.md"), "x");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "add agent");

    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("emits an artifact_found event carrying presence and shape only", () => {
    runArtifactScan("claude_code", "test-session");

    const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const events = readFileSync(join(logDir, files[0]), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const agents = events.find((e) => e.artifact_type === "claude_agents");

    expect(agents).toMatchObject({
      event: "artifact_found",
      codebase: "test/repo",
      developer: "dev-test",
      session_id: "test-session",
      count: 1,
      last_modified_bucket: "today",
    });

    // The fixture is committed by the same identity the repo is configured with, so a
    // scan that still derived authorship would report authored_by_self here. Asserting
    // absence on an untracked fixture would pass either way.
    expect(agents).not.toHaveProperty("authored_by_self");
    expect(agents).not.toHaveProperty("author_count");
    expect(JSON.stringify(agents)).not.toContain("dev@example.com");
  });
  it("emits the config-shaped types without paths or contents", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# context");
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./bin/notify" }] }] },
        enabledPlugins: { "some-plugin@marketplace": true },
      }),
    );

    // Committed so the fixture is an ordinary tracked repo rather than a special case.
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "add config");

    runArtifactScan("claude_code", "test-session");

    const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    const events = readFileSync(join(logDir, files[0]), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    for (const type of ["context_file", "hook_config", "plugin_enabled"]) {
      const event = events.find((e) => e.artifact_type === type);
      expect(event, `no ${type} event`).toBeDefined();
      expect(event).toMatchObject({ event: "artifact_found", count: 1 });
      expect(event.last_modified_bucket).toBe("today");

      expect(event).not.toHaveProperty("paths");
      expect(event).not.toHaveProperty("path");
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(repo);
      expect(serialized).not.toContain("settings.json");
      expect(serialized).not.toContain("./bin/notify");
      expect(serialized).not.toContain("some-plugin@marketplace");
    }
  });
});
