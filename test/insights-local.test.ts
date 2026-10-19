import { describe, expect, it } from "vitest";
import { developersOf, localInsights } from "../src/insights-local.js";

describe("developersOf", () => {
  it("lists every distinct stamp rather than picking one", () => {
    const rows = [{ developer: "tok-work" }, { developer: "tok-home" }, { developer: "tok-work" }];
    expect(developersOf(rows)).toEqual({ stamps: ["tok-home", "tok-work"], unstamped: 0 });
  });

  it("counts a row with no stamp, an empty one, or `unknown` as unstamped, never as a developer", () => {
    const rows = [{ developer: "tok-1" }, {}, { developer: "" }, { developer: "unknown" }, 7];
    expect(developersOf(rows)).toEqual({ stamps: ["tok-1"], unstamped: 4 });
  });

  it("filters nothing out of the counts it sits beside", () => {
    const at = new Date("2026-10-19T12:00:00Z");
    const row = (developer: string, session_id: string) => ({
      timestamp: "2026-10-13T10:00:00.000Z",
      event: "tool_use_completed",
      tool_intent: "edit",
      ai_tool: "claude_code",
      session_id,
      developer,
    });
    const rows = [row("tok-work", "a"), row("tok-home", "b")];
    const payload = localInsights(rows, 30, at) as Record<string, unknown>;
    expect(payload.developers).toEqual({ stamps: ["tok-home", "tok-work"], unstamped: 0 });
    // Both sessions are in the denominator: neither edit was verified.
    const signals = (payload.sections as Record<string, Record<string, unknown>>).judgement_signals;
    expect(signals.verification_coverage).toEqual({ value: 0, unit: "share" });
  });
});
