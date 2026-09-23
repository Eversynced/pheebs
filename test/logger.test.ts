import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendLogEntry, type LogEntry } from "../src/logger.js";

let tmp: string;
let prevDebug: string | undefined;

beforeAll(() => {
  // DebugTransport is a no-op, so this keeps appendLogEntry from hitting the network.
  prevDebug = process.env.PHEEBS_DEBUG;
  process.env.PHEEBS_DEBUG = "1";
});

afterAll(() => {
  if (prevDebug === undefined) delete process.env.PHEEBS_DEBUG;
  else process.env.PHEEBS_DEBUG = prevDebug;
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pheebs-log-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "hook",
    event: "session_started",
    developer: "dev-x",
    codebase: "org/repo",
    ai_tool: "claude_code",
    session_id: "s1",
    ...overrides,
  };
}

describe("appendLogEntry", () => {
  it("writes a JSONL line to a date- and codebase-stamped file", () => {
    appendLogEntry(entry(), { codebaseId: "org/repo", logPath: tmp });

    const files = readdirSync(tmp);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^org--repo-\d{4}-\d{2}-\d{2}\.jsonl$/);

    const parsed = JSON.parse(readFileSync(join(tmp, files[0]), "utf-8").trim());
    expect(parsed).toMatchObject({ event: "session_started", codebase: "org/repo" });
  });

  it("appends successive entries to the same file", () => {
    const config = { codebaseId: "org/repo", logPath: tmp };
    appendLogEntry(entry({ event: "session_started" }), config);
    appendLogEntry(entry({ event: "turn_ended" }), config);

    const file = readdirSync(tmp)[0];
    const lines = readFileSync(join(tmp, file), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).event).toBe("turn_ended");
  });

  it("backfills a missing timestamp", () => {
    appendLogEntry(entry({ timestamp: "" }), { codebaseId: "org/repo", logPath: tmp });
    const file = readdirSync(tmp)[0];
    const parsed = JSON.parse(readFileSync(join(tmp, file), "utf-8").trim());
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
