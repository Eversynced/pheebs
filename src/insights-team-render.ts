// The manager's report as pure functions over a `TeamReport`, on the same terms as
// `insights-render`: `normalizeTeam` has already made every string safe and every number a number,
// so nothing here guards a shape. What is left is layout.
//
// Two rules run through all of it. A view that is off prints its reason in one line and never a
// table of dashes or zeros, because "we cannot see this" and "nobody did this" are different
// facts. And a count is printed beside the denominator it is out of whenever the report states
// one, since the contract sends parts rather than percentages.

import {
  cell,
  displayWidth,
  formatCount,
  formatUsd,
  REASON_TEXT,
  type RenderOptions,
  renderTable,
  renderTrends,
  wrap,
} from "./insights-render.js";
import type {
  ByEngineer,
  Dollars,
  FunnelRow,
  Heatmap,
  Movement,
  Pair,
  TeamReport,
  TeamSection,
  TeamStats,
  View,
  Wholesale,
} from "./insights-team-normalize.js";

const NO_FIELDS = "This backend produced no fields for it.";

// Cells in the heatmap are short codes with a legend, because six competency names do not fit
// beside an engineer's name in 80 columns and a truncated "Context manag" helps nobody.
const STATE_CODES: [string, string, string][] = [
  ["recurring", "rec", "recurring"],
  ["adopted", "ado", "adopted"],
  ["unobserved", "none", "unobserved"],
  ["insufficient_data", "?", "insufficient data"],
  ["n/a", "n/a", "not applicable"],
];

function stateCode(state: string | undefined): string {
  if (!state) return "-";
  return STATE_CODES.find(([key]) => key === state)?.[1] ?? state;
}

function outOf(count: number | undefined, denominator: number | undefined): string {
  if (count === undefined) return "-";
  return denominator !== undefined && count <= denominator
    ? `${count} / ${denominator}`
    : String(count);
}

function pairText(pair: Pair | undefined): string {
  return pair === undefined ? "not reported" : `${pair.unchallenged} of ${pair.total}`;
}

function rowsNote(named: number | undefined, withheld: number | undefined): string | undefined {
  const parts = [
    named === undefined ? "" : `${named} named`,
    withheld === undefined ? "" : `${withheld} withheld (opted out)`,
  ].filter(Boolean);
  return parts.length > 0 ? `Engineers: ${parts.join(", ")}` : undefined;
}

function renderFunnel(data: FunnelRow[], engineers: number | undefined, opts: RenderOptions) {
  if (data.length === 0) return wrap(NO_FIELDS, opts.width);

  // The fourth count is the backend's to add, so its column exists only when some row carries it.
  const withInsufficient = data.some((r) => r.insufficientData !== undefined);
  const lines = renderTable(
    data.map((r) => [
      r.name,
      outOf(r.unobserved, engineers),
      outOf(r.adopted, engineers),
      outOf(r.recurring, engineers),
      ...(withInsufficient ? [outOf(r.insufficientData, engineers)] : []),
    ]),
    withInsufficient
      ? ["left", "right", "right", "right", "right"]
      : ["left", "right", "right", "right"],
    opts,
    {
      headers: [
        "Practice",
        "Unobserved",
        "Adopted",
        "Recurring",
        ...(withInsufficient ? ["Insufficient data"] : []),
      ],
    },
  );
  return [...lines, "", ...wrap("Counts are engineers.", opts.width)];
}

function renderHeatmap(data: Heatmap, opts: RenderOptions): string[] {
  const lines: string[] = [];
  const note = rowsNote(data.named, data.withheld);

  if (data.engineers.length > 0 && data.competencies.length > 0) {
    lines.push(
      ...renderTable(
        data.engineers.map((e) => [e.developer, ...e.states.map(stateCode)]),
        ["left", ...data.competencies.map(() => "right" as const)],
        opts,
        { headers: ["Engineer", ...data.competencies.map((_, i) => String(i + 1))] },
      ),
    );
    const columns = data.competencies.map((name, i) => `${i + 1} ${name}`).join(", ");
    const cells = [...STATE_CODES.map(([, code, word]) => `${code} ${word}`), "- not reported"];
    lines.push("", ...wrap(`Columns: ${columns}`, opts.width));
    lines.push(...wrap(`Cells: ${cells.join(", ")}`, opts.width));
  }
  if (note) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap(note, opts.width));
  }
  return lines.length > 0 ? lines : wrap(NO_FIELDS, opts.width);
}

function renderStats(data: TeamStats, engineers: number | undefined, opts: RenderOptions) {
  const blocks: string[][] = [];

  if (data.repos !== undefined) blocks.push(wrap(`Repos seen: ${data.repos}`, opts.width));

  // An empty list is the backend saying nobody did it, which is a finding, while an absent one is a
  // list it could not measure and prints nothing.
  const reuse = (title: string, rows: { name: string; engineers?: number }[] | undefined) => {
    if (rows === undefined) return;
    if (rows.length === 0) {
      blocks.push(wrap(`${title}: none used by any engineer`, opts.width));
      return;
    }
    blocks.push([
      ...wrap(`${title}, by engineers out of ${engineers ?? "the team"}`, opts.width),
      ...renderTable(
        rows.map((r) => [`  ${r.name}`, outOf(r.engineers, engineers)]),
        ["left", "right"],
        opts,
      ),
    ]);
  };
  reuse("Skills and commands", data.skills);
  reuse("Sub-agents", data.subagents);

  if (data.connectors?.length === 0) blocks.push(wrap("Connectors: none used", opts.width));
  if (data.connectors !== undefined && data.connectors.length > 0) {
    blocks.push([
      ...wrap(`Connectors, by engineers out of ${engineers ?? "the team"}`, opts.width),
      ...renderTable(
        data.connectors.map((c) => {
          const access = [c.reads === true ? "reads" : "", c.writes === true ? "writes" : ""]
            .filter(Boolean)
            .join(", ");
          return [`  ${c.name}`, outOf(c.engineers, engineers), access || "-"];
        }),
        ["left", "right", "left"],
        opts,
      ),
    ]);
  }

  if (data.artifactTypes?.length === 0) {
    blocks.push(wrap("AI-config artifacts: none found in the repos seen", opts.width));
  }
  if (data.artifactTypes !== undefined && data.artifactTypes.length > 0) {
    blocks.push([
      ...wrap(`AI-config artifacts, by repos out of ${data.repos ?? "those seen"}`, opts.width),
      ...renderTable(
        data.artifactTypes.map((a) => [`  ${a.name}`, outOf(a.repos, data.repos)]),
        ["left", "right"],
        opts,
      ),
    ]);
  }

  const repoFacts = [
    data.mcpRepos === undefined
      ? ""
      : `MCP in use (two or more engineers): ${outOf(data.mcpRepos, data.repos)} repos`,
    data.evalRepos === undefined
      ? ""
      : `Eval harness in use: ${outOf(data.evalRepos, data.repos)} repos`,
  ].filter(Boolean);
  if (repoFacts.length > 0) blocks.push(repoFacts.flatMap((f) => wrap(f, opts.width)));

  if (blocks.length === 0) return wrap(NO_FIELDS, opts.width);
  return blocks.flatMap((b, i) => (i === 0 ? b : ["", ...b]));
}

// Short enough for five columns beside an engineer's name; the key line below the table gives the
// full name, so a column is never a guess.
const SHORT: Record<string, string> = {
  "Verification coverage": "Verif",
  "Pushback rate": "Push",
  "Refinement-to-repair ratio": "Refine",
  "Wholesale-accept rate": "Accept",
  "Model-fit rate": "Fit",
};

function renderByEngineer(data: ByEngineer, opts: RenderOptions): string[] {
  const lines: string[] = [];
  const note = rowsNote(data.named, data.withheld);
  const short = data.columns.map((c) => (Object.hasOwn(SHORT, c.label) ? SHORT[c.label] : c.label));

  if (data.columns.length > 0 && data.engineers.length + (data.median ? 1 : 0) > 0) {
    const fmt = (cells: (number | undefined)[]) =>
      cells.map((v, i) => cell(v, data.columns[i].unit));
    lines.push(
      ...renderTable(
        [
          ...data.engineers.map((e) => [e.developer, ...fmt(e.cells)]),
          ...(data.median ? [["Team median", ...fmt(data.median)]] : []),
        ],
        ["left", ...data.columns.map(() => "right" as const)],
        opts,
        { headers: ["Engineer", ...short] },
      ),
    );
    const key = data.columns
      .map((c, i) => (short[i] === c.label ? "" : `${short[i]} ${c.label}`))
      .filter(Boolean);
    if (key.length > 0) lines.push("", ...wrap(`Columns: ${key.join(", ")}`, opts.width));
  }
  // An empty median is the backend saying it could not compute one, which is not a row of zeros.
  if (data.median === undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("Team median: not reported.", opts.width));
  }
  if (note) {
    lines.push("", ...wrap(note, opts.width));
  }
  return lines.length > 0 ? lines : wrap(NO_FIELDS, opts.width);
}

function renderMovement(data: Movement[], opts: RenderOptions): string[] {
  if (data.length === 0) return wrap(NO_FIELDS, opts.width);

  const lines: string[] = [];
  const trended = data.filter((s) => s.trend.length >= 2);
  const labelWidth = data.reduce((w, s) => Math.max(w, displayWidth(s.label)), 0);

  if (trended.length > 0) {
    lines.push(...wrap("Team median, weekly", opts.width));
    lines.push(...renderTrends(trended, labelWidth, opts));
  }

  const notes = trended.flatMap((s) =>
    s.notes.map((n) => `${s.label}, week ${n.index + 1}: ${n.text}`),
  );
  if (notes.length > 0) {
    lines.push("", ...wrap("What changed", opts.width));
    for (const note of notes) lines.push(...wrap(note, opts.width, 2));
  }

  // Named rather than silently left out: a single point implies a history that does not exist, and
  // an unusable series would draw a chart shorter than the weeks it covers.
  const oneWeek = data.filter((s) => s.trend.length === 1).map((s) => s.label);
  const unusable = data.filter((s) => s.trendUnusable).map((s) => s.label);
  const empty = data.filter((s) => s.trend.length === 0 && !s.trendUnusable).map((s) => s.label);
  for (const [text, names] of [
    ["Only one week of history for", oneWeek],
    ["Trend not reported for", [...unusable, ...empty]],
  ] as const) {
    if (names.length > 0) lines.push("", ...wrap(`${text}: ${names.join(", ")}`, opts.width));
  }
  return lines;
}

function renderWholesale(data: Wholesale, opts: RenderOptions): string[] {
  const lines: string[] = [];

  // Two windows side by side rather than a delta: a share that moved over a shrinking team is not
  // the movement the two numbers suggest, so each is printed as its own part over its own total.
  const measures: [string, Wholesale["lines"]][] = [
    ["Lines that shipped unchallenged", data.lines],
    ["Sessions that shipped unchallenged", data.sessions],
  ];
  const reported = measures.filter(([, w]) => w.thisWindow || w.lastWindow);
  if (reported.length > 0) {
    const before = reported.some(([, w]) => w.lastWindow !== undefined);
    lines.push(
      ...renderTable(
        reported.map(([name, w]) => [
          name,
          pairText(w.thisWindow),
          ...(before ? [pairText(w.lastWindow)] : []),
        ]),
        before ? ["left", "right", "right"] : ["left", "right"],
        opts,
        { headers: ["", "This window", ...(before ? ["Window before"] : [])] },
      ),
    );
  }

  if (data.neverRan !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(
      ...wrap(`Sessions where a check was asked for and never ran: ${data.neverRan}`, opts.width),
    );
  }

  if (data.byRepo.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("Where it concentrates, this window", opts.width));
    lines.push(
      ...renderTable(
        data.byRepo.map((r) => [`  ${r.codebase}`, pairText(r.pair)]),
        ["left", "right"],
        opts,
      ),
    );
  }
  return lines.length > 0 ? lines : wrap(NO_FIELDS, opts.width);
}

function renderDollars(data: Dollars, opts: RenderOptions): string[] {
  const lines: string[] = [];
  // Coverage first and always above the dollars: a figure with no coverage line beside it reads
  // as the whole team when it may be half of it.
  const { coverage } = data;
  const hasFigure = data.opportunity !== undefined || data.spend !== undefined;
  if (coverage === undefined && hasFigure) {
    lines.push(
      ...wrap(
        "Coverage: not reported, so these figures may cover only part of the team",
        opts.width,
      ),
    );
  }
  if (coverage !== undefined) {
    lines.push(...wrap("Sessions in the window", opts.width));
    lines.push(
      ...renderTable(
        [
          ["  Complete", coverage.complete],
          ["  Incomplete (a prompt has no scope)", coverage.incomplete],
          ["  No usage telemetry", coverage.noTelemetry],
          ["  Model not in the price table", coverage.unpriced],
        ].map(([name, n]) => [name as string, n === undefined ? "-" : String(n)]),
        ["left", "right"],
        opts,
      ),
    );
  }

  // The basis rides next to every figure rather than in a footer, and a view with no figure still
  // states it once, since it is required on an enabled view.
  const basis = wrap(data.basis, opts.width, 2);
  const figures: [string, number | undefined][] = [
    ["Opportunity", data.opportunity],
    ["List-price spend on those sessions", data.spend],
  ];
  const shown = figures.filter(([, usd]) => usd !== undefined);
  for (const [name, usd] of shown) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap(`${name}: ${formatUsd(usd as number)}`, opts.width), ...basis);
  }
  if (shown.length === 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("Basis", opts.width), ...basis);
  }

  const { actual, asSized } = data;
  if (actual !== undefined || asSized !== undefined) {
    const names = [...new Set([...(actual ?? []), ...(asSized ?? [])].map((c) => c.label))];
    const sessionsFor = (rows: typeof actual, name: string) => {
      const found = rows?.find((c) => c.label === name);
      return found?.sessions === undefined ? "-" : formatCount(found.sessions);
    };
    lines.push("", ...wrap("Sessions by model class, complete sessions only", opts.width));
    lines.push(
      ...renderTable(
        names.map((n) => [
          `  ${n}`,
          ...(actual ? [sessionsFor(actual, n)] : []),
          ...(asSized ? [sessionsFor(asSized, n)] : []),
        ]),
        ["left", ...(actual ? ["right" as const] : []), ...(asSized ? ["right" as const] : [])],
        opts,
        { headers: ["", ...(actual ? ["Ran"] : []), ...(asSized ? ["Sized for"] : [])] },
      ),
    );
  }
  return lines;
}

const INDENT = 2;

function indented(lines: string[], by: number): string[] {
  const prefix = " ".repeat(by);
  return lines.map((l) => (l ? prefix + l : l));
}

function renderView(view: View, engineers: number | undefined, opts: RenderOptions): string[] {
  const { body } = view;
  // A view sits one level under its section, and its content one more, so the width given to the
  // tables is what remains after the indent rather than a width they would overrun.
  const title = { ...opts, width: Math.max(1, opts.width - INDENT) };
  const inner = { ...opts, width: Math.max(1, opts.width - 2 * INDENT) };

  if (body.kind === "unavailable") {
    const reason = body.reason ? REASON_TEXT[body.reason] : "not available";
    return indented(wrap(`${view.title}: ${reason}`, title.width), INDENT);
  }

  const lines =
    body.kind === "funnel"
      ? renderFunnel(body.data, engineers, inner)
      : body.kind === "heatmap"
        ? renderHeatmap(body.data, inner)
        : body.kind === "stats"
          ? renderStats(body.data, engineers, inner)
          : body.kind === "byEngineer"
            ? renderByEngineer(body.data, inner)
            : body.kind === "movement"
              ? renderMovement(body.data, inner)
              : body.kind === "wholesale"
                ? renderWholesale(body.data, inner)
                : renderDollars(body.data, inner);

  const out = [...indented(wrap(view.title, title.width), INDENT), ...indented(lines, 2 * INDENT)];
  if (view.dropped > 0) {
    out.push(
      "",
      ...indented(wrap(`and ${view.dropped} more row(s), not shown.`, inner.width), 2 * INDENT),
    );
  }
  return out;
}

function renderSection(
  section: TeamSection,
  engineers: number | undefined,
  opts: RenderOptions,
): string[] {
  const { body } = section;
  if (body.kind === "unavailable") {
    const reason = body.reason ? REASON_TEXT[body.reason] : "not available";
    return wrap(`${section.label}: ${reason}`, opts.width);
  }
  if (body.views.length === 0) {
    return [...wrap(section.label, opts.width), "", ...wrap(NO_FIELDS, opts.width)];
  }

  const out = wrap(section.label, opts.width);
  for (const view of body.views) {
    out.push("", ...renderView(view, engineers, opts));
  }
  return out;
}

/** The whole team report as lines, over a payload `normalizeTeam` has already made safe. */
export function renderTeamInsights(report: TeamReport, opts: RenderOptions): string[] {
  const header =
    report.days === undefined
      ? "Your team's recent work"
      : `Your team, last ${report.days} day${report.days === 1 ? "" : "s"}`;
  const lines: string[] = wrap(header, opts.width);

  const { cohort } = report;
  if (cohort !== undefined) {
    const size =
      cohort.engineers === undefined
        ? ""
        : `, ${cohort.engineers} engineer${cohort.engineers === 1 ? "" : "s"}`;
    // The kind is printed whatever it is: the numbers are still true of whoever `engineers` counts.
    lines.push(...wrap(`${cohort.name ?? "Cohort"} (${cohort.kind}${size})`, opts.width));
  }

  for (const section of report.sections) {
    lines.push("", ...renderSection(section, cohort?.engineers, opts));
  }

  if (report.sections.length === 0) {
    const text =
      report.unrecognized > 0
        ? `This backend produces ${report.unrecognized} section(s) that this version of pheebs does not render.`
        : "This backend produces no team sections.";
    lines.push("", ...wrap(text, opts.width));
  }
  return lines;
}
