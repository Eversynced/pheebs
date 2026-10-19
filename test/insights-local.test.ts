import { describe, expect, it } from "vitest";
import { developersOf, localInsights } from "../src/insights-local.js";

const TODAY = new Date("2026-10-19T12:00:00Z");

// One edit per row, each its own session, on the day given.
const row = (day: string, session_id: string, fields: Record<string, unknown> = {}) => ({
  timestamp: `${day}T10:00:00.000Z`,
  event: "tool_use_completed",
  tool_intent: "edit",
  ai_tool: "claude_code",
  session_id,
  ...fields,
});

describe("developersOf", () => {
  it("lists every distinct stamp rather than picking one", () => {
    const rows = [
      row("2026-10-13", "a", { developer: "tok-work" }),
      row("2026-10-13", "b", { developer: "tok-home" }),
      row("2026-10-14", "c", { developer: "tok-work" }),
    ];
    expect(developersOf(rows, "2026-09-19")).toEqual({
      stamps: ["tok-home", "tok-work"],
      unknown: 0,
      unstamped: 0,
    });
  });

  it("counts `unknown` and a missing stamp apart, and makes neither a developer", () => {
    const rows = [
      row("2026-10-13", "a", { developer: "tok-1" }),
      row("2026-10-13", "b", { developer: "unknown" }),
      row("2026-10-13", "c", { developer: "unknown" }),
      row("2026-10-13", "d"),
    ];
    expect(developersOf(rows, "2026-09-19")).toEqual({
      stamps: ["tok-1"],
      unknown: 2,
      unstamped: 1,
    });
  });

  it("reads only the rows from `since` on, and none without a usable time", () => {
    const rows = [
      row("2026-10-13", "a", { developer: "tok-1" }),
      row("2026-09-18", "b", { developer: "tok-old" }),
      row("2026-09-18", "c", { developer: "unknown" }),
      row("2026-09-18", "d"),
      { developer: "tok-untimed", timestamp: "never" },
    ];
    expect(developersOf(rows, "2026-09-19")).toEqual({
      stamps: ["tok-1"],
      unknown: 0,
      unstamped: 0,
    });
  });
});

describe("localInsights", () => {
  it("counts every stamp's rows and names them, rather than filtering", () => {
    const rows = [
      row("2026-10-13", "a", { developer: "tok-work" }),
      row("2026-10-13", "b", { developer: "tok-home" }),
    ];
    const payload = localInsights(rows, 30, TODAY) as Record<string, unknown>;
    expect(payload.developers).toEqual({
      stamps: ["tok-home", "tok-work"],
      unknown: 0,
      unstamped: 0,
    });
    // Both sessions are in the denominator: neither edit was verified.
    const signals = (payload.sections as Record<string, Record<string, unknown>>).judgement_signals;
    expect(signals.verification_coverage).toEqual({ value: 0, unit: "share" });
  });

  it("reads stamps over the wider of the two windows the report uses", () => {
    // The first day of Repertoire's four weeks, before the window a short `days` opens.
    const rows = [
      row("2026-10-13", "a", { developer: "tok-1" }),
      row("2026-09-22", "b", { developer: "tok-2" }),
      row("2026-09-10", "c", { developer: "tok-old" }),
    ];
    const stamps = (days: number) =>
      (localInsights(rows, days, TODAY).developers as { stamps: string[] }).stamps;
    expect(stamps(7)).toEqual(["tok-1", "tok-2"]);
    expect(stamps(30)).toEqual(["tok-1", "tok-2"]);
    expect(stamps(45)).toEqual(["tok-1", "tok-2", "tok-old"]);
  });
});
