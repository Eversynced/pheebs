import { describe, expect, it } from "vitest";
import { newEventId } from "../src/event-id.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newEventId", () => {
  it("is a version 7, RFC variant UUID", () => {
    expect(newEventId()).toMatch(UUID_V7);
  });

  it("carries the millisecond timestamp in its first 48 bits", () => {
    // The generator never goes backwards, so each case here runs further in the future.
    const at = Date.now() + 1_000_000;
    const id = newEventId(at);
    expect(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(at);
  });

  it("increases strictly within one millisecond, past the counter's range", () => {
    const at = Date.now() + 2_000_000;
    const ids = Array.from({ length: 5000 }, () => newEventId(at));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(UUID_V7);
  });

  it("never goes backwards when the clock does", () => {
    const later = Date.now() + 3_000_000;
    const first = newEventId(later);
    const second = newEventId(later - 1000);
    expect(second > first).toBe(true);
  });
});
