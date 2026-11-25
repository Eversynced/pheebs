import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEventId, usageEventId } from "../src/event-id.js";
import { listPending } from "../src/outbox.js";
import { collectUsage } from "../src/usage-collect.js";
import { loadClaims, noteSession } from "../src/usage-sessions.js";

const CANARY = "CANARY-prompt-text /home/dev/secret/app.ts";
const NOW = 1_800_000_000_000;
const IDLE = 30 * 60 * 1000;

let base: string;
let queue: string;
let root: string;
let transcript: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pheebs-collect-"));
  queue = join(base, "queue");
  root = join(base, "sessions");
  transcript = join(base, "proj", "sess-1.jsonl");
  mkdirSync(join(base, "proj"), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function turn(id: string, model: string, input: number, output: number): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: `r-${id}`,
    message: {
      id,
      model,
      content: [{ type: "text", text: CANARY }],
      usage: { input_tokens: input, output_tokens: output },
    },
  })}\n`;
}

function note(ended: boolean, now = NOW) {
  noteSession(
    {
      tool: "claude_code",
      session_id: "sess-1",
      codebase: "acme/api",
      scope: "scope-a",
      ended,
    },
    { root, now },
  );
}

function collect(now = NOW, dir = queue, scope = "scope-a") {
  return collectUsage({
    dir,
    scope,
    root,
    now,
    idleMs: IDLE,
    version: "9.9.9",
    locate: () => (existsSync(transcript) ? transcript : undefined),
  });
}

function queued(): Record<string, unknown>[] {
  return listPending(queue).map((p) => JSON.parse(readFileSync(p.path, "utf-8")));
}

describe("collectUsage", () => {
  it("queues one delta event per model and scope for an ended session, then nothing", async () => {
    writeFileSync(
      transcript,
      turn("m1", "claude-opus-5-5", 10, 5) + turn("m2", "claude-haiku-5-5", 1, 1),
    );
    note(true);
    expect(await collect()).toBe(2);
    const events = queued();
    expect(events.map((e) => e.model).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(events[0]).toMatchObject({
      event: "session_token_usage",
      source: "hook",
      ai_tool: "claude_code",
      session_id: "sess-1",
      codebase: "acme/api",
      version: "9.9.9",
      usage_source: "transcript",
      from_subagent: false,
    });
    expect(typeof events[0].event_id).toBe("string");
    expect(typeof events[0].timestamp).toBe("string");
    expect(await collect()).toBe(0);
    expect(queued()).toHaveLength(2);
  });

  it("leaves a live session alone and sweeps one idle past the window that never ended", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 1, 1));
    note(false);
    expect(await collect(NOW + 1000)).toBe(0);
    expect(await collect(NOW + IDLE + 1)).toBe(1);
  });

  it("sends a resumed session's new work as a delta, not a running total", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 10, 10));
    note(true);
    await collect();
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 3, 4));
    note(true, NOW + 5000);
    expect(await collect(NOW + 6000)).toBe(1);
    const latest = queued().filter((e) => e.input_tokens === 3);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ input_tokens: 3, output_tokens: 4 });
  });

  it("does not advance the mark when the queue refuses the event", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(true);
    const blocked = join(base, "blocked");
    writeFileSync(blocked, "a file where the queue directory should be");
    await collect(NOW, blocked).catch(() => {});
    expect(await collect(NOW + 1000)).toBe(0);
    expect(await collect(NOW + 11 * 60_000)).toBe(1);
  });

  it("names a pass the same way when the mark was lost, so a resend is one event", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(true);
    await collect();
    for (const name of readdirSync(root)) {
      if (name.endsWith(".mark.json")) rmSync(join(root, name));
    }
    await collect(NOW + 1000);
    const ids = queued().map((e) => e.event_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("gives two passes over different bytes different ids, even when the file time is unchanged", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    const at = new Date(NOW - 10_000);
    utimesSync(transcript, at, at);
    note(true);
    await collect();
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 3, 3));
    utimesSync(transcript, at, at);
    note(true, NOW + 5000);
    await collect(NOW + 6000);
    const ids = queued().map((e) => e.event_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("writes each queued event to the log it is given", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(true);
    const logged: Record<string, unknown>[] = [];
    await collectUsage({
      dir: queue,
      root,
      now: NOW,
      version: "9.9.9",
      log: (e) => logged.push(e),
    });
    expect(logged.map((e) => e.event_id)).toEqual(queued().map((e) => e.event_id));
  });

  it("keeps the transcript path and its content out of every queued event", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(true);
    await collect();
    for (const p of listPending(queue)) {
      const text = readFileSync(p.path, "utf-8");
      expect(text).not.toContain(base);
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain("transcript_path");
    }
  });

  it("looks for a transcript it cannot find again later, not on every pass", async () => {
    note(true);
    expect(await collect()).toBe(0);
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    expect(await collect(NOW + 60_000)).toBe(0);
    expect(await collect(NOW + 11 * 60_000)).toBe(1);
  });

  it("never sends a record captured under another backend, and forgets it", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(true);
    expect(await collect(NOW, queue, "scope-b")).toBe(0);
    expect(readdirSync(root).filter((f) => !f.endsWith(".mark.json"))).toEqual([]);
    expect(await collect()).toBe(0);
  });

  it("keeps the mark when the scope changes, so a resumed session sends only its new work", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 100, 100));
    note(true);
    expect(await collect()).toBe(1);
    expect(await collect(NOW + 1000, queue, "scope-b")).toBe(0);
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 1, 1));
    noteSession(
      {
        tool: "claude_code",
        session_id: "sess-1",
        codebase: "acme/api",
        scope: "scope-b",
        ended: true,
      },
      { root, now: NOW + 2000 },
    );
    expect(await collect(NOW + 3000, queue, "scope-b")).toBe(1);
    const sent = queued().map((e) => e.input_tokens);
    expect(sent.sort()).toEqual([1, 100]);
  });

  it("waits for a session with no SessionEnd while its transcript is still being written", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
    note(false, NOW);
    const justWritten = new Date(NOW + IDLE);
    utimesSync(transcript, justWritten, justWritten);
    expect(await collect(NOW + IDLE + 1000)).toBe(0);
    expect(await collect(NOW + 2 * IDLE + 1000)).toBe(1);
  });

  it("keeps a session's offsets when its record expires and the session resumes", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 10, 10));
    note(true);
    await collect();
    const later = NOW + 40 * 24 * 60 * 60 * 1000;
    expect(await collect(later)).toBe(0);
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 3, 4));
    note(true, later + 1);
    expect(await collect(later + 2)).toBe(1);
    expect(queued().filter((e) => e.input_tokens === 3)).toHaveLength(1);
  });

  it("does nothing for a transcript that is gone", async () => {
    note(true);
    expect(await collect()).toBe(0);
  });
});

describe("a session whose file repeats another session's lines", () => {
  const paths: Record<string, string> = {};
  const noteTwo = (id: string) =>
    noteSession(
      { tool: "claude_code", session_id: id, codebase: "acme/api", scope: "scope-a", ended: true },
      { root, now: NOW },
    );
  const collectBoth = (now = NOW) =>
    collectUsage({
      dir: queue,
      scope: "scope-a",
      root,
      now,
      idleMs: IDLE,
      version: "9.9.9",
      locate: (record) => paths[record.session_id],
    });
  const sent = () => queued().map((e) => [e.session_id, e.input_tokens]);

  beforeEach(() => {
    paths.original = join(base, "proj", "original.jsonl");
    paths.copy = join(base, "proj", "copy.jsonl");
  });

  it("counts a background session's own lines and none of the history it copied", async () => {
    const history = turn("m1", "claude-opus-5-5", 10, 10);
    writeFileSync(paths.original, history);
    const marked = (line: string) =>
      `${JSON.stringify({ ...JSON.parse(line), sessionKind: "bg", requestSessionId: "original" })}\n`;
    const own = `${JSON.stringify({ ...JSON.parse(turn("m2", "claude-opus-5-5", 3, 3)), sessionKind: "bg" })}\n`;
    writeFileSync(paths.copy, marked(history) + own);
    noteTwo("original");
    noteTwo("copy");
    await collectBoth();
    expect(sent().sort()).toEqual([
      ["copy", 3],
      ["original", 10],
    ]);
  });

  it("skips an unmarked copy too, whichever session is read first", async () => {
    const history = turn("m1", "claude-opus-5-5", 10, 10);
    writeFileSync(paths.original, history);
    writeFileSync(paths.copy, history + turn("m2", "claude-opus-5-5", 3, 3));
    noteTwo("original");
    noteTwo("copy");
    await collectBoth();
    const total = queued().reduce((sum, e) => sum + (e.input_tokens as number), 0);
    expect(total).toBe(13);
  });

  it("does not skip a session's own lines when its mark is lost and it is read again", async () => {
    writeFileSync(paths.original, turn("m1", "claude-opus-5-5", 10, 10));
    noteTwo("original");
    await collectBoth();
    for (const name of readdirSync(root)) {
      if (name.endsWith(".mark.json")) rmSync(join(root, name));
    }
    await collectBoth(NOW + 1000);
    expect(sent()).toEqual([
      ["original", 10],
      ["original", 10],
    ]);
  });

  it("stores digests, never the ids of a request", async () => {
    writeFileSync(paths.original, turn("m-secret-id", "claude-opus-5-5", 1, 1));
    noteTwo("original");
    await collectBoth();
    const text = readFileSync(join(root, "claims.json"), "utf-8");
    expect(text).not.toContain("m-secret-id");
    expect(text).not.toContain("CANARY");
    if (process.platform !== "win32") {
      expect(statSync(join(root, "claims.json")).mode & 0o077).toBe(0);
    }
  });

  it("forgets a claim after 180 days, and holds at most 250000", () => {
    const day = 24 * 60 * 60 * 1000;
    mkdirSync(root, { recursive: true });
    const claims: Record<string, [string, number]> = {
      old: ["o", Math.floor(NOW / day) - 181],
      recent: ["o", Math.floor(NOW / day) - 179],
    };
    for (let i = 0; i < 250_000; i++) claims[`k${i}`] = ["o", Math.floor(NOW / day) - 1];
    writeFileSync(join(root, "claims.json"), JSON.stringify({ v: 1, claims }));
    const book = loadClaims(root, NOW);
    expect(book.ownerOf("old")).toBeUndefined();
    expect(book.ownerOf("recent")).toBe("o");
    expect(book.add({ fresh: "o" })).toBe(true);
    book.save();
    const kept = JSON.parse(readFileSync(join(root, "claims.json"), "utf-8")).claims;
    expect(Object.keys(kept)).toHaveLength(250_000);
    expect(kept.fresh).toBeDefined();
    expect(kept.recent).toBeUndefined();
  });
});

describe("noteSession", () => {
  it("keeps no path across later notes", () => {
    note(false);
    note(true, NOW + 5000);
    const file = readdirSync(root).find((f) => !f.endsWith(".mark.json")) as string;
    const record = JSON.parse(readFileSync(join(root, file), "utf-8"));
    expect(record).toMatchObject({ touched_at: NOW + 5000, ended: true });
    expect(Object.keys(record).sort()).toEqual(
      ["codebase", "ended", "scope", "session_id", "tool", "touched_at"].sort(),
    );
  });

  it("writes an owner-only record and never touches the flusher's mark", async () => {
    note(false);
    const files = readdirSync(root);
    expect(files.filter((f) => f.endsWith(".mark.json"))).toEqual([]);
    expect(files).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(statSync(join(root, files[0])).mode & 0o077).toBe(0);
    }
  });

  it("keeps an ended session ended when a late Stop touches it", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 1, 1));
    note(true);
    noteSession(
      { tool: "claude_code", session_id: "sess-1", codebase: "acme/api", scope: "scope-a" },
      { root, now: NOW + 1 },
    );
    expect(await collect(NOW + 2)).toBe(1);
  });

  it("reopens an ended session when it starts again", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 1, 1));
    note(true);
    note(false, NOW + 1);
    expect(await collect(NOW + 2)).toBe(0);
  });
});

describe("usageEventId", () => {
  it("is a UUIDv7 that is stable for one key and differs between keys", () => {
    const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(usageEventId(NOW, "a")).toMatch(V7);
    expect(usageEventId(NOW, "a")).toBe(usageEventId(NOW, "a"));
    expect(usageEventId(NOW, "a")).not.toBe(usageEventId(NOW, "b"));
    expect(newEventId()).toMatch(V7);
  });
});
