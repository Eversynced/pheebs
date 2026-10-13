import { describe, expect, it } from "vitest";
import { normalizeTeam, type TeamReport, type ViewBody } from "../src/insights-team-normalize.js";
import { ALL_OFF, WINDOW_90, WITH_REPERTOIRE } from "./fixtures/team-insights.js";

function view(report: TeamReport, section: string, title: string): ViewBody {
  const found = report.sections.find((s) => s.label === section);
  if (found?.body.kind !== "views") throw new Error(`${section} is not a list of views`);
  const body = found.body.views.find((v) => v.title === title)?.body;
  if (!body) throw new Error(`no ${title} view`);
  return body;
}

describe("normalizeTeam: the envelope", () => {
  it("reads the window and the cohort", () => {
    const report = normalizeTeam(WINDOW_90);
    expect(report.days).toBe(90);
    expect(report.cohort).toEqual({ kind: "tenant", engineers: 2, name: "Eversynced" });
  });

  it("is total over anything", () => {
    for (const input of [null, undefined, 4, "x", [], { sections: 3 }, { team: [] }]) {
      expect(normalizeTeam(input).sections).toEqual([]);
    }
  });

  it("keeps a cohort kind it does not know and drops nothing about it", () => {
    const report = normalizeTeam({ team: { kind: "squad", engineers: 3 }, sections: {} });
    expect(report.cohort).toEqual({ kind: "squad", engineers: 3, name: undefined });
  });

  it("counts the sections it does not render rather than failing on them", () => {
    const report = normalizeTeam({
      sections: { repertoire: { enabled: false }, retention: { enabled: true, rows: [] } },
    });
    expect(report.sections).toHaveLength(1);
    expect(report.unrecognized).toBe(1);
  });

  it("treats a section or view that does not say it is on as off", () => {
    const report = normalizeTeam({
      sections: { repertoire: { adoption_funnel: { practices: [] } } },
    });
    expect(report.sections[0].body).toEqual({ kind: "unavailable", reason: undefined });
    const nested = normalizeTeam({
      sections: { repertoire: { enabled: true, adoption_funnel: { practices: [] } } },
    });
    expect(view(nested, "Repertoire", "Adoption funnel")).toEqual({
      kind: "unavailable",
      reason: undefined,
    });
  });

  it("keeps a reason it knows and drops one it does not", () => {
    const report = normalizeTeam(ALL_OFF);
    expect(report.sections[1].body).toEqual({ kind: "unavailable", reason: "no_consent" });
    const odd = normalizeTeam({ sections: { repertoire: { enabled: false, reason: "lunch" } } });
    expect(odd.sections[0].body).toEqual({ kind: "unavailable", reason: undefined });
  });

  it("ignores views and keys it does not know", () => {
    const report = normalizeTeam({
      sections: {
        repertoire: {
          enabled: true,
          surprise_view: { enabled: true, rows: [1] },
          adoption_funnel: {
            enabled: true,
            practices: [{ name: "Models", unobserved: 1, adopted: 1, recurring: 1, extra: 9 }],
            new_key: "x",
          },
        },
      },
    });
    const section = report.sections[0].body;
    if (section.kind !== "views") throw new Error("expected views");
    expect(section.views.map((v) => v.title)).toEqual(["Adoption funnel"]);
  });
});

describe("normalizeTeam: repertoire views", () => {
  const repertoire = normalizeTeam(WITH_REPERTOIRE);

  it("reads the fourth funnel count when present and leaves it unset when not", () => {
    const funnel = view(repertoire, "Repertoire", "Adoption funnel");
    if (funnel.kind !== "funnel") throw new Error("expected a funnel");
    expect(funnel.data[0]).toEqual({
      name: "Models",
      unobserved: 2,
      adopted: 1,
      recurring: 1,
      insufficientData: 1,
    });

    const plain = normalizeTeam({
      sections: {
        repertoire: {
          enabled: true,
          adoption_funnel: {
            enabled: true,
            practices: [{ name: "Models", unobserved: 2, adopted: 2, recurring: 5 }],
          },
        },
      },
    });
    const body = view(plain, "Repertoire", "Adoption funnel");
    if (body.kind !== "funnel") throw new Error("expected a funnel");
    expect(body.data[0].insufficientData).toBeUndefined();
  });

  it("does not report a count that is not a whole number", () => {
    const report = normalizeTeam({
      sections: {
        repertoire: {
          enabled: true,
          adoption_funnel: {
            enabled: true,
            practices: [{ name: "Models", unobserved: -1, adopted: 1.5, recurring: "3" }],
          },
        },
      },
    });
    const body = view(report, "Repertoire", "Adoption funnel");
    if (body.kind !== "funnel") throw new Error("expected a funnel");
    expect(body.data[0]).toMatchObject({
      unobserved: undefined,
      adopted: undefined,
      recurring: undefined,
    });
  });

  it("aligns heatmap cells to the column order, leaving a gap for a missing cell", () => {
    const heatmap = view(repertoire, "Repertoire", "Practice heatmap");
    if (heatmap.kind !== "heatmap") throw new Error("expected a heatmap");
    const dwight = heatmap.data.engineers.find((e) => e.developer === "dwight");
    expect(dwight?.states).toEqual([
      "recurring",
      "adopted",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(heatmap.data.named).toBe(3);
    expect(heatmap.data.withheld).toBe(2);
  });

  it("looks cells up by name, not by position", () => {
    const report = normalizeTeam({
      sections: {
        repertoire: {
          enabled: true,
          practice_heatmap: {
            enabled: true,
            competencies: ["Models", "MCP"],
            engineers: [{ developer: "a", competencies: [{ name: "MCP", state: "recurring" }] }],
          },
        },
      },
    });
    const body = view(report, "Repertoire", "Practice heatmap");
    if (body.kind !== "heatmap") throw new Error("expected a heatmap");
    expect(body.data.engineers[0].states).toEqual([undefined, "recurring"]);
  });

  it("reads every team stat as optional", () => {
    const stats = view(repertoire, "Repertoire", "Team stats");
    if (stats.kind !== "stats") throw new Error("expected stats");
    expect(stats.data.repos).toBe(2);
    expect(stats.data.connectors?.[1]).toMatchObject({ name: "Github", engineers: 1 });
    expect(stats.data.connectors?.[1].reads).toBeUndefined();
    expect(stats.data.evalRepos).toBeUndefined();

    const bare = normalizeTeam({
      sections: { repertoire: { enabled: true, team_stats: { enabled: true } } },
    });
    expect(view(bare, "Repertoire", "Team stats")).toEqual({
      kind: "stats",
      data: {
        repos: undefined,
        skills: undefined,
        subagents: undefined,
        connectors: undefined,
        artifactTypes: undefined,
        mcpRepos: undefined,
        evalRepos: undefined,
      },
    });
  });
});

describe("normalizeTeam: judgement views", () => {
  const judgement = normalizeTeam(WITH_REPERTOIRE);

  it("keeps a signal cell a row leaves out as a gap", () => {
    const body = view(judgement, "Judgement signals", "Signals by engineer");
    if (body.kind !== "byEngineer") throw new Error("expected signals");
    expect(body.data.engineers[1].cells).toEqual([0.9, undefined]);
    expect(body.data.median).toEqual([0.62, 2.5]);
  });

  it("reads an empty median as not reported rather than a row of gaps", () => {
    const body = view(normalizeTeam(WINDOW_90), "Judgement signals", "Signals by engineer");
    if (body.kind !== "byEngineer") throw new Error("expected signals");
    expect(body.data.median).toBeUndefined();
  });

  it("falls back to the keys it was sent when no column order is declared", () => {
    const report = normalizeTeam({
      sections: {
        judgement_signals: {
          enabled: true,
          signals_by_engineer: {
            enabled: true,
            engineers: [{ developer: "a", signals: [{ key: "novel_signal", value: 3 }] }],
          },
        },
      },
    });
    const body = view(report, "Judgement signals", "Signals by engineer");
    if (body.kind !== "byEngineer") throw new Error("expected signals");
    expect(body.data.columns).toEqual([{ key: "novel_signal", unit: "", label: "novel_signal" }]);
  });

  it("drops an annotation pinned outside the trend rather than clamping it", () => {
    const body = view(judgement, "Judgement signals", "Median movement");
    if (body.kind !== "movement") throw new Error("expected movement");
    expect(body.data[0].notes).toEqual([
      { index: 2, text: "Added a test skill to the shared repo" },
    ]);
  });

  it("refuses a numerator past its denominator", () => {
    const report = normalizeTeam({
      sections: {
        judgement_signals: {
          enabled: true,
          wholesale_watch: {
            enabled: true,
            lines: { this_window: { unchallenged: 20, total: 18 } },
            sessions: { this_window: { unchallenged: 1, total: 2 } },
          },
        },
      },
    });
    const body = view(report, "Judgement signals", "Wholesale watch");
    if (body.kind !== "wholesale") throw new Error("expected wholesale");
    expect(body.data.lines.thisWindow).toBeUndefined();
    expect(body.data.sessions.thisWindow).toEqual({ unchallenged: 1, total: 2 });
  });

  it("supplies a basis when the backend leaves it out, so a figure is never bare", () => {
    const report = normalizeTeam({
      sections: {
        judgement_signals: { enabled: true, dollar_savings: { enabled: true, opportunity: 5 } },
      },
    });
    const body = view(report, "Judgement signals", "Dollar savings");
    if (body.kind !== "dollars") throw new Error("expected dollars");
    expect(body.data.basis).toContain("not money already saved");
  });
});

describe("normalizeTeam: untrusted text", () => {
  it("strips terminal escapes from every string it carries", () => {
    const report = normalizeTeam({
      team: { kind: "tenant\u001b]52;c;eA==\u0007", engineers: 1, name: "Acme\u001b[2J" },
      sections: {
        repertoire: {
          enabled: true,
          practice_heatmap: {
            enabled: true,
            competencies: ["Mod\u001b[31mels"],
            engineers: [{ developer: "bob\u009b2J", competencies: [] }],
          },
        },
      },
    });
    // JSON escapes a control character as text, so a surviving one shows up as `\u001b`.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/\\u00(1b|9b|07)/);
    expect(serialized).toContain("Acme");
  });
});
