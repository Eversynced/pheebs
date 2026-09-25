// The boundary between an untrusted `/insights` response and the renderer. `/insights` is a route
// self-hosters implement, so a payload can be malformed, hostile, or merely enormous. Everything
// that defends against that lives here and nowhere else: shapes are checked, numbers are validated,
// strings are stripped of anything a terminal would execute, and rows and lengths are bounded.
// What comes out is a structure the renderer can be simple and total over, and the renderer does
// no guarding of its own.

export type Reason = "no_consent" | "not_implemented" | "insufficient_data";

export interface Competency {
  name: string;
  state: string;
  share?: number;
}

export interface Repertoire {
  competencies: Competency[];
  recurring?: number;
  applicable?: number;
  sessions?: number;
  activeWeeks?: number;
  artifactBreadth?: number;
  auto?: number;
  manual?: number;
}

export interface Signal {
  label: string;
  unit: string;
  value?: number;
  teamMedian?: number;
  /** Empty when absent and when unusable; `trendUnusable` tells the two apart. */
  trend: number[];
  trendUnusable: boolean;
}

export interface Row {
  label: string;
  amount?: number;
}

export interface Cost {
  basis: string;
  basisSupplied: boolean;
  classes: Row[];
  savings: { model: string; usd?: number; sessions?: number }[];
  effort?: number;
  scopes: Row[];
  cache: { label: string; share?: number }[];
}

export type Body =
  | { kind: "unavailable"; reason?: Reason }
  | { kind: "repertoire"; data: Repertoire }
  | { kind: "signals"; data: Signal[] }
  | { kind: "cost"; data: Cost };

export interface Section {
  label: string;
  body: Body;
  /** Rows the bounds dropped, so the reader is told rather than shown a shortened list. */
  dropped: number;
}

export interface Report {
  days?: number;
  sections: Section[];
  /** Sections this client version does not render, which is not the same as none at all. */
  unrecognized: number;
}

// A competency profile is a handful of rows and a weekly trend is at most a year of weeks. These
// are far above any real report and far below what stalls a terminal.
const MAX_ROWS = 200;
const MAX_TEXT = 200;
const MAX_TREND = 400;

const FALLBACK_BASIS = "no basis supplied by this backend, so this is not money already saved";

const REASONS: Reason[] = ["no_consent", "not_implemented", "insufficient_data"];

const SIGNALS: [string, string][] = [
  ["verification_coverage", "Verification coverage"],
  ["pushback_rate", "Pushback rate"],
  ["refinement_to_repair", "Refinement-to-repair ratio"],
  ["wholesale_accept", "Wholesale-accept rate"],
];

const SECTIONS = ["repertoire", "judgement_signals"];

const LABELS: Record<string, string> = {
  repertoire: "Repertoire",
  judgement_signals: "Judgement signals",
};

// Pricing arrives inside `judgement_signals`, on the signal it renders, but it keeps its own
// block in the report: a dollar figure printed among the rates reads as one of them.
const PRICED_LABEL = "Cost";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// An escape sequence reaching a terminal is not text. OSC 52 writes the reader's clipboard, CSI
// blanks or overwrites what was already drawn, a bare CR overwrites the figure printed beside it,
// and a newline forges a line that reads as this tool's own output. Built from strings rather
// than regex literals so the escape codes stay legible as text: a literal here would carry real
// control bytes in the source, which editors and diffs hide.
const OSC = "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?";
const CSI = "\\u001b\\[[0-?]*[ -/]*[@-~]";
const ESCAPE_SEQUENCE = new RegExp(`${OSC}|${CSI}|\\u001b.`, "g");
// biome-ignore lint/complexity/useRegexLiterals: a literal here trips noControlCharactersInRegex
const CONTROL_CHAR = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

// Bidi overrides and isolates can display a label as text other than what was sent, and the line
// and paragraph separators break a row in two. Joiners are left alone: they are real text.
// biome-ignore lint/complexity/useRegexLiterals: a literal would embed invisible bidi characters
const BIDI = new RegExp("[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]", "g");

// A surrogate with no partner is not a character. A terminal draws one replacement glyph per
// orphan while `string-width` measures it as nothing, so a row of them is drawn far wider than
// the column it was measured into and the alignment the report depends on is lost.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function sanitize(value: string): string {
  return value
    .replace(ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHAR, " ")
    .replace(BIDI, " ")
    .replace(LONE_SURROGATE, "");
}

// Sanitized, bounded, and never longer than a terminal can use. The bound is counted in code
// points: cutting at a UTF-16 unit can split a surrogate pair, which would manufacture the very
// orphan `sanitize` exists to remove. One extra unit is taken before counting so a pair that
// straddles the bound is seen whole rather than halved by the pre-slice.
function text(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_TEXT) return sanitize(value);
  return sanitize(
    Array.from(value.slice(0, MAX_TEXT + 1))
      .slice(0, MAX_TEXT)
      .join(""),
  );
}

/** A row keeps an identity even when the backend sent no usable name for it. */
function label(value: unknown): string {
  return text(value).trim() || "-";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A count the schema means as a whole non-negative number; anything else is not reported. */
function count(value: unknown): number | undefined {
  const parsed = num(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The schema bounds these to 0..1, so 5.0 is a broken backend rather than a share. */
function share(value: unknown): number | undefined {
  const parsed = num(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function rows(value: unknown): { taken: Record<string, unknown>[]; dropped: number } {
  if (!Array.isArray(value)) return { taken: [], dropped: 0 };
  const usable = Array.from(value).filter(isRecord);
  return {
    taken: usable.slice(0, MAX_ROWS),
    dropped: Math.max(0, usable.length - MAX_ROWS),
  };
}

/**
 * A series is plotted whole or not at all. A hole, a non-number, a length past the bound, or a
 * span too wide to scale onto the ramp all make it unusable, because drawing a shortened chart
 * loses weeks without telling the reader.
 */
function trendOf(value: unknown): { trend: number[]; unusable: boolean } {
  if (value === undefined || value === null) return { trend: [], unusable: false };
  if (!Array.isArray(value) || value.length > MAX_TREND) return { trend: [], unusable: true };

  const points = Array.from(value, (v) => num(v));
  if (points.some((p) => p === undefined)) return { trend: [], unusable: true };

  const trend = points as number[];
  if (trend.length >= 2) {
    const min = trend.reduce((a, b) => (b < a ? b : a), trend[0]);
    const max = trend.reduce((a, b) => (b > a ? b : a), trend[0]);
    if (!Number.isFinite(max - min)) return { trend: [], unusable: true };
  }
  return { trend, unusable: false };
}

function reasonOf(value: unknown): Reason | undefined {
  const name = text(value);
  return REASONS.find((r) => r === name);
}

function repertoireOf(section: Record<string, unknown>): { data: Repertoire; dropped: number } {
  const { taken, dropped } = rows(section.competencies);
  const coverage = isRecord(section.coverage_index) ? section.coverage_index : undefined;
  const compaction = isRecord(section.compaction) ? section.compaction : undefined;

  return {
    dropped,
    data: {
      competencies: taken.map((c) => ({
        name: label(c.name),
        state: text(c.state),
        share: share(c.recurring_share),
      })),
      recurring: count(coverage?.recurring),
      applicable: count(coverage?.applicable),
      sessions: count(section.sessions),
      activeWeeks: count(section.active_weeks),
      artifactBreadth: count(section.artifact_breadth),
      auto: count(compaction?.auto),
      manual: count(compaction?.manual),
    },
  };
}

function signalsOf(section: Record<string, unknown>): Signal[] {
  return SIGNALS.flatMap(([key, name]) => {
    const raw = section[key];
    if (!isRecord(raw)) return [];
    const { trend, unusable } = trendOf(raw.trend);
    return [
      {
        label: name,
        unit: text(raw.unit),
        value: num(raw.value),
        teamMedian: num(raw.team_median),
        trend,
        trendUnusable: unusable,
      },
    ];
  });
}

function costOf(section: Record<string, unknown>): { data: Cost; dropped: number } {
  const classes = rows(section.sessions_by_recommended_class);
  const savings = rows(section.savings);
  const scopes = rows(section.scope_distribution);
  const cache = isRecord(section.cache) ? section.cache : undefined;

  const supplied = text(section.basis).trim();
  const cacheRows: [string, unknown][] = [
    ["Hit share", cache?.hit_share],
    ["Unreused writes", cache?.unreused_write_share],
    ["Share of cost", cache?.share_of_cost],
  ];

  return {
    dropped: classes.dropped + savings.dropped + scopes.dropped,
    data: {
      basis: supplied || FALLBACK_BASIS,
      basisSupplied: supplied !== "",
      classes: classes.taken.map((c) => ({ label: label(c.class), amount: count(c.sessions) })),
      savings: savings.taken.map((s) => ({
        model: label(s.model),
        usd: num(s.usd),
        sessions: count(s.sessions),
      })),
      effort: count(section.effort_suggestions),
      scopes: scopes.taken.map((s) => ({ label: label(s.scope), amount: count(s.prompts) })),
      // A field the backend sent but got wrong keeps its row and reads "-": dropping it would
      // hide that it was reported at all, which is a different fact from not reporting it.
      cache: cacheRows.flatMap(([name, value]) =>
        value === undefined ? [] : [{ label: name, share: share(value) }],
      ),
    },
  };
}

function bodyOf(name: string, section: Record<string, unknown>): { body: Body; dropped: number } {
  // A section that does not say it is on is treated as off: the schema requires `enabled`, and
  // reading a missing one as "on" invents a report out of a malformed response.
  if (section.enabled !== true) {
    return { body: { kind: "unavailable", reason: reasonOf(section.reason) }, dropped: 0 };
  }
  if (name === "repertoire") {
    const { data, dropped } = repertoireOf(section);
    return { body: { kind: "repertoire", data }, dropped };
  }
  return { body: { kind: "signals", data: signalsOf(section) }, dropped: 0 };
}

/**
 * `model_fit.priced` as its own block. It carries `available` rather than the section-level
 * `enabled`, because the section it sits in can be on while pricing is off, and an absent
 * `priced` is a backend that does not price at all rather than one withholding a figure.
 */
function pricedSection(raw: unknown): Section | undefined {
  if (!isRecord(raw) || raw.enabled !== true) return undefined;
  const fit = isRecord(raw.model_fit) ? raw.model_fit : undefined;
  const priced = fit === undefined ? undefined : fit.priced;
  if (!isRecord(priced)) return undefined;

  if (priced.available !== true) {
    const body: Body = { kind: "unavailable", reason: reasonOf(priced.reason) };
    return { label: PRICED_LABEL, body, dropped: 0 };
  }
  const { data, dropped } = costOf(priced);
  return { label: PRICED_LABEL, body: { kind: "cost", data }, dropped };
}

/** Total over any input: whatever arrives, a `Report` comes back. */
export function normalize(payload: unknown): Report {
  const root = isRecord(payload) ? payload : {};
  const map = isRecord(root.sections) ? root.sections : {};
  const days = count(root.days);

  const sections = SECTIONS.flatMap((name) => {
    const section = map[name];
    if (!isRecord(section)) return [];
    const { body, dropped } = bodyOf(name, section);
    return [{ label: LABELS[name], body, dropped }];
  });

  const priced = pricedSection(map.judgement_signals);
  if (priced !== undefined) sections.push(priced);

  const recognized = SECTIONS.filter((name) => isRecord(map[name])).length;

  return {
    days: days !== undefined && Number.isInteger(days) && days >= 1 ? days : undefined,
    sections,
    unrecognized: Object.keys(map).length - recognized,
  };
}

/**
 * The raw body with control characters escaped inside string literals, and a carriage return
 * dropped from the whitespace between tokens. `--json` prints the body verbatim, and a C1 control
 * is legal raw inside a JSON string, which would otherwise hand a hostile backend the terminal
 * that the render path denies it. A bare CR between tokens is legal JSON whitespace and draws the
 * text after it over the line already printed, so it is the one inter-token byte not passed
 * through. Neither change is visible to a parser: the value and its key order are identical.
 */
export function escapeControlChars(body: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of body) {
    if (!inString) {
      if (ch === "\r") continue;
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    out +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : ch;
  }
  return out;
}
