// Target: test/repertoire-parity.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAYS, localInsights } from "../src/insights-local.js";

interface ParityCase {
  name: string;
  today: string;
  events: Record<string, unknown>[];
  expected: Record<string, unknown>;
}

// The backend vendors this file and runs the same events through its views and its /insights
// route, so a Repertoire rule changed on one side alone fails a test on one side or the other.
const { cases } = JSON.parse(
  readFileSync(new URL("./fixtures/repertoire-parity.json", import.meta.url), "utf-8"),
) as { cases: ParityCase[] };

describe("repertoire section from the shared parity fixture", () => {
  it.each(cases)("$name", ({ today, events, expected }) => {
    const report = localInsights(events, DEFAULT_DAYS, new Date(today));
    expect((report.sections as Record<string, unknown>).repertoire).toEqual(expected);
  });
});
