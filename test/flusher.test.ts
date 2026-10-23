import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, type FlushContext, flushOnce } from "../src/flusher.js";
import { enqueue, listPending, readState, updateState } from "../src/outbox.js";

const writeMarkerMock = vi.fn();
vi.mock("../src/transports/http.js", () => ({
  writeMarker: (...a: unknown[]) => writeMarkerMock(...a),
}));

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pheebs-flush-"));
  writeMarkerMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function ctx(overrides: Partial<FlushContext> = {}): FlushContext {
  return {
    token: "pheebs_secret",
    dir,
    batchUrl: "https://api.test/ingest/batch",
    singleUrl: "https://api.test/ingest",
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: NOW,
    random: () => 0.5,
    ...overrides,
  };
}

function answer(status: number, body?: unknown, headers?: Record<string, string>): void {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
    ),
  );
}

function queue(n: number): void {
  for (let i = 0; i < n; i++)
    enqueue({ event_id: `id-${i}`, event: "turn_ended" }, dir, NOW - 120_000 + i);
}

function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("flushOnce", () => {
  it("reports an empty queue without a request", async () => {
    answer(200);
    expect(await flushOnce(ctx())).toBe("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the queue as one authenticated batch and empties it on 200", async () => {
    queue(3);
    answer(200, { accepted: 3, duplicates: 0, rejected: [] });
    expect(await flushOnce(ctx())).toBe("sent");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/ingest/batch");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pheebs_secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("manual");
    expect(sentBodies()[0]).toEqual({
      events: [0, 1, 2].map((i) => ({ event_id: `id-${i}`, event: "turn_ended" })),
      droppedSinceLastSend: 0,
    });
    expect(listPending(dir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "backs off rather than resend at once when a sent event cannot be removed",
    async () => {
      queue(1);
      chmodSync(join(dir, "new"), 0o500);
      answer(200, { accepted: 1, duplicates: 0, rejected: [] });
      try {
        expect(await flushOnce(ctx())).toBe("retry");
        expect(readState(dir).nextAttemptAt).toBeGreaterThan(NOW);
      } finally {
        chmodSync(join(dir, "new"), 0o700);
      }
    },
  );

  it("keeps the batch when a 2xx is not a batch result, as from a captive portal", async () => {
    queue(2);
    fetchMock = vi.fn(() => Promise.resolve(new Response("<html>sign in</html>", { status: 200 })));
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(2);
    expect(readState(dir).lastError).toContain("without a batch result");
  });

  it("reads a batch result with long rejection reasons for every event", async () => {
    queue(500);
    const rejected = Array.from({ length: 500 }, (_, index) => ({
      index,
      reason: "r".repeat(140),
    }));
    answer(200, { accepted: 0, duplicates: 0, rejected });
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).lastError).toBe("500 events rejected by the backend");
  });

  it("reports the drop count once, then clears it", async () => {
    queue(1);
    updateState({ droppedSinceLastSend: 7 }, dir);
    answer(200, { accepted: 1, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect(sentBodies()[0].droppedSinceLastSend).toBe(7);
    expect(readState(dir).droppedSinceLastSend).toBe(0);
  });

  it("keeps drops counted while a batch was in flight for the next one", async () => {
    queue(1);
    updateState({ droppedSinceLastSend: 7 }, dir);
    fetchMock = vi.fn(() => {
      updateState({ droppedSinceLastSend: 10 }, dir);
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), { status: 200 }),
      );
    });
    await flushOnce(ctx());
    expect(readState(dir).droppedSinceLastSend).toBe(3);
  });

  it("drops rejected envelopes with the batch and records that some were rejected", async () => {
    queue(2);
    answer(200, { accepted: 1, duplicates: 0, rejected: [{ index: 1, reason: "missing_field" }] });
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).lastError).toContain("1 events rejected");
  });

  it("caps a batch at 500 events", async () => {
    queue(501);
    answer(200, { accepted: 500, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect((sentBodies()[0].events as unknown[]).length).toBe(500);
    expect(listPending(dir)).toHaveLength(1);
  });

  it("caps a batch at 512 KB", async () => {
    for (let i = 0; i < 3; i++)
      enqueue({ event_id: `big-${i}`, pad: "x".repeat(200 * 1024) }, dir, NOW - 120_000 + i);
    answer(200, { accepted: 2, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect((sentBodies()[0].events as unknown[]).length).toBe(2);
    expect(listPending(dir)).toHaveLength(1);
  });

  it.each([
    408, 425, 429, 499, 500, 502, 503, 504,
  ])("keeps the batch and backs off on %i", async (status) => {
    queue(2);
    answer(status);
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(2);
    const state = readState(dir);
    expect(state.attempts).toBe(1);
    expect(state.nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("keeps the batch and backs off when the request never completes", async () => {
    queue(1);
    fetchMock = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(1);
    expect(readState(dir).nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("honours a Retry-After the backend names", async () => {
    queue(1);
    answer(429, undefined, { "retry-after": "120" });
    await flushOnce(ctx());
    expect(readState(dir).nextAttemptAt).toBe(NOW + 120_000);
  });

  it("clears the backoff after a success", async () => {
    queue(1);
    updateState({ attempts: 4, nextAttemptAt: NOW - 1 }, dir);
    answer(200, { accepted: 1, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect(readState(dir)).not.toHaveProperty("nextAttemptAt");
    expect(readState(dir).attempts).toBe(0);
  });

  it.each([401, 403])("keeps the queue, marks the token and pauses on %i", async (status) => {
    queue(2);
    answer(status);
    expect(await flushOnce(ctx())).toBe("stop");
    expect(writeMarkerMock).toHaveBeenCalledWith(status);
    expect(listPending(dir)).toHaveLength(2);
    expect(readState(dir).nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("halves the batch on 413 and drops a single event that is still too large", async () => {
    queue(4);
    answer(413);
    expect(await flushOnce(ctx())).toBe("sent");
    expect(readState(dir).maxBatch).toBe(2);
    expect(listPending(dir)).toHaveLength(4);

    updateState({ maxBatch: 1 }, dir);
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toHaveLength(3);
  });

  it.each([
    301, 307, 308,
  ])("keeps the queue and pauses on a %i rather than follow it", async (status) => {
    queue(2);
    answer(status, undefined, { location: "https://elsewhere.test/ingest/batch" });
    expect(await flushOnce(ctx())).toBe("stop");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listPending(dir)).toHaveLength(2);
    expect(readState(dir).lastError).toContain("redirected");
    expect(readState(dir).nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("keeps a batch size a 413 taught for a day, then tries full batches again", async () => {
    queue(4);
    updateState({ maxBatch: 2, maxBatchUntil: NOW + 60_000 }, dir);
    answer(200, { accepted: 2, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect((sentBodies()[0].events as unknown[]).length).toBe(2);
    expect(readState(dir).maxBatch).toBe(2);

    answer(200, { accepted: 2, duplicates: 0, rejected: [] });
    await flushOnce(ctx({ now: NOW + 120_000 }));
    expect((sentBodies()[0].events as unknown[]).length).toBe(2);
    expect(listPending(dir)).toEqual([]);
  });

  it("uses full batches once the learned size has expired", async () => {
    queue(3);
    updateState({ maxBatch: 1, maxBatchUntil: NOW - 1 }, dir);
    answer(200, { accepted: 3, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect((sentBodies()[0].events as unknown[]).length).toBe(3);
  });

  it("stops single sends once the backend it was started for is no longer configured", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(202);
    expect(await flushOnce(ctx({ stillScoped: () => false }))).toBe("stop");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ends an earlier backoff and problem once single sends get answers again", async () => {
    queue(1);
    updateState(
      { batchUnsupportedUntil: NOW + 1000, attempts: 5, nextAttemptAt: NOW - 1, lastError: "old" },
      dir,
    );
    answer(202);
    await flushOnce(ctx());
    expect(readState(dir)).not.toHaveProperty("nextAttemptAt");
    expect(readState(dir)).not.toHaveProperty("lastError");
    expect(readState(dir).attempts).toBe(0);
  });

  it("keeps the queue when a TLS handshake fails, since nothing was sent", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    fetchMock = vi.fn(() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
      ),
    );
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(1);
  });

  it("drops an entry it can never read, so the queue behind it keeps moving", async () => {
    mkdirSync(join(dir, "new"), { recursive: true });
    mkdirSync(join(dir, "new", "0000000000001-held.json"));
    queue(1);
    answer(200, { accepted: 1, duplicates: 0, rejected: [] });
    expect(await flushOnce(ctx())).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listPending(dir)).toEqual([]);
  });

  it("drops the batch on any other 4xx, since sending it again changes nothing", async () => {
    queue(2);
    answer(400);
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).lastError).toContain("400");
  });

  it("drops a queued file that no longer parses instead of blocking on it", async () => {
    queue(1);
    writeFileSync(listPending(dir)[0].path, "{not json");
    answer(200, { accepted: 0, duplicates: 0, rejected: [] });
    expect(await flushOnce(ctx())).toBe("sent");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listPending(dir)).toEqual([]);
  });
});

describe("a backend without /ingest/batch", () => {
  it("takes a verdict on the first event as proof /ingest exists, and moves on", async () => {
    queue(2);
    fetchMock = vi.fn((url: string) =>
      Promise.resolve(new Response(null, { status: url.endsWith("/batch") ? 404 : 422 })),
    );
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).batchUnsupportedUntil).toBeGreaterThan(NOW);
  });

  it("does not give up on the batch route when /ingest fails too, and drops nothing", async () => {
    queue(2);
    fetchMock = vi.fn((url: string) =>
      Promise.resolve(new Response(null, { status: url.endsWith("/batch") ? 404 : 502 })),
    );
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(2);
    expect(readState(dir)).not.toHaveProperty("batchUnsupportedUntil");
  });

  it.each([404, 405])("falls back on %i to one /ingest per event, sent once", async (status) => {
    queue(2);
    fetchMock = vi.fn((url: string) =>
      Promise.resolve(new Response(null, { status: url.endsWith("/batch") ? status : 202 })),
    );
    expect(await flushOnce(ctx())).toBe("sent");

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      "https://api.test/ingest/batch",
      "https://api.test/ingest",
      "https://api.test/ingest",
    ]);
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).batchUnsupportedUntil).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it("skips the batch route while the fallback is cached", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(202);
    await flushOnce(ctx());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api.test/ingest"]);
  });

  it("never retries a single send, because /ingest promises no deduplication", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(503);
    expect(await flushOnce(ctx())).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).lastError).toBe("event dropped, backend answered 503");
  });

  it("asks for batching again when the fallback stamp predates a clock that went backwards", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 30 * 24 * 60 * 60 * 1000 }, dir);
    answer(200, { accepted: 1, duplicates: 0, rejected: [] });
    await flushOnce(ctx());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api.test/ingest/batch"]);
  });

  it("stops on a rejected token in the fallback too, keeping the event", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(401);
    expect(await flushOnce(ctx())).toBe("stop");
    expect(writeMarkerMock).toHaveBeenCalledWith(401);
    expect(listPending(dir)).toHaveLength(2);
  });

  it("keeps the queue when the connection never opened, since nothing was stored", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    fetchMock = vi.fn(() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      ),
    );
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(2);
    expect(readState(dir).nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("forgets an event whose send timed out, since the backend may have stored it", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    fetchMock = vi.fn(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
    expect(readState(dir).lastError).toContain("may have arrived");
  });

  it("keeps the event and backs off on 429", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(429, undefined, { "retry-after": "30" });
    expect(await flushOnce(ctx())).toBe("retry");
    expect(listPending(dir)).toHaveLength(1);
    expect(readState(dir).nextAttemptAt).toBe(NOW + 30_000);
  });

  it("forgets a single send that timed out at the socket, since it may have arrived", async () => {
    queue(1);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    fetchMock = vi.fn(() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }),
      ),
    );
    expect(await flushOnce(ctx())).toBe("sent");
    expect(listPending(dir)).toEqual([]);
  });

  it("records what single sends achieved even when it stops partway", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000, attempts: 6, lastError: "old" }, dir);
    answer(202);
    let checks = 0;
    expect(await flushOnce(ctx({ stillScoped: () => checks++ === 0 }))).toBe("stop");
    expect(readState(dir).attempts).toBe(0);
    expect(readState(dir)).not.toHaveProperty("lastError");
  });

  it("stops before sending once its lock was taken over", async () => {
    queue(2);
    updateState({ batchUnsupportedUntil: NOW + 1000 }, dir);
    answer(202);
    expect(await flushOnce(ctx({ lock: { refresh: () => false } }))).toBe("stop");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listPending(dir)).toHaveLength(2);
  });
});

describe("backoffMs", () => {
  it("draws from zero up to a doubling ceiling, capped at an hour", () => {
    expect(backoffMs(1, null, () => 0.999)).toBeLessThan(10_000);
    expect(backoffMs(3, null, () => 0.999)).toBeLessThan(40_000);
    expect(backoffMs(30, null, () => 0.999)).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(backoffMs(3, null, () => 0)).toBe(0);
  });

  it("measures a Retry-After date from the clock it is given", () => {
    const now = Math.floor(Date.now() / 1000) * 1000 + 10 * 60_000;
    expect(backoffMs(1, new Date(now + 90_000).toUTCString(), () => 0, now)).toBe(90_000);
  });

  it("prefers the server's Retry-After, also as a date", () => {
    expect(backoffMs(1, "30", () => 0)).toBe(30_000);
    const at = new Date(Date.now() + 90_000).toUTCString();
    expect(backoffMs(1, at, () => 0)).toBeGreaterThan(80_000);
  });
});
