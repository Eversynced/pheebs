import { describe, expect, it } from "vitest";
import { verificationCoverage } from "../src/verification.js";

const TODAY = new Date("2026-10-19T12:00:00Z");

type Fields = Record<string, unknown>;

// One session in order, an hour apart, each step an event and its fields.
function session(id: string, day: string, ...steps: [string, Fields?][]): Fields[] {
  return steps.map(([event, fields], i) => ({
    timestamp: `${day}T1${i}:00:00.000Z`,
    event,
    ai_tool: "claude_code",
    session_id: id,
    ...fields,
  }));
}

const edit: [string, Fields] = ["tool_use_completed", { tool_intent: "edit" }];
const test: [string, Fields] = ["tool_use_failed", { tool_intent: "test_run" }];
const lint: [string, Fields] = ["tool_use_completed", { tool_intent: "lint" }];
const askLabeled: [string, Fields] = [
  "prompt_submitted",
  { requests_verification: true, classifier_version: "v3" },
];

describe("verificationCoverage", () => {
  it("is the share of edited sessions where a check followed an edit", () => {
    const rows = [
      ...session("a", "2026-10-13", edit, test),
      ...session("b", "2026-10-13", edit, lint),
      // A check before any change verified nothing the AI wrote.
      ...session("c", "2026-10-13", lint, edit),
      ...session("d", "2026-10-13", edit),
      // No edit, so not in the denominator.
      ...session("e", "2026-10-13", lint),
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ value: 0.5, unit: "share" });
  });

  it("has nothing to say without an edited session, rather than a zero", () => {
    const rows = session("a", "2026-10-13", lint);
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ reason: "insufficient_data" });
  });

  it("withholds the signal when a labeled request alone could have verified a session", () => {
    const rows = [
      ...session("a", "2026-10-13", edit, test),
      ...session("b", "2026-10-13", edit, askLabeled),
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ reason: "needs_classifier_gate" });
  });

  it("decides without the gate when no request needs it", () => {
    const rows = [
      // Already verified by a tool, so its label changes nothing.
      ...session("a", "2026-10-13", edit, askLabeled, test),
      // No classifier version: no backend would count it as a labeled request either.
      ...session("b", "2026-10-13", edit, ["prompt_submitted", { requests_verification: true }]),
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ value: 0.5, unit: "share" });
  });

  it("dates a session by its last event and reads it whole", () => {
    const rows = [
      // Began before the window and ended in it: its earlier edit still counts.
      ...session("a", "2026-09-10", edit),
      ...session("a", "2026-10-13", test),
      // Ended before the window.
      ...session("b", "2026-09-10", edit),
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ value: 1, unit: "share" });
    expect(verificationCoverage(rows, 3, TODAY)).toEqual({ reason: "insufficient_data" });
  });

  it("reports a weekly trend, oldest first, only from two weeks up", () => {
    const rows = [
      ...session("a", "2026-10-06", edit, test),
      ...session("b", "2026-10-06", edit),
      ...session("c", "2026-10-13", edit, test),
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({
      value: 2 / 3,
      unit: "share",
      trend: [0.5, 1],
    });
  });

  it("leaves manual scans and rows without a usable time out", () => {
    const rows = [
      ...session("a", "2026-10-13", edit, test),
      ...session("scan", "2026-10-13", edit),
      { event: "tool_use_completed", tool_intent: "edit", session_id: "x", timestamp: "never" },
    ];
    expect(verificationCoverage(rows, 30, TODAY)).toEqual({ value: 1, unit: "share" });
  });
});
