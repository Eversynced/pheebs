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
import { listPending, tryAcquireLock } from "../src/outbox.js";
import { collectUsage } from "../src/usage-collect.js";
import { loadUsageState, noteSession } from "../src/usage-sessions.js";

const CANARY = "CANARY-prompt-text /home/dev/secret/app.ts";
const NOW = 1_800_000_000_000;
const IDLE = 30 * 60 * 1000;
const EP = "aaaaaaaaaaaaaaaa";
const EP2 = "bbbbbbbbbbbbbbbb";

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
      endpoint: EP,
      ended,
    },
    { root, now },
  );
}

function collect(now = NOW, dir = queue, endpoint = EP) {
  return collectUsage({
    dir,
    endpoint,
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
    rmSync(join(root, "usage-state.json"));
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
      endpoint: EP,
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
    expect(await collect(NOW, queue, EP2)).toBe(0);
    expect(readdirSync(root).filter((f) => /^[0-9a-f]{32}\.json$/.test(f))).toEqual([]);
    expect(await collect()).toBe(0);
  });

  it("sends an ended session that was not read yet after a token rotation on the same endpoint", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 7, 7));
    note(true);
    // The rotated token has a queue of its own, and the hook has not run since.
    const rotated = join(base, "rotated-queue");
    expect(await collect(NOW + 1000, rotated)).toBe(1);
    expect(listPending(rotated)).toHaveLength(1);
    expect(await collect(NOW + 2000, rotated)).toBe(0);
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

describe("the usage state is built for one backend endpoint", () => {
  const queue2 = () => join(base, "queue2");
  const noteUnder = (endpoint: string, now: number, id = "sess-1") =>
    noteSession(
      { tool: "claude_code", session_id: id, codebase: "acme/api", endpoint, ended: true },
      { root, now },
    );
  const sentTo = (dir: string) =>
    listPending(dir).map((p) => JSON.parse(readFileSync(p.path, "utf-8")).input_tokens as number);
  const stateFile = () => JSON.parse(readFileSync(join(root, "usage-state.json"), "utf-8"));

  it("sends nothing again after a token rotation on the same endpoint", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 100, 100));
    note(true);
    await collect();
    noteUnder(EP, NOW + 1000);
    expect(await collect(NOW + 2000, queue2())).toBe(0);
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 1, 1));
    noteUnder(EP, NOW + 3000);
    expect(await collect(NOW + 4000, queue2())).toBe(1);
    expect(sentTo(queue2())).toEqual([1]);
  });

  it("sends the whole session once to a new endpoint, then only what is added", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 100, 100));
    note(true);
    await collect();
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 1, 1));
    noteUnder(EP2, NOW + 1000);
    expect(await collect(NOW + 2000, queue2(), EP2)).toBe(1);
    expect(sentTo(queue2())).toEqual([101]);
    expect(await collect(NOW + 3000, queue2(), EP2)).toBe(0);
    appendFileSync(transcript, turn("m3", "claude-opus-5-5", 2, 2));
    noteUnder(EP2, NOW + 4000);
    expect(await collect(NOW + 5000, queue2(), EP2)).toBe(1);
    expect(sentTo(queue2()).sort((a, b) => a - b)).toEqual([2, 101]);
    expect(sentTo(queue)).toEqual([100]);
  });

  it("sends the whole session again to an endpoint it comes back to, A then B then A", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 100, 100));
    note(true);
    await collect();
    appendFileSync(transcript, turn("m2", "claude-opus-5-5", 1, 1));
    noteUnder(EP2, NOW + 1000);
    await collect(NOW + 2000, queue2(), EP2);
    expect(sentTo(queue2())).toEqual([101]);
    appendFileSync(transcript, turn("m3", "claude-opus-5-5", 2, 2));
    noteUnder(EP, NOW + 3000);
    expect(await collect(NOW + 4000, queue, EP)).toBe(1);
    expect(sentTo(queue).sort((a, b) => a - b)).toEqual([100, 103]);
    expect(stateFile().endpoint).toBe(EP);
  });

  it("resets the marks of every session and the claims in one step when the endpoint changes", async () => {
    const other = join(base, "proj", "other.jsonl");
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 5, 5));
    writeFileSync(other, turn("m9", "claude-opus-5-5", 6, 6));
    const paths: Record<string, string> = { "sess-1": transcript, other };
    const run = (dir: string, endpoint: string, now: number) =>
      collectUsage({
        dir,
        endpoint,
        root,
        now,
        idleMs: IDLE,
        version: "9.9.9",
        locate: (record) => paths[record.session_id],
      });
    noteUnder(EP, NOW, "sess-1");
    noteUnder(EP, NOW, "other");
    await run(queue, EP, NOW);
    expect(Object.keys(stateFile().marks)).toHaveLength(2);
    expect(Object.keys(stateFile().claims)).toHaveLength(2);
    // Only one session is resumed under the new endpoint: the other's mark goes too.
    noteUnder(EP2, NOW + 1000, "sess-1");
    await run(queue2(), EP2, NOW + 2000);
    const after = stateFile();
    expect(after.endpoint).toBe(EP2);
    expect(Object.keys(after.marks)).toHaveLength(1);
    expect(Object.keys(after.claims)).toHaveLength(1);
  });

  it("dedups a copied history within an endpoint, and sends it to a new one", async () => {
    const history = turn("m1", "claude-opus-5-5", 10, 10);
    const original = join(base, "proj", "original.jsonl");
    const copy = join(base, "proj", "copy.jsonl");
    writeFileSync(original, history);
    writeFileSync(copy, history + turn("m2", "claude-opus-5-5", 3, 3));
    const paths: Record<string, string> = { original, copy };
    const run = (dir: string, endpoint: string, now: number) =>
      collectUsage({
        dir,
        endpoint,
        root,
        now,
        idleMs: IDLE,
        version: "9.9.9",
        locate: (record) => paths[record.session_id],
      });
    for (const id of ["original", "copy"]) noteUnder(EP, NOW, id);
    await run(queue, EP, NOW);
    expect(sentTo(queue).reduce((a, b) => a + b, 0)).toBe(13);
    for (const id of ["original", "copy"]) noteUnder(EP2, NOW + 1000, id);
    await run(queue2(), EP2, NOW + 2000);
    expect(sentTo(queue2()).reduce((a, b) => a + b, 0)).toBe(13);
  });

  it("keeps one state file however many sessions there are", async () => {
    const paths: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const id = `s${i}`;
      paths[id] = join(base, "proj", `${id}.jsonl`);
      writeFileSync(paths[id], turn(`m${i}`, "claude-opus-5-5", i + 1, 1));
      noteUnder(EP, NOW, id);
    }
    await collectUsage({
      dir: queue,
      endpoint: EP,
      root,
      now: NOW,
      idleMs: IDLE,
      version: "9.9.9",
      locate: (record) => paths[record.session_id],
    });
    const names = readdirSync(root).sort();
    expect(names.filter((f) => /^[0-9a-f]{32}\.json$/.test(f))).toHaveLength(5);
    expect(names).toContain("usage-state.json");
    expect(names).toHaveLength(6);
  });

  it("removes the files earlier layouts left behind", async () => {
    writeFileSync(transcript, turn("m1", "claude-opus-5-5", 1, 1));
    note(true);
    mkdirSync(root, { recursive: true });
    const key = readdirSync(root)
      .find((f) => /^[0-9a-f]{32}\.json$/.test(f))
      ?.slice(0, 32) as string;
    for (const name of [
      `${key}.mark.json`,
      `${key}.${EP}.mark.json`,
      "claims.json",
      `claims.${EP}.json`,
    ]) {
      writeFileSync(join(root, name), "{}");
    }
    await collect();
    expect(readdirSync(root).sort()).toEqual([`${key}.json`, "usage-state.json"]);
  });

  describe("two flushers", () => {
    it("never both read the state: one that finds it taken skips the pass", async () => {
      writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
      note(true);
      mkdirSync(root, { recursive: true });
      const held = tryAcquireLock(root);
      expect(await collect()).toBe(0);
      expect(listPending(queue)).toHaveLength(0);
      held?.release();
      expect(await collect(NOW + 1000)).toBe(1);
    });

    it("loses no mark or claim when two passes start together", async () => {
      const paths: Record<string, string> = {};
      for (let i = 0; i < 4; i++) {
        const id = `s${i}`;
        paths[id] = join(base, "proj", `${id}.jsonl`);
        writeFileSync(paths[id], turn(`m${i}`, "claude-opus-5-5", i + 1, 1));
        noteUnder(EP, NOW, id);
      }
      const run = (dir: string) =>
        collectUsage({
          dir,
          endpoint: EP,
          root,
          now: NOW,
          idleMs: IDLE,
          version: "9.9.9",
          locate: (record) => paths[record.session_id],
        });
      const [a, b] = await Promise.all([run(queue), run(join(base, "queue-b"))]);
      expect([a, b].sort()).toEqual([0, 4]);
      expect(Object.keys(stateFile().marks)).toHaveLength(4);
      expect(Object.keys(stateFile().claims)).toHaveLength(4);
      expect(await run(queue)).toBe(0);
    });

    it("takes over a lock nothing has refreshed for longer than the stale limit", async () => {
      writeFileSync(transcript, turn("m1", "claude-opus-5-5", 2, 2));
      note(true);
      mkdirSync(root, { recursive: true });
      tryAcquireLock(root);
      const lock = join(root, "flush.lock");
      const old = new Date(NOW - 10 * 60_000);
      utimesSync(lock, old, old);
      expect(await collect()).toBe(1);
    });
  });
});

describe("a session whose file repeats another session's lines", () => {
  const paths: Record<string, string> = {};
  const noteTwo = (id: string) =>
    noteSession(
      { tool: "claude_code", session_id: id, codebase: "acme/api", endpoint: EP, ended: true },
      { root, now: NOW },
    );
  const collectBoth = (now = NOW) =>
    collectUsage({
      dir: queue,
      endpoint: EP,
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
    rmSync(join(root, "usage-state.json"));
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
    const text = readFileSync(join(root, "usage-state.json"), "utf-8");
    expect(text).not.toContain("m-secret-id");
    expect(text).not.toContain("CANARY");
    if (process.platform !== "win32") {
      expect(statSync(join(root, "usage-state.json")).mode & 0o077).toBe(0);
    }
  });

  describe("the state file", () => {
    const day = 24 * 60 * 60 * 1000;
    const today = Math.floor(NOW / day);
    const write = (claims: Record<string, [string, number]>, marks = {}, endpoint = EP) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "usage-state.json"),
        JSON.stringify({ v: 1, endpoint, marks, claims }),
      );
    };
    const filler = (n: number, at: number) => {
      const claims: Record<string, [string, number]> = {};
      for (let i = 0; i < n; i++) claims[`k${i}`] = ["o", at];
      return claims;
    };
    const kept = () => JSON.parse(readFileSync(join(root, "usage-state.json"), "utf-8"));

    it("forgets a claim after 180 days, and holds at most 250000", () => {
      write({ old: ["o", today - 181], recent: ["o", today - 179], ...filler(250_000, today - 1) });
      const state = loadUsageState(EP, root, NOW);
      expect(state.ownerOf("old")).toBeUndefined();
      expect(state.ownerOf("recent")).toBe("o");
      state.addClaims({ fresh: "o" });
      state.save();
      expect(Object.keys(kept().claims)).toHaveLength(250_000);
      expect(kept().claims.fresh).toBeDefined();
      expect(kept().claims.recent).toBeUndefined();
    });

    it("starts over when the endpoint is not the one the state was built for", () => {
      write({ k: ["o", today] }, { [`${"a".repeat(32)}`]: { cursors: {}, at: NOW } });
      expect(loadUsageState(EP, root, NOW).ownerOf("k")).toBe("o");
      const other = loadUsageState(EP2, root, NOW);
      expect(other.ownerOf("k")).toBeUndefined();
      expect(other.markOf("a".repeat(32))).toEqual({ cursors: {} });
      other.addClaims({ j: "o" });
      other.save();
      expect(kept().endpoint).toBe(EP2);
      expect(Object.keys(kept().claims)).toEqual(["j"]);
      expect(kept().marks).toEqual({});
    });

    it("replaces a state built for another endpoint even when nothing was added", () => {
      write({ k: ["o", today] });
      loadUsageState(EP2, root, NOW).save();
      expect(kept().endpoint).toBe(EP2);
      expect(kept().claims).toEqual({});
    });

    it("keeps the newest claims when the cap cuts into one day", () => {
      write(filler(250_000, today));
      const state = loadUsageState(EP, root, NOW);
      state.addClaims({ fresh: "o" });
      state.save();
      expect(kept().claims.fresh).toBeDefined();
      expect(kept().claims.k0).toBeUndefined();
      expect(Object.keys(kept().claims)).toHaveLength(250_000);
    });

    it("keeps the newest claims across two capped saves in one day", () => {
      write(filler(250_000, today));
      const first = loadUsageState(EP, root, NOW);
      first.addClaims({ fresh1: "o" });
      first.save();
      const second = loadUsageState(EP, root, NOW);
      second.addClaims({ fresh2: "o" });
      second.save();
      expect(kept().claims.fresh1).toBeDefined();
      expect(kept().claims.fresh2).toBeDefined();
      expect(kept().claims.k0).toBeUndefined();
      expect(kept().claims.k1).toBeUndefined();
      expect(kept().claims.k249999).toBeDefined();
      expect(Object.keys(kept().claims)).toHaveLength(250_000);
    });

    it("drops a mark with no record after 180 days and keeps one whose record is live", () => {
      const gone = "a".repeat(32);
      const live = "b".repeat(32);
      const young = "c".repeat(32);
      write(
        {},
        {
          [gone]: { cursors: {}, at: NOW - 181 * day },
          [live]: { cursors: {}, at: NOW - 181 * day },
          [young]: { cursors: {}, at: NOW - 10 * day },
        },
      );
      const state = loadUsageState(EP, root, NOW);
      state.prune(new Set([live]));
      state.save();
      expect(Object.keys(kept().marks).sort()).toEqual([live, young].sort());
    });
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
      ["codebase", "ended", "endpoint", "session_id", "tool", "touched_at"].sort(),
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
      { tool: "claude_code", session_id: "sess-1", codebase: "acme/api", endpoint: EP },
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
