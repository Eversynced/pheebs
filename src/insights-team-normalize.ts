// The boundary for `/insights/team`, on the same terms as `normalize` for `/insights`: the response
// is untrusted, and everything that defends against that lives here. It reuses that module's
// primitives so a string, a count or a trend is cleaned one way on both routes. What comes out is
// a structure the team renderer can be total over without guarding anything itself.
//
// Two rules from the contract shape it. The section map and the views inside a section are both
// open: an unrecognized key is ignored, and an absent view is "this backend does not produce it",
// never "disabled". And availability is per view, so a view that is off keeps its reason rather
// than collapsing to an empty table that reads as a zero.

import {
  count,
  FALLBACK_BASIS,
  isRecord,
  label,
  num,
  type Reason,
  reasonOf,
  rows,
  SIGNALS,
  text,
  trendOf,
} from "./insights-normalize.js";

export interface Cohort {
  kind: string;
  engineers?: number;
  name?: string;
}

export interface FunnelRow {
  name: string;
  unobserved?: number;
  adopted?: number;
  recurring?: number;
  /** Present only when the backend sends it, which the contract allows beside the other three. */
  insufficientData?: number;
}

export interface Heatmap {
  competencies: string[];
  engineers: { developer: string; states: (string | undefined)[] }[];
  named?: number;
  withheld?: number;
}

export interface ReuseRow {
  name: string;
  engineers?: number;
  reads?: boolean;
  writes?: boolean;
}

export interface TeamStats {
  repos?: number;
  skills?: ReuseRow[];
  subagents?: ReuseRow[];
  connectors?: ReuseRow[];
  artifactTypes?: { name: string; repos?: number }[];
  mcpRepos?: number;
  evalRepos?: number;
}

export interface Column {
  key: string;
  label: string;
  unit: string;
}

export interface ByEngineer {
  columns: Column[];
  engineers: { developer: string; cells: (number | undefined)[] }[];
  /** Undefined when the backend sent an empty median, which is not a row of zeros. */
  median?: (number | undefined)[];
  named?: number;
  withheld?: number;
}

export interface Movement {
  label: string;
  unit: string;
  trend: number[];
  trendUnusable: boolean;
  /** Only the notes that point at a point the trend has. */
  notes: { index: number; text: string }[];
}

export interface Pair {
  unchallenged: number;
  total: number;
}

export interface Wholesale {
  lines: { thisWindow?: Pair; lastWindow?: Pair };
  sessions: { thisWindow?: Pair; lastWindow?: Pair };
  neverRan?: number;
  byRepo: { codebase: string; pair?: Pair }[];
}

export interface Dollars {
  basis: string;
  opportunity?: number;
  spend?: number;
  coverage?: {
    complete?: number;
    incomplete?: number;
    noTelemetry?: number;
    unpriced?: number;
  };
  actual?: { label: string; sessions?: number }[];
  asSized?: { label: string; sessions?: number }[];
}

export type ViewBody =
  | { kind: "unavailable"; reason?: Reason }
  | { kind: "funnel"; data: FunnelRow[] }
  | { kind: "heatmap"; data: Heatmap }
  | { kind: "stats"; data: TeamStats }
  | { kind: "byEngineer"; data: ByEngineer }
  | { kind: "movement"; data: Movement[] }
  | { kind: "wholesale"; data: Wholesale }
  | { kind: "dollars"; data: Dollars };

export interface View {
  title: string;
  body: ViewBody;
  /** Rows the bounds dropped, so the reader is told rather than shown a shortened list. */
  dropped: number;
}

export type TeamSectionBody =
  | { kind: "unavailable"; reason?: Reason }
  | { kind: "views"; views: View[] };

export interface TeamSection {
  label: string;
  body: TeamSectionBody;
}

export interface TeamReport {
  days?: number;
  cohort?: Cohort;
  sections: TeamSection[];
  /** Sections this client version does not render, which is not the same as none at all. */
  unrecognized: number;
}

const MAX_NOTES = 20;

const SECTIONS: [string, string][] = [
  ["repertoire", "Repertoire"],
  ["judgement_signals", "Judgement signals"],
];

function signalName(key: string): string {
  return SIGNALS.find(([k]) => k === key)?.[1] ?? key;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = Array.from(value, (v) => (typeof v === "string" ? label(v) : undefined));
  return [...new Set(names.filter((n): n is string => n !== undefined))].slice(0, 200);
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function funnelOf(view: Record<string, unknown>): { data: FunnelRow[]; dropped: number } {
  const { taken, dropped } = rows(view.practices);
  return {
    dropped,
    data: taken.map((r) => ({
      name: label(r.name),
      unobserved: count(r.unobserved),
      adopted: count(r.adopted),
      recurring: count(r.recurring),
      insufficientData: count(r.insufficient_data),
    })),
  };
}

function heatmapOf(view: Record<string, unknown>): { data: Heatmap; dropped: number } {
  const { taken, dropped } = rows(view.engineers);
  const listed = strings(view.competencies);

  // A row may omit a competency, and the cell is then a gap rather than the next one shifted left.
  // Cells are looked up by name, never by position, for the same reason.
  const perEngineer = taken.map((e) => {
    const cells = new Map<string, string>();
    for (const c of rows(e.competencies).taken) {
      const name = label(c.name);
      if (!cells.has(name)) cells.set(name, text(c.state));
    }
    return { developer: label(e.developer), cells };
  });

  // Without a column order the union in first-seen order is the best that can be said.
  const competencies =
    listed.length > 0 ? listed : [...new Set(perEngineer.flatMap((e) => [...e.cells.keys()]))];

  return {
    dropped,
    data: {
      competencies,
      engineers: perEngineer.map((e) => ({
        developer: e.developer,
        states: competencies.map((name) => e.cells.get(name) || undefined),
      })),
      named: count(view.engineers_named),
      withheld: count(view.engineers_withheld),
    },
  };
}

function reuse(value: unknown): { rows: ReuseRow[] | undefined; dropped: number } {
  if (!Array.isArray(value)) return { rows: undefined, dropped: 0 };
  const { taken, dropped } = rows(value);
  return {
    dropped,
    rows: taken.map((r) => ({
      name: label(r.name),
      engineers: count(r.engineers),
      reads: flag(r.reads),
      writes: flag(r.writes),
    })),
  };
}

function statsOf(view: Record<string, unknown>): { data: TeamStats; dropped: number } {
  const skills = reuse(view.skill_reuse);
  const subagents = reuse(view.subagent_reuse);
  const connectors = reuse(view.connectors);
  const artifacts = Array.isArray(view.artifact_types) ? rows(view.artifact_types) : undefined;

  return {
    dropped: skills.dropped + subagents.dropped + connectors.dropped + (artifacts?.dropped ?? 0),
    data: {
      repos: count(view.repos),
      skills: skills.rows,
      subagents: subagents.rows,
      connectors: connectors.rows,
      artifactTypes: artifacts?.taken.map((a) => ({ name: label(a.name), repos: count(a.repos) })),
      mcpRepos: count(view.mcp_repos_in_use),
      evalRepos: count(view.eval_harness_in_use),
    },
  };
}

function byEngineerOf(view: Record<string, unknown>): { data: ByEngineer; dropped: number } {
  const { taken, dropped } = rows(view.engineers);
  const keyed = (value: unknown): Map<string, number | undefined> => {
    const cells = new Map<string, number | undefined>();
    for (const c of rows(value).taken) {
      const key = text(c.key);
      if (!cells.has(key)) cells.set(key, num(c.value));
    }
    return cells;
  };
  const perEngineer = taken.map((e) => ({
    developer: label(e.developer),
    cells: keyed(e.signals),
  }));
  const median = Array.isArray(view.median) ? keyed(view.median) : undefined;

  // A key declared twice would draw two columns over the same cells, so the first declaration wins.
  const seen = new Set<string>();
  const declared = rows(view.signals).taken.flatMap((s) => {
    const key = text(s.key);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ key, unit: text(s.unit) }];
  });
  // Without a declared column order the union in first-seen order is all there is, and the unit is
  // then unknown, so the value prints raw rather than at a guessed scale.
  const columns: Column[] = (
    declared.length > 0
      ? declared
      : [
          ...new Set([
            ...perEngineer.flatMap((e) => [...e.cells.keys()]),
            ...(median?.keys() ?? []),
          ]),
        ].map((key) => ({ key, unit: "" }))
  ).map((c) => ({ ...c, label: signalName(c.key) }));

  return {
    dropped,
    data: {
      columns,
      engineers: perEngineer.map((e) => ({
        developer: e.developer,
        cells: columns.map((c) => e.cells.get(c.key)),
      })),
      median:
        median !== undefined && median.size > 0 ? columns.map((c) => median.get(c.key)) : undefined,
      named: count(view.engineers_named),
      withheld: count(view.engineers_withheld),
    },
  };
}

function movementOf(view: Record<string, unknown>): { data: Movement[]; dropped: number } {
  const { taken, dropped } = rows(view.signals);
  return {
    dropped,
    data: taken.map((s) => {
      const { trend, unusable } = trendOf(s.trend);
      // A note pinned to the wrong week is worse than a missing one, so an index outside the trend
      // is dropped rather than clamped.
      const notes = rows(s.annotations)
        .taken.flatMap((a) => {
          const index = count(a.index);
          const note = text(a.text).trim();
          return index !== undefined && index < trend.length && note ? [{ index, text: note }] : [];
        })
        .slice(0, MAX_NOTES);
      return {
        label: signalName(label(s.key)),
        unit: text(s.unit),
        trend,
        trendUnusable: unusable,
        notes,
      };
    }),
  };
}

// A numerator past its denominator is a broken backend, and printing "20 of 18" would assert it.
function pairOf(value: unknown): Pair | undefined {
  if (!isRecord(value)) return undefined;
  const unchallenged = count(value.unchallenged);
  const total = count(value.total);
  return unchallenged !== undefined && total !== undefined && unchallenged <= total
    ? { unchallenged, total }
    : undefined;
}

function windowsOf(value: unknown): Wholesale["lines"] {
  const raw = isRecord(value) ? value : {};
  return { thisWindow: pairOf(raw.this_window), lastWindow: pairOf(raw.last_window) };
}

function wholesaleOf(view: Record<string, unknown>): { data: Wholesale; dropped: number } {
  const { taken, dropped } = rows(view.by_repo);
  return {
    dropped,
    data: {
      lines: windowsOf(view.lines),
      sessions: windowsOf(view.sessions),
      neverRan: count(view.verification_requested_never_ran),
      byRepo: taken.map((r) => ({ codebase: label(r.codebase), pair: pairOf(r) })),
    },
  };
}

function classes(value: unknown): { rows: Dollars["actual"]; dropped: number } {
  if (!Array.isArray(value)) return { rows: undefined, dropped: 0 };
  const { taken, dropped } = rows(value);
  return {
    dropped,
    rows: taken.map((c) => ({ label: label(c.class), sessions: count(c.sessions) })),
  };
}

function dollarsOf(view: Record<string, unknown>): { data: Dollars; dropped: number } {
  const coverage = isRecord(view.coverage)
    ? {
        complete: count(view.coverage.complete),
        incomplete: count(view.coverage.incomplete),
        noTelemetry: count(view.coverage.no_telemetry),
        unpriced: count(view.coverage.unpriced),
      }
    : undefined;
  const distribution = isRecord(view.distribution) ? view.distribution : {};
  const actual = classes(distribution.actual);
  const asSized = classes(distribution.as_sized);

  return {
    dropped: actual.dropped + asSized.dropped,
    data: {
      basis: text(view.basis).trim() || FALLBACK_BASIS,
      opportunity: num(view.opportunity),
      spend: num(view.spend),
      coverage,
      actual: actual.rows,
      asSized: asSized.rows,
    },
  };
}

const VIEWS: Record<
  string,
  [
    string,
    string,
    (v: Record<string, unknown>) => { data: unknown; dropped: number },
    ViewBody["kind"],
  ][]
> = {
  repertoire: [
    ["adoption_funnel", "Adoption funnel", funnelOf, "funnel"],
    ["practice_heatmap", "Practice heatmap", heatmapOf, "heatmap"],
    ["team_stats", "Team stats", statsOf, "stats"],
  ],
  judgement_signals: [
    ["signals_by_engineer", "Signals by engineer", byEngineerOf, "byEngineer"],
    ["median_movement", "Median movement", movementOf, "movement"],
    ["wholesale_watch", "Wholesale watch", wholesaleOf, "wholesale"],
    ["dollar_savings", "Dollar savings", dollarsOf, "dollars"],
  ],
};

function viewsOf(section: string, raw: Record<string, unknown>): View[] {
  return VIEWS[section].flatMap(([key, title, build, kind]) => {
    const view = raw[key];
    if (!isRecord(view)) return [];
    // A view that does not say it is on is off, as with a section: reading a missing `enabled` as
    // "on" would invent a table out of a malformed response.
    if (view.enabled !== true) {
      return [{ title, dropped: 0, body: { kind: "unavailable", reason: reasonOf(view.reason) } }];
    }
    const { data, dropped } = build(view);
    return [{ title, dropped, body: { kind, data } as ViewBody }];
  });
}

function cohortOf(value: unknown): Cohort | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name).trim();
  return {
    kind: text(value.kind).trim() || "unknown",
    engineers: count(value.engineers),
    name: name || undefined,
  };
}

/** Total over any input: whatever arrives, a `TeamReport` comes back. */
export function normalizeTeam(payload: unknown): TeamReport {
  const root = isRecord(payload) ? payload : {};
  const map = isRecord(root.sections) ? root.sections : {};
  const days = count(root.days);

  const sections = SECTIONS.flatMap(([key, name]) => {
    const raw = map[key];
    if (!isRecord(raw)) return [];
    const body: TeamSectionBody =
      raw.enabled === true
        ? { kind: "views", views: viewsOf(key, raw) }
        : { kind: "unavailable", reason: reasonOf(raw.reason) };
    return [{ label: name, body }];
  });

  return {
    days: days !== undefined && days >= 1 ? days : undefined,
    cohort: cohortOf(root.team),
    sections,
    unrecognized: Object.keys(map).length - SECTIONS.filter(([key]) => isRecord(map[key])).length,
  };
}
