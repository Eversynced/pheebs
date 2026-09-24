import { describe, expect, it } from "vitest";
import { escapeControlChars, normalize } from "../src/insights-normalize.js";

// Built with fromCharCode so the source carries no invisible bytes of its own.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
const OSC8 = String.fromCharCode(0x9d);
const ST8 = String.fromCharCode(0x9c);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdfff);
// Matches an orphan of either half, which is what must never survive normalization.
const SURROGATE_ORPHAN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// A real hole, built rather than written as a sparse literal: `every` skips holes, so the guard
// has to be tested against one.
function withHole(): unknown[] {
  const sparse: unknown[] = [];
  sparse[2] = 1;
  return sparse;
}

const repertoire = (fields: Record<string, unknown>) => ({
  days: 30,
  sections: { repertoire: { enabled: true, ...fields } },
});

const signal = (fields: Record<string, unknown>) => ({
  days: 30,
  sections: { judgement_signals: { enabled: true, pushback_rate: { unit: "share", ...fields } } },
});

function firstCompetency(payload: unknown) {
  const body = normalize(payload).sections[0]?.body;
  return body?.kind === "repertoire" ? body.data.competencies[0] : undefined;
}

function firstSignal(payload: unknown) {
  const body = normalize(payload).sections[0]?.body;
  return body?.kind === "signals" ? body.data[0] : undefined;
}

function costOf(payload: unknown) {
  const body = normalize(payload).sections[0]?.body;
  return body?.kind === "cost" ? body.data : undefined;
}

describe("normalize — is total", () => {
  const hostile: [string, unknown][] = [
    ["null", null],
    ["a number", 42],
    ["a string", "hello"],
    ["an array", [1, 2, 3]],
    ["a null sections map", { sections: null }],
    ["sections as an array", { sections: [1, 2] }],
    ["a null section", { sections: { repertoire: null } }],
    ["a string section", { sections: { cost: "nope" } }],
    ["a null signal", signal({ value: null })],
    ["competencies as a string", repertoire({ competencies: "abc" })],
    ["null inside competencies", repertoire({ competencies: [null] })],
    ["a sparse competencies array", repertoire({ competencies: withHole() })],
    ["savings as a string", { sections: { cost: { enabled: true, savings: "x" } } }],
    ["null inside savings", { sections: { cost: { enabled: true, savings: [null] } } }],
    ["an inherited state", repertoire({ competencies: [{ name: "X", state: "constructor" }] })],
    ["an inherited reason", { sections: { repertoire: { enabled: false, reason: "__proto__" } } }],
  ];

  it.each(hostile)("survives %s", (_label, payload) => {
    expect(() => normalize(payload)).not.toThrow();
  });

  it("hands back a report shaped the same way whatever it was given", () => {
    for (const [, payload] of hostile) {
      const report = normalize(payload);
      expect(Array.isArray(report.sections)).toBe(true);
      expect(typeof report.unrecognized).toBe("number");
    }
  });
});

describe("normalize — strings a terminal would execute", () => {
  it("strips 7-bit escape sequences", () => {
    const name = `Models${ESC}]52;c;ZXZpbA==${BEL}${ESC}[8m`;
    expect(
      firstCompetency(repertoire({ competencies: [{ name, state: "recurring" }] }))?.name,
    ).toBe("Models");
  });

  // The 8-bit forms carry no ESC byte at all, so a filter that only looks for ESC misses them.
  it("strips 8-bit control introducers", () => {
    const name = `Models${OSC8}52;c;x${ST8}${CSI8}2K`;
    const cleaned = firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name;
    expect(cleaned).not.toContain(OSC8);
    expect(cleaned).not.toContain(CSI8);
    expect(cleaned).not.toContain(ST8);
  });

  it("strips bidi overrides and line separators, which redraw a label as other text", () => {
    const name = `safe${RTL_OVERRIDE}EVIL${LINE_SEPARATOR}next`;
    const cleaned = firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name;
    expect(cleaned).not.toContain(RTL_OVERRIDE);
    expect(cleaned).not.toContain(LINE_SEPARATOR);
  });

  // `string-width` measures an orphaned surrogate as nothing while a terminal draws a replacement
  // glyph for it, so a row of them would be drawn far wider than the column it was measured into.
  it("strips a surrogate with no partner, which is measured as nothing but drawn as a glyph", () => {
    // Kept apart on purpose: adjacent, the two halves would be a valid pair and real text.
    const name = `Models${LONE_HIGH}mid${LONE_LOW}ok`;
    const cleaned = firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name;
    expect(cleaned).toBe("Modelsmidok");
  });

  it("keeps a pair whole, including one that straddles the length bound", () => {
    const name = `${"a".repeat(199)}${"\u{1FAE0}".repeat(4)}`;
    const cleaned = firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name;
    expect(cleaned).toBe(`${"a".repeat(199)}\u{1FAE0}`);
    expect([...(cleaned ?? "")].every((ch) => ch.codePointAt(0) !== undefined)).toBe(true);
    expect(cleaned).not.toMatch(SURROGATE_ORPHAN);
  });

  it("leaves ordinary text, including joiners that are real content", () => {
    const name = "Context management ‍ ok";
    expect(firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name).toContain(
      "‍",
    );
  });
});

describe("normalize — bounds", () => {
  it("caps rows and says how many it dropped", () => {
    const competencies = Array.from({ length: 5_000 }, (_, i) => ({ name: `c${i}`, state: "x" }));
    const section = normalize(repertoire({ competencies })).sections[0];
    const body = section.body;
    expect(body.kind).toBe("repertoire");
    if (body.kind === "repertoire") expect(body.data.competencies.length).toBe(200);
    expect(section.dropped).toBe(4_800);
  });

  it("caps a single string, so one field cannot fill a terminal", () => {
    const name = "x".repeat(100_000);
    expect(firstCompetency(repertoire({ competencies: [{ name, state: "x" }] }))?.name.length).toBe(
      200,
    );
  });

  it("refuses a trend longer than a year of weeks rather than drawing it", () => {
    const trend = Array.from({ length: 5_000 }, () => 0.5);
    expect(firstSignal(signal({ trend }))?.trendUnusable).toBe(true);
  });
});

describe("normalize — a trend is plotted whole or not at all", () => {
  it("treats an absent trend as absent, not as broken", () => {
    for (const trend of [undefined, null]) {
      const s = firstSignal(signal({ trend }));
      expect(s?.trend).toEqual([]);
      expect(s?.trendUnusable).toBe(false);
    }
  });

  it("marks a non-array, a hole, and a non-number as unusable", () => {
    for (const trend of [5, "abc", [0.1, null, 0.3], [0.1, "x"], withHole()]) {
      expect(firstSignal(signal({ trend }))?.trendUnusable).toBe(true);
    }
  });

  // A span past Number.MAX_VALUE cannot be scaled onto the ramp, and a partial chart would lose
  // weeks while the endpoints still claimed the whole series.
  it("marks a span too wide to scale as unusable", () => {
    const trend = [-1.7e308, 0, 1.7e308];
    expect(firstSignal(signal({ trend }))?.trendUnusable).toBe(true);
  });

  it("keeps a usable series intact", () => {
    expect(firstSignal(signal({ trend: [0.1, 0.2, 0.3] }))?.trend).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("normalize — numbers the schema bounds", () => {
  it("drops a share outside 0..1", () => {
    for (const recurring_share of [5, -1, Number.NaN, "0.5", null]) {
      expect(
        firstCompetency(repertoire({ competencies: [{ name: "X", state: "x", recurring_share }] }))
          ?.share,
      ).toBeUndefined();
    }
    expect(
      firstCompetency(
        repertoire({ competencies: [{ name: "X", state: "x", recurring_share: 0.5 }] }),
      )?.share,
    ).toBe(0.5);
  });

  it("drops a negative count", () => {
    const body = normalize(repertoire({ sessions: -4, artifact_breadth: -9 })).sections[0].body;
    if (body.kind === "repertoire") {
      expect(body.data.sessions).toBeUndefined();
      expect(body.data.artifactBreadth).toBeUndefined();
    }
  });

  // Every field these carry is `integer` in openapi.yaml, and a fraction reaching the report
  // renders as a fact ("Sessions: 12.5") and draws a gauge against a denominator no one can have.
  it("drops a fractional count", () => {
    const body = normalize(
      repertoire({
        sessions: 12.5,
        active_weeks: 3.7,
        coverage_index: { recurring: 3.5, applicable: 10.5 },
      }),
    ).sections[0].body;
    expect(body.kind).toBe("repertoire");
    if (body.kind === "repertoire") {
      expect(body.data.sessions).toBeUndefined();
      expect(body.data.activeWeeks).toBeUndefined();
      expect(body.data.recurring).toBeUndefined();
      expect(body.data.applicable).toBeUndefined();
    }
  });

  it("reports a window only when it is a whole positive number of days", () => {
    expect(normalize({ days: 30, sections: {} }).days).toBe(30);
    for (const days of [0, -5, 1.5, "abc", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalize({ days, sections: {} }).days).toBeUndefined();
    }
  });
});

describe("normalize — the cost basis", () => {
  const withBasis = (basis: unknown) => ({
    days: 30,
    sections: { cost: { enabled: true, basis, savings: [{ model: "m", usd: 1, sessions: 1 }] } },
  });

  it("keeps a real basis", () => {
    const cost = costOf(withBasis("API list-price equivalent"));
    expect(cost?.basis).toBe("API list-price equivalent");
    expect(cost?.basisSupplied).toBe(true);
  });

  // A blank basis must not defeat the fallback: a bare figure reads as money already saved.
  it("falls back for one that is absent, blank, or nothing but escapes", () => {
    for (const basis of [undefined, "", "   \t ", `${ESC}[31m${ESC}[0m`, 42, null]) {
      const cost = costOf(withBasis(basis));
      expect(cost?.basisSupplied).toBe(false);
      expect(cost?.basis).toContain("not money already saved");
    }
  });
});

describe("normalize — what the map contained", () => {
  it("counts sections this version does not render", () => {
    const report = normalize({ sections: { velocity: { enabled: true }, throughput: {} } });
    expect(report.sections).toHaveLength(0);
    expect(report.unrecognized).toBe(2);
  });

  it("does not count the ones it does render", () => {
    const report = normalize({ sections: { repertoire: { enabled: true }, velocity: {} } });
    expect(report.sections).toHaveLength(1);
    expect(report.unrecognized).toBe(1);
  });

  it("treats a section that never says it is on as off", () => {
    const body = normalize({ sections: { cost: { reason: "no_consent" } } }).sections[0].body;
    expect(body.kind).toBe("unavailable");
    if (body.kind === "unavailable") expect(body.reason).toBe("no_consent");
  });

  it("resolves only the reasons the contract defines", () => {
    for (const reason of ["__proto__", "constructor", "", "moon_phase", 42]) {
      const body = normalize({ sections: { cost: { enabled: false, reason } } }).sections[0].body;
      if (body.kind === "unavailable") expect(body.reason).toBeUndefined();
    }
  });
});

describe("escapeControlChars", () => {
  // Legal JSON whitespace, and a terminal draws whatever follows it over the line already there.
  it("drops a carriage return from the whitespace between tokens", () => {
    const body = `{"sections":{}${String.fromCharCode(13)}   ,"spoofed":0}`;
    const escaped = escapeControlChars(body);
    expect(escaped).not.toContain(String.fromCharCode(13));
    expect(JSON.parse(escaped)).toEqual(JSON.parse(body));
  });

  const parses = (body: string) => JSON.stringify(JSON.parse(body));

  it("escapes a control character inside a string", () => {
    const body = `{"a":"x${OSC8}52;c;y${ST8}"}`;
    const out = escapeControlChars(body);
    expect(out).not.toContain(OSC8);
    expect(out).toContain("\\u009d");
    expect(parses(out)).toBe(parses(body));
  });

  it("leaves whitespace between tokens alone, which JSON needs", () => {
    const body = '{\n  "a": 1,\n\t"b": 2\n}';
    expect(escapeControlChars(body)).toBe(body);
  });

  it("does not touch an already-escaped sequence", () => {
    const body = '{"a":"line\\u001b end\\\\"}';
    expect(escapeControlChars(body)).toBe(body);
  });

  it("keeps key order and every other byte", () => {
    const body = '{"z":1,"a":{"m":[1,2,3]},"k":"v"}';
    expect(escapeControlChars(body)).toBe(body);
  });

  it("handles a quote escaped inside a string without losing track of the string", () => {
    const body = `{"a":"he said \\"hi\\"","b":"x${CSI8}y"}`;
    const out = escapeControlChars(body);
    expect(out).toContain("\\u009b");
    expect(parses(out)).toBe(parses(body));
  });
});
