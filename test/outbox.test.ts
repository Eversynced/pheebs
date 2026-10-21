import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discardOtherScopes,
  enqueue,
  isFlusherLive,
  LOCK_STALE_MS,
  listPending,
  readState,
  scopeDir,
  scopeKey,
  trimToCaps,
  tryAcquireLock,
  updateState,
} from "../src/outbox.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pheebs-outbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const event = (id: string) => ({ event_id: id, event: "tool_use_completed" });

describe("enqueue", () => {
  it("lands each event in new/ with nothing left in tmp/", () => {
    enqueue(event("a"), dir, 1000);
    enqueue(event("b"), dir, 1001);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
    expect(listPending(dir).map((p) => p.name)).toEqual([
      "0000000001000-a.json",
      "0000000001001-b.json",
    ]);
  });

  it("keeps arrival order, and two events in one millisecond apart", () => {
    enqueue(event("z"), dir, 5000);
    enqueue(event("y"), dir, 5000);
    enqueue(event("x"), dir, 4000);
    expect(listPending(dir).map((p) => p.queuedAt)).toEqual([4000, 5000, 5000]);
    expect(listPending(dir)).toHaveLength(3);
  });

  it.skipIf(process.platform === "win32")("writes events owner-only", () => {
    enqueue(event("a"), dir, 1000);
    expect(statSync(listPending(dir)[0].path).mode & 0o777).toBe(0o600);
  });
});

describe("scopes", () => {
  const a = scopeKey("https://a.test", "tok");
  const b = scopeKey("https://b.test", "tok");
  const later = Date.now() + 5 * 60_000;

  it("keeps each backend and token's queue in its own directory, named without the token", () => {
    expect(scopeDir(a, dir)).toBe(join(dir, a));
    expect(scopeDir(a, dir)).not.toBe(scopeDir(b, dir));
    expect(scopeKey("https://a.test", "pheebs_secret")).not.toContain("pheebs_secret");
  });

  it("discards the queues of any other scope, keeping its own", () => {
    enqueue(event("old"), scopeDir(a, dir));
    enqueue(event("new"), scopeDir(b, dir));
    discardOtherScopes(b, dir, later);
    expect(existsSync(scopeDir(a, dir))).toBe(false);
    expect(listPending(scopeDir(b, dir))).toHaveLength(1);
  });

  it("leaves a queue written in the last minute, which a racing hook may still be using", () => {
    enqueue(event("old"), scopeDir(a, dir));
    discardOtherScopes(b, dir);
    expect(listPending(scopeDir(a, dir))).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not throw when an old queue cannot be removed",
    () => {
      enqueue(event("old"), scopeDir(a, dir));
      chmodSync(dir, 0o500);
      try {
        expect(() => discardOtherScopes(b, dir, later)).not.toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it("touches nothing in the root that is not a queue", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    discardOtherScopes(b, dir, later);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("writes state by rename, leaving nothing staged behind", () => {
    enqueue(event("a"), dir);
    updateState({ attempts: 2 }, dir);
    expect(readState(dir)).toEqual({ attempts: 2 });
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("does not recreate a queue removed from under a writer", () => {
    const gone = scopeDir(a, dir);
    expect(() => updateState({ attempts: 1 }, gone)).toThrow();
    expect(existsSync(gone)).toBe(false);
  });
});

describe("trimToCaps", () => {
  const limits = { maxEvents: 2, maxBytes: 1_000_000, maxAgeMs: 10_000 };

  it("drops the oldest past the count cap and counts them", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) enqueue(event(id), dir, 1000 + i);
    expect(trimToCaps(dir, 2000, limits)).toBe(2);
    expect(listPending(dir).map((p) => p.name)).toEqual([
      "0000000001002-c.json",
      "0000000001003-d.json",
    ]);
    expect(readState(dir).droppedSinceLastSend).toBe(2);
  });

  it("drops events past the age cap", () => {
    enqueue(event("old"), dir, 1000);
    enqueue(event("new"), dir, 20_000);
    expect(trimToCaps(dir, 20_500, limits)).toBe(1);
    expect(listPending(dir).map((p) => p.name)).toEqual(["0000000020000-new.json"]);
  });

  it("drops the oldest past the byte cap", () => {
    enqueue({ ...event("a"), pad: "x".repeat(400) }, dir, 1000);
    enqueue({ ...event("b"), pad: "x".repeat(400) }, dir, 1001);
    expect(trimToCaps(dir, 1002, { ...limits, maxBytes: 600 })).toBe(1);
    expect(listPending(dir)).toHaveLength(1);
  });

  it("clears a staged file a killed writer left behind", () => {
    mkdirSync(join(dir, "tmp"), { recursive: true });
    const orphan = join(dir, "tmp", "0000000001000-a.json");
    writeFileSync(orphan, "{");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(orphan, old, old);
    trimToCaps(dir);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("the flusher lock", () => {
  it("is exclusive while held, and free once released", () => {
    const lock = tryAcquireLock(dir);
    expect(lock).toBeDefined();
    expect(isFlusherLive(dir)).toBe(true);
    expect(tryAcquireLock(dir)).toBeUndefined();
    lock?.release();
    expect(isFlusherLive(dir)).toBe(false);
    expect(tryAcquireLock(dir)).toBeDefined();
  });

  it("is taken over once its holder stops touching it", () => {
    tryAcquireLock(dir);
    const later = Date.now() + LOCK_STALE_MS + 1000;
    expect(isFlusherLive(dir, later)).toBe(false);
    expect(tryAcquireLock(dir, later)).toBeDefined();
  });

  it("tells a holder whose lock was taken over, and keeps it from removing the new one", () => {
    const first = tryAcquireLock(dir);
    const second = tryAcquireLock(dir, Date.now() + LOCK_STALE_MS + 1000);
    expect(first?.refresh()).toBe(false);
    first?.release();
    expect(isFlusherLive(dir)).toBe(true);
    expect(second?.refresh()).toBe(true);
  });

  it("stops counting as held once removed from under its holder", () => {
    const lock = tryAcquireLock(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(lock?.refresh()).toBe(false);
  });

  it("treats a lock stamped in the future as stale, not live forever", () => {
    tryAcquireLock(dir);
    expect(isFlusherLive(dir, Date.now() - LOCK_STALE_MS - 1000)).toBe(false);
  });
});
