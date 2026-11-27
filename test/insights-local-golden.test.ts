import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The local report's bytes, pinned. A change that moves where the report is computed must leave
// this file untouched; a change that alters a number has to update it on purpose.

const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
const freezePath = pathToFileURL(join(import.meta.dirname, "freeze-date.mjs")).href;
const NOW = "2026-10-19T12:00:00.000Z";
const DAY = 86_400_000;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function logLines(): string[] {
  const row = (daysAgo: number, event: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp: new Date(Date.parse(NOW) - daysAgo * DAY).toISOString(),
      source: "hook",
      event,
      developer: "d",
      codebase: "acme/app",
      ai_tool: "claude_code",
      session_id: `s-${daysAgo}`,
      version: "1.4.0",
      ...extra,
    });
  return [
    row(40, "session_started"),
    row(14, "subagent_spawned"),
    row(7, "subagent_spawned"),
    row(0, "subagent_spawned"),
    row(0, "prompt_submitted", { command_name: "review" }),
    row(0, "tool_use_completed", { tool_intent: "edit" }),
    row(0, "tool_use_completed", { tool_intent: "test_run" }),
    row(7, "tool_use_completed", { tool_intent: "edit" }),
    "not json",
  ];
}

// The `windows` flag changes which detectors are judged, so the bytes are the Unix ones.
describe.skipIf(process.platform === "win32")("pheebs insights --local --json", () => {
  it("prints the same bytes as the committed report for a fixed log and clock", () => {
    const home = tempDir("pheebs-home-");
    mkdirSync(join(home, ".pheebs"), { recursive: true });
    writeFileSync(join(home, ".pheebs", "config.json"), "{}");
    const logs = tempDir("pheebs-logs-");
    writeFileSync(join(logs, "acme--app-2026-10-19.jsonl"), `${logLines().join("\n")}\n`);

    const { stdout, status } = spawnSync(
      process.execPath,
      [cliPath, "insights", "--local", "--json"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PHEEBS_LOG_PATH: logs,
          PHEEBS_TEST_NOW: NOW,
          NODE_OPTIONS: `--import ${freezePath}`,
        },
      },
    );

    expect(status).toBe(0);
    expect(stdout).toBe(
      readFileSync(join(import.meta.dirname, "fixtures", "local-report-golden.json"), "utf-8"),
    );
  });
});
