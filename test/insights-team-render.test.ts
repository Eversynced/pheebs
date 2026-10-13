import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/insights-render.js";
import { normalizeTeam } from "../src/insights-team-normalize.js";
import { renderTeamInsights } from "../src/insights-team-render.js";
import { ALL_OFF, WINDOW_28, WINDOW_90, WITH_REPERTOIRE } from "./fixtures/team-insights.js";

const WIDE = { width: 80, ascii: false };

function render(payload: unknown, opts = WIDE): string {
  return renderTeamInsights(normalizeTeam(payload), opts).join("\n");
}

describe("renderTeamInsights: the cohort", () => {
  it("names the window and the cohort", () => {
    const out = render(WINDOW_90);
    expect(out).toContain("Your team, last 90 days");
    expect(out).toContain("Eversynced (tenant, 2 engineers)");
  });

  it("prints a cohort kind it does not know rather than refusing", () => {
    expect(render({ days: 1, team: { kind: "squad", engineers: 1 }, sections: {} })).toContain(
      "Cohort (squad, 1 engineer)",
    );
  });

  it("says a backend with no sections produces none", () => {
    expect(render({ sections: {} })).toContain("no team sections");
    expect(render({ sections: { retention: { enabled: true } } })).toContain(
      "1 section(s) that this version of pheebs does not render",
    );
  });
});

describe("renderTeamInsights: the live 90-day payload", () => {
  const out = render(WINDOW_90);

  it("renders the section that is off as one reason line", () => {
    expect(out).toContain("Repertoire: this backend does not produce it");
  });

  it("renders the engineer table with a gap, not a zero, for a signal the row lacks", () => {
    const row = out.split("\n").find((l) => l.includes("gustavo"));
    expect(row).toMatch(/50%\s+14%\s+2\.2 : 1\s+0%\s+-$/);
  });

  it("says the median was not reported, and the count of named and withheld engineers", () => {
    expect(out).toContain("Team median: not reported.");
    expect(out).toContain("Engineers: 1 named, 0 withheld (opted out)");
  });

  it("renders a view that is off with its reason and no figure", () => {
    expect(out).toContain("Median movement: not enough sessions yet to say anything");
  });

  it("renders wholesale watch as parts over totals", () => {
    expect(out).toMatch(/Lines that shipped unchallenged\s+0 of 18/);
    expect(out).toMatch(/Sessions that shipped unchallenged\s+0 of 2/);
    expect(out).toContain("never ran: 3");
    expect(out).toMatch(/Eversynced\/pheebs\s+0 of 18/);
    expect(out).not.toContain("Window before");
  });

  it("puts coverage above the dollars and prints the basis even with no figure", () => {
    expect(out).toMatch(/No usage telemetry\s+28/);
    expect(out).toContain("API list-price equivalent, estimated upper bound");
    expect(out).not.toMatch(/\$\d/);
  });
});

describe("renderTeamInsights: the live 28-day payload", () => {
  const out = render(WINDOW_28);

  it("renders wholesale watch as unavailable, not as zeros", () => {
    expect(out).toContain("Wholesale watch: not enough sessions yet to say anything");
    expect(out).not.toContain("never ran");
  });

  it("renders only the signals the engineer has", () => {
    const row = out.split("\n").find((l) => l.includes("gustavo"));
    expect(row).toMatch(/100%\s+-\s+3\.1 : 1\s+-\s+-$/);
  });
});

describe("renderTeamInsights: an enabled repertoire", () => {
  const out = render(WITH_REPERTOIRE);

  it("draws the funnel with the fourth count beside the three, out of the cohort", () => {
    expect(out).toContain("Insufficient data");
    expect(out).toMatch(/Models\s+2 \/ 5\s+1 \/ 5\s+1 \/ 5\s+1 \/ 5/);
  });

  it("omits the fourth column when no row carries it", () => {
    const plain = render({
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
    expect(plain).not.toContain("Insufficient");
    expect(plain).toMatch(/Models\s+2\s+2\s+5/);
  });

  it("draws the heatmap with a gap where a row has no cell", () => {
    const dwight = out
      .split("\n")
      .find((l) => l.trimStart().startsWith("dwight") && l.includes("ado"));
    expect(dwight).toMatch(/rec\s+ado\s+-\s+-\s+-\s+-$/);
    expect(out).toContain("1 Models, 2 Artifacts, 3 MCP");
    expect(out).toContain("Engineers: 3 named, 2 withheld (opted out)");
  });

  it("renders team stats with denominators and only the fields present", () => {
    expect(out).toContain("Repos seen: 2");
    expect(out).toMatch(/\/review\s+2 \/ 5/);
    expect(out).toMatch(/code-reviewer\s+2 \/ 5/);
    expect(out).toMatch(/Slack\s+2 \/ 5\s+reads, writes/);
    expect(out).toMatch(/Github\s+1 \/ 5\s+-/);
    expect(out).toMatch(/MCP config\s+2 \/ 2/);
    expect(out).toContain("MCP in use (two or more engineers): 1 / 2 repos");
    expect(out).not.toContain("Eval harness");
  });

  it("renders the median row, a trend with its notes, and drops a stray note", () => {
    expect(out).toMatch(/Team median\s+62%\s+2\.5 : 1/);
    expect(out).toMatch(/Verification coverage\s+40%\s+\S+\s+62%/);
    expect(out).toContain("week 3: Added a test skill to the shared repo");
    expect(out).not.toContain("Pinned past the end");
    expect(out).toContain("Only one week of history for: Model-fit rate");
  });

  it("renders both windows for wholesale watch", () => {
    expect(out).toMatch(/Lines that shipped unchallenged\s+40 of 400\s+20 of 150/);
    expect(out).toMatch(/Sessions that shipped unchallenged\s+6 of 30\s+3 of 12/);
  });

  it("prints the basis under every dollar figure and the buckets above them", () => {
    const lines = out.split("\n");
    const basis = "API list-price equivalent, estimated upper bound";
    for (const figure of ["Opportunity: $412.50", "List-price spend on those sessions: $1830.25"]) {
      const at = lines.findIndex((l) => l.includes(figure));
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toContain(basis);
    }
    expect(out.indexOf("Sessions in the window")).toBeLessThan(out.indexOf("Opportunity"));
    expect(out).toMatch(/medium\s+-\s+4/);
  });
});

describe("renderTeamInsights: views that are off", () => {
  const out = render(ALL_OFF);

  it("gives each its own reason line and no table", () => {
    expect(out).toContain("Adoption funnel: not enough sessions yet to say anything");
    expect(out).toContain("Practice heatmap: not enough sessions yet to say anything");
    expect(out).toContain("Team stats: not enough sessions yet to say anything");
    expect(out).toContain("Judgement signals: off for your tenant");
  });

  it("never renders an unavailable view as zeros", () => {
    expect(out).not.toMatch(/\b0\b|0%|\$/);
  });

  it("still marks a view with no reason as not available", () => {
    const bare = render({
      sections: { repertoire: { enabled: true, team_stats: { enabled: false } } },
    });
    expect(bare).toContain("Team stats: not available");
  });
});

describe("renderTeamInsights: layout", () => {
  it("fits every fixture in a narrow terminal", () => {
    for (const payload of [WINDOW_28, WINDOW_90, WITH_REPERTOIRE, ALL_OFF]) {
      for (const width of [30, 40, 60]) {
        const lines = renderTeamInsights(normalizeTeam(payload), { width, ascii: true });
        for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("does not throw on a terminal too narrow to draw in", () => {
    for (const payload of [WINDOW_90, WITH_REPERTOIRE]) {
      for (const width of [1, 2, 3]) {
        expect(() =>
          renderTeamInsights(normalizeTeam(payload), { width, ascii: true }),
        ).not.toThrow();
      }
    }
  });

  it("falls back to ascii glyphs", () => {
    const out = render(WITH_REPERTOIRE, { width: 80, ascii: true });
    expect(out).not.toMatch(/[▁-█]/);
  });
});

describe("renderTeamInsights: empty and missing lists", () => {
  const stats = (team_stats: object) =>
    render({
      sections: { repertoire: { enabled: true, team_stats: { enabled: true, ...team_stats } } },
    });

  it("says so when a list is empty and prints nothing when it is absent", () => {
    const empty = stats({ skill_reuse: [], connectors: [], artifact_types: [], repos: 2 });
    expect(empty).toContain("Skills and commands: none reported");
    expect(empty).toContain("Connectors: none used");
    expect(empty).toContain("AI-config artifacts: none found");

    const absent = stats({ repos: 2 });
    expect(absent).not.toContain("none used");
    expect(absent).not.toContain("Skills and commands");
  });

  it("flags a dollar figure that arrives without coverage", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          dollar_savings: { enabled: true, basis: "b", opportunity: 5 },
        },
      },
    });
    expect(out.indexOf("Coverage: not reported")).toBeGreaterThan(-1);
    expect(out.indexOf("Coverage: not reported")).toBeLessThan(out.indexOf("Opportunity"));
  });
});

describe("renderTeamInsights: untrusted shapes", () => {
  it("names a heatmap state it does not know instead of printing it as a code", () => {
    const out = render({
      sections: {
        repertoire: {
          enabled: true,
          practice_heatmap: {
            enabled: true,
            competencies: ["Models"],
            engineers: [{ developer: "a", competencies: [{ name: "Models", state: "rec" }] }],
          },
        },
      },
    });
    expect(out).toMatch(/\ba\s+other\b/);
  });

  it("draws one column for a signal declared twice", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          signals_by_engineer: {
            enabled: true,
            signals: [
              { key: "pushback_rate", unit: "share" },
              { key: "pushback_rate", unit: "ratio" },
            ],
            engineers: [{ developer: "a", signals: [{ key: "pushback_rate", value: 0.5 }] }],
          },
        },
      },
    });
    expect(out).toMatch(/^\s*Engineer\s+Push\s*$/m);
    expect(out).toMatch(/\ba\s+50%\s*$/m);
  });

  it("prints no class heading when both distributions are empty", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          dollar_savings: { enabled: true, basis: "b", distribution: { actual: [] } },
        },
      },
    });
    expect(out).not.toContain("Sessions by model class");
  });
});

describe("renderTeamInsights: details the first tests missed", () => {
  it("keeps a note at the last point of the trend and drops one just past it", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          median_movement: {
            enabled: true,
            signals: [
              {
                key: "model_fit",
                unit: "share",
                trend: [0.1, 0.2, 0.3, 0.4],
                annotations: [
                  { index: 3, text: "last point" },
                  { index: 4, text: "one past" },
                ],
              },
            ],
          },
        },
      },
    });
    expect(out).toContain("week 4: last point");
    expect(out).not.toContain("one past");
  });

  it("prints a count past its denominator bare rather than as a fraction", () => {
    const out = render({
      team: { kind: "tenant", engineers: 5 },
      sections: {
        repertoire: {
          enabled: true,
          adoption_funnel: {
            enabled: true,
            practices: [{ name: "Models", unobserved: 6, adopted: 1, recurring: 1 }],
          },
        },
      },
    });
    expect(out).toMatch(/Models\s+6\s+1 \/ 5\s+1 \/ 5/);
  });

  it("falls back to the competencies the rows carry, and keeps the legend", () => {
    const out = render({
      sections: {
        repertoire: {
          enabled: true,
          practice_heatmap: {
            enabled: true,
            engineers: [{ developer: "a", competencies: [{ name: "MCP", state: "adopted" }] }],
          },
        },
      },
    });
    expect(out).toMatch(/\ba\s+ado\b/);
    expect(out).toContain("Cells: rec recurring");
  });

  it("names a trend it cannot draw", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          median_movement: {
            enabled: true,
            signals: [{ key: "model_fit", unit: "share", trend: [0.1, "x", 0.3] }],
          },
        },
      },
    });
    expect(out).toContain("Trend not reported for: Model-fit rate");
  });

  it("says how many rows past the bound were not shown", () => {
    const practices = Array.from({ length: 205 }, (_, i) => ({
      name: `P${i}`,
      unobserved: 0,
      adopted: 0,
      recurring: 1,
    }));
    const out = render({
      sections: { repertoire: { enabled: true, adoption_funnel: { enabled: true, practices } } },
    });
    expect(out).toContain("and 5 more row(s), not shown.");
  });
});

describe("renderTeamInsights: lists that cannot be trusted", () => {
  it("reads a list of non-rows as absent, not as nobody", () => {
    const out = render({
      sections: {
        repertoire: {
          enabled: true,
          team_stats: { enabled: true, repos: 1, skill_reuse: [null, "x"], connectors: [1] },
        },
      },
    });
    expect(out).not.toContain("none reported");
    expect(out).not.toContain("Connectors");
  });

  it("flags a dollar figure whose coverage has no usable counts", () => {
    const out = render({
      sections: {
        judgement_signals: {
          enabled: true,
          dollar_savings: { enabled: true, basis: "b", opportunity: 5, coverage: {} },
        },
      },
    });
    expect(out).toContain("Coverage: not reported");
  });
});
