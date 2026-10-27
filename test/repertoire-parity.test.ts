import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAYS, localInsights } from "../src/insights-local.js";

interface ParityCase {
  name: string;
  known_divergence?: boolean;
  today: string;
  events: Record<string, unknown>[];
  expected: Record<string, unknown>;
}

// The backend vendors this file and runs the same events through its views and its /insights
// route, so a Repertoire rule changed on one side alone fails a test on one side or the other.
const { cases } = JSON.parse(
  readFileSync(new URL("./fixtures/repertoire-parity.json", import.meta.url), "utf-8"),
) as { cases: ParityCase[] };

const sectionOf = ({ events, today }: ParityCase) =>
  (localInsights(events, DEFAULT_DAYS, new Date(today)).sections as Record<string, unknown>)
    .repertoire;

describe("repertoire section from the shared parity fixture", () => {
  it.each(cases.filter((c) => !c.known_divergence))("$name", (c) => {
    expect(sectionOf(c)).toEqual(c.expected);
  });

  // The client still reads a plan on a model nothing names as Insufficient data, not Unobserved.
  it.fails.each(cases.filter((c) => c.known_divergence))("$name", (c) => {
    expect(sectionOf(c)).toEqual(c.expected);
  });
});
