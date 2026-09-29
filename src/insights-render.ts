// The chart vocabulary is not invented here: sparklines, gauges and the coverage bar are the ones
// already agreed in docs/ai-proficiency-model.md, and this module draws them in a terminal.
//
// Everything it receives has been through `normalize`, so nothing below guards a shape, a type or
// a length: strings are already sanitized and bounded, numbers are already finite and in range,
// and rows are already capped. What is left is layout, and it is pure, so every rendering decision
// is testable without a backend.

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { Cost, Repertoire, Report, Section, Signal } from "./insights-normalize.js";

export interface RenderOptions {
  width: number;
  ascii: boolean;
}

const SPARK_UNICODE = "▁▂▃▄▅▆▇";
const SPARK_ASCII = ".:-=+*#";

/** Fewer than two points is not a trend: `normalize` keeps such a series out of the chart. */
export function sparkline(values: number[], ascii = false): string {
  if (values.length < 2) return "";

  const ramp = ascii ? SPARK_ASCII : SPARK_UNICODE;
  const min = values.reduce((a, b) => (b < a ? b : a), values[0]);
  const max = values.reduce((a, b) => (b > a ? b : a), values[0]);
  const span = max - min;
  // A flat series sits mid-ramp: drawn at the floor it would read as a collapse to nothing.
  const flat = Math.floor((ramp.length - 1) / 2);

  return values
    .map((v) => ramp[span === 0 ? flat : Math.round(((v - min) / span) * (ramp.length - 1))])
    .join("");
}

export function bar(filled: number, total: number, width: number, ascii = false): string {
  if (width < 1 || total <= 0) return "";
  const cells = Math.max(0, Math.min(width, Math.round((Math.max(0, filled) / total) * width)));
  const [on, off] = ascii ? ["#", "."] : ["█", "░"];
  return on.repeat(cells) + off.repeat(width - cells);
}

/**
 * `share` renders as a percentage, `ratio` as `2.1 : 1`, `count` as a whole number. A unit this
 * client does not know prints the raw value rather than guessing at a scale.
 */
export function formatValue(value: number, unit: string): string {
  if (unit === "share") {
    const pct = value * 100;
    if (!Number.isFinite(pct)) return String(value);
    // A real but tiny share must not round to the zero this report promises never to show, and
    // Math.round(-0.5) is -0, so the guard has to be symmetric.
    if (value !== 0 && Math.abs(pct) < 0.5) return value > 0 ? "<1%" : ">-1%";
    return `${Math.round(pct)}%`;
  }
  if (unit === "ratio") return `${value.toFixed(1)} : 1`;
  if (unit === "count") return String(Math.round(value));
  return String(value);
}

function cell(value: number | undefined, unit: string): string {
  return value === undefined ? "-" : formatValue(value, unit);
}

function formatUsd(usd: number): string {
  // toFixed goes exponential past 1e21, which is not a dollar figure any reader can use.
  if (Math.abs(usd) >= 1e15) return "-";
  return `${usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(2)}`;
}

// Column alignment is measured in what the terminal draws, not in UTF-16 units: an East Asian
// character takes two cells, a combining mark none, and slicing by code unit can cut a surrogate
// pair in half. `string-width` owns that table; graphemes are segmented here because slicing needs
// a per-grapheme width and the library measures whole strings.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (s) => s.segment);
}

/** Columns the terminal will use, which is not `text.length` for CJK or combining marks. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

function sliceToWidth(text: string, max: number): string {
  let out = "";
  let width = 0;
  for (const grapheme of graphemes(text)) {
    const next = stringWidth(grapheme);
    if (width + next > max) break;
    out += grapheme;
    width += next;
  }
  return out;
}

function pad(text: string, width: number, align: "left" | "right"): string {
  const gap = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? gap + text : text + gap;
}

function truncate(text: string, max: number, ascii: boolean): string {
  if (max < 1) return "";
  if (displayWidth(text) <= max) return text;
  const ellipsis = ascii ? "..." : "…";
  const budget = max - ellipsis.length;
  return budget < 1 ? sliceToWidth(text, max) : sliceToWidth(text, budget) + ellipsis;
}

// Prose folds at word boundaries; tables truncate instead, because a shortened label still reads
// whereas a folded row destroys the alignment that is the only thing making the row legible.
function wrap(text: string, width: number, indent = 0): string[] {
  // An indent wider than the terminal would push every line past the width before a single word
  // was placed, so it gives way first.
  const prefix = " ".repeat(Math.max(0, Math.min(indent, width - 1)));
  const usable = Math.max(1, width - prefix.length);
  // Runs of whitespace are collapsed first: `normalize` turns every control character into a
  // space, so a hostile field would otherwise fold around gaps it invented.
  const flowed = text.split(/\s+/).filter(Boolean).join(" ");
  // `hard` breaks a word with no break point of its own; without it the width guarantee holds
  // only for text that happens to contain spaces.
  return wrapAnsi(flowed, usable, { hard: true, trim: true })
    .split("\n")
    .map((line) => prefix + line);
}

// `fixed` is a column that must keep its natural width or not be drawn at all. A sparkline is the
// only one: clipped, it drops weeks silently and then disagrees with the value printed beside it,
// and in ASCII its ellipsis is indistinguishable from three floor-level ramp glyphs.
type Align = "left" | "right" | "fixed";

const LABEL_FLOOR = 4;
const VALUE_FLOOR = 3;
const GUTTER = 2;

interface TableOptions {
  headers?: string[];
  /** A width column 0 is padded up to, so sibling tables share one label column. */
  labelWidth?: number;
}

function naturalWidths(rows: string[][], count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    rows.reduce((widest, r) => Math.max(widest, displayWidth(r[i] ?? "")), 0),
  );
}

// Aligned columns that never wrap a row: past the available width, label columns are narrowed
// first and value columns only once the labels are at their floor, with cells truncated to fit.
function renderTable(
  rows: string[][],
  align: Align[],
  opts: RenderOptions,
  table: TableOptions = {},
): string[] {
  if (rows.length === 0) return [];

  const { headers, labelWidth } = table;
  const count = align.length;
  const widths = naturalWidths(headers ? [headers, ...rows] : rows, count);
  // Padding is applied here rather than to the text, so a shared column that has to shrink loses
  // its padding without leaving an ellipsis on a label that was never actually cut.
  if (labelWidth !== undefined) widths[0] = Math.max(widths[0], labelWidth);

  const total = () => widths.reduce((sum, w) => sum + w, 0) + GUTTER * (count - 1);

  while (total() > opts.width) {
    let give = -1;
    for (const kind of ["left", "right"] as Align[]) {
      const floor = kind === "left" ? LABEL_FLOOR : VALUE_FLOOR;
      for (let i = 0; i < count; i++) {
        if (align[i] === kind && widths[i] > floor && (give === -1 || widths[i] > widths[give])) {
          give = i;
        }
      }
      if (give !== -1) break;
    }
    if (give === -1) break;
    widths[give]--;
  }

  const line = (cells: string[]): string => {
    const joined = cells
      .map((c, i) =>
        pad(
          truncate(c ?? "", widths[i], opts.ascii),
          widths[i],
          align[i] === "right" ? "right" : "left",
        ),
      )
      .join(" ".repeat(GUTTER))
      .trimEnd();
    // Every column can be at its floor and the row still not fit, below roughly 20 columns.
    return displayWidth(joined) > opts.width ? sliceToWidth(joined, opts.width) : joined;
  };

  const body = rows.map(line);
  if (!headers) return body;
  return [line(headers), "-".repeat(Math.min(total(), opts.width)), ...body];
}

const REASON_TEXT: Record<string, string> = {
  insufficient_data: "not enough sessions yet to say anything",
  no_consent: "off for your tenant, which has not enabled prompt collection",
  not_implemented: "this backend does not produce it",
};

const STATE_LABELS: Record<string, string> = {
  unobserved: "Unobserved",
  adopted: "Adopted",
  recurring: "Recurring",
  insufficient_data: "Insufficient data",
  "n/a": "n/a",
};

function renderRepertoire(data: Repertoire, opts: RenderOptions): string[] {
  const lines: string[] = [];

  if (data.competencies.length > 0) {
    lines.push(
      ...renderTable(
        data.competencies.map((c) => [
          c.name,
          Object.hasOwn(STATE_LABELS, c.state) ? STATE_LABELS[c.state] : c.state || "-",
          cell(c.share, "share"),
        ]),
        ["left", "left", "right"],
        opts,
        { headers: ["Competency", "State", "% recurring"] },
      ),
    );
  }

  const { recurring, applicable } = data;
  if (recurring !== undefined || applicable !== undefined) {
    if (lines.length > 0) lines.push("");
    // The backend ships the two parts rather than a percentage precisely so the rounding is
    // decided here. One part arriving alone is reported as the half it is, and a count above its
    // own denominator gets no share at all rather than an impossible one.
    if (recurring === undefined) {
      lines.push(
        ...wrap(
          `Coverage index: out of ${applicable} applicable, recurring not reported`,
          opts.width,
        ),
      );
    } else if (applicable === undefined) {
      lines.push(
        ...wrap(`Coverage index: ${recurring} recurring, denominator not reported`, opts.width),
      );
    } else {
      const sane = applicable > 0 && recurring <= applicable;
      const share = sane ? ` = ${formatValue(recurring / applicable, "share")}` : "";
      lines.push(...wrap(`Coverage index: ${recurring} / ${applicable}${share}`, opts.width));
      const gauge = sane
        ? bar(recurring, applicable, Math.min(applicable, opts.width), opts.ascii)
        : "";
      if (gauge) lines.push(gauge);
    }
  }

  const facts: string[] = [];
  if (data.sessions !== undefined) {
    const weeks = data.activeWeeks === undefined ? "" : ` over ${data.activeWeeks} active week(s)`;
    facts.push(`Sessions: ${data.sessions}${weeks}`);
  } else if (data.activeWeeks !== undefined) {
    facts.push(`Active weeks: ${data.activeWeeks}`);
  }
  if (data.artifactBreadth !== undefined) {
    facts.push(`Artifact breadth: ${data.artifactBreadth} distinct skills and commands`);
  }
  // Only the halves that arrived: a `0 manual` the backend never sent is the real-looking zero
  // this report exists to avoid.
  const compaction = [
    data.auto === undefined ? "" : `${data.auto} auto`,
    data.manual === undefined ? "" : `${data.manual} manual`,
  ].filter(Boolean);
  if (compaction.length > 0) facts.push(`Compaction: ${compaction.join(", ")}`);

  if (facts.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const fact of facts) lines.push(...wrap(fact, opts.width));
  }

  if (lines.length === 0) return wrap("This backend produced no fields for it.", opts.width);
  return lines;
}

function renderSignals(signals: Signal[], opts: RenderOptions): string[] {
  if (signals.length === 0) return wrap("This backend produced no signals.", opts.width);

  // One label width across all three blocks, as the model doc draws them, so the eye can run down
  // a signal instead of re-finding it at a new indent in each.
  const labelWidth = signals.reduce((w, s) => Math.max(w, displayWidth(s.label)), 0);

  const lines = renderTable(
    signals.map((s) => [s.label, cell(s.value, s.unit), cell(s.teamMedian, s.unit)]),
    ["left", "right", "right"],
    opts,
    { headers: ["Signal", "You", "Team median"], labelWidth },
  );

  const trended = signals.filter((s) => s.trend.length >= 2);
  if (trended.length > 0) {
    const charts = trended.map((s) => [
      sparkline(s.trend, opts.ascii),
      formatValue(s.trend[0], s.unit),
      formatValue(s.trend[s.trend.length - 1], s.unit),
    ]);

    // Measured against the floor the label can shrink to, not its natural width: the label gives
    // way first, and the chart is dropped only once even a truncated label cannot make room. A
    // value column stops at `VALUE_FLOOR` even when its number is narrower, so leaving that out
    // admitted a chart the row could not hold and the final slice then cut the value beside it.
    const columns = naturalWidths(charts, 3);
    const room =
      LABEL_FLOOR +
        columns[0] +
        Math.max(columns[1], VALUE_FLOOR) +
        Math.max(columns[2], VALUE_FLOOR) +
        GUTTER * 3 <=
      opts.width;

    lines.push("", ...wrap("Trend, weekly", opts.width));
    lines.push(
      ...renderTable(
        trended.map((s, i) =>
          room
            ? [s.label, charts[i][1], charts[i][0], charts[i][2]]
            : [s.label, charts[i][1], charts[i][2]],
        ),
        room ? ["left", "right", "fixed", "right"] : ["left", "right", "right"],
        opts,
        {
          headers: room ? ["Signal", "First", "", "Latest"] : ["Signal", "First", "Latest"],
          labelWidth,
        },
      ),
    );
  }

  // A single point implies a history that does not exist, and an unusable series would draw a
  // chart shorter than the weeks it covers. Both are named rather than silently left out.
  const oneWeek = signals.filter((s) => s.trend.length === 1).map((s) => s.label);
  const unusable = signals.filter((s) => s.trendUnusable).map((s) => s.label);
  if (oneWeek.length > 0) {
    lines.push("", ...wrap(`Only one week of history for: ${oneWeek.join(", ")}`, opts.width));
  }
  if (unusable.length > 0) {
    lines.push("", ...wrap(`Trend not reported for: ${unusable.join(", ")}`, opts.width));
  }

  return lines;
}

function renderCost(data: Cost, opts: RenderOptions): string[] {
  const lines: string[] = [];

  if (data.classes.length > 0) {
    lines.push(...wrap("Sessions by cheapest sufficient class", opts.width));
    lines.push(
      ...renderTable(
        data.classes.map((c) => [`  ${c.label}`, c.amount === undefined ? "-" : String(c.amount)]),
        ["left", "right"],
        opts,
      ),
    );
  }

  if (data.savings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("Could have run cheaper", opts.width));
    // Wrapped once, outside the loop: it is the same text under every row, and re-wrapping it per
    // row made the render cost scale with rows times its length.
    const basis = wrap(data.basis, opts.width, 4);
    const rendered = renderTable(
      data.savings.map((s) => [
        `  ${s.model}`,
        s.usd === undefined ? "-" : formatUsd(s.usd),
        `over ${s.sessions ?? "?"} session(s)`,
      ]),
      ["left", "right", "left"],
      opts,
    );
    // The basis rides next to every figure rather than in a footer, and unconditionally: the
    // schema requires it on an enabled section precisely because a list-price comparison read
    // without it looks like money already saved.
    for (const row of rendered) {
      lines.push(row);
      for (const line of basis) lines.push(line);
    }
  }

  if (data.effort !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(
      ...wrap(`Effort: ${data.effort} session(s) ran higher than the work called for`, opts.width),
    );
  }

  if (data.scopes.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("What you bring", opts.width));
    lines.push(
      ...renderTable(
        data.scopes.map((s) => [`  ${s.label}`, `${s.amount ?? "?"} prompt(s)`]),
        ["left", "right"],
        opts,
      ),
    );
  }

  if (data.cache.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrap("Cache", opts.width));
    lines.push(
      ...renderTable(
        data.cache.map((c) => [`  ${c.label}`, cell(c.share, "share")]),
        ["left", "right"],
        opts,
      ),
    );
  }

  if (lines.length === 0) return wrap("This backend produced no fields for it.", opts.width);
  return lines;
}

function renderSection(section: Section, opts: RenderOptions): string[] {
  const { body } = section;
  if (body.kind === "unavailable") {
    const reason = body.reason ? REASON_TEXT[body.reason] : "not available";
    return wrap(`${section.label}: ${reason}`, opts.width);
  }

  const lines =
    body.kind === "repertoire"
      ? renderRepertoire(body.data, opts)
      : body.kind === "signals"
        ? renderSignals(body.data, opts)
        : renderCost(body.data, opts);

  const out = [...wrap(section.label, opts.width), "", ...lines];
  if (section.dropped > 0) {
    out.push("", ...wrap(`and ${section.dropped} more row(s), not shown.`, opts.width));
  }
  return out;
}

/** The whole report as lines, over a payload `normalize` has already made safe. */
export function renderInsights(report: Report, opts: RenderOptions): string[] {
  const header =
    report.days === undefined
      ? "Your recent work"
      : `Your last ${report.days} day${report.days === 1 ? "" : "s"}`;
  const lines: string[] = wrap(header, opts.width);

  for (const section of report.sections) {
    lines.push("");
    for (const line of renderSection(section, opts)) lines.push(line);
  }

  if (report.sections.length === 0) {
    // Two sections this client cannot draw is not the same as a backend that produces none.
    const text =
      report.unrecognized > 0
        ? `This backend produces ${report.unrecognized} section(s) that this version of pheebs does not render.`
        : "This backend produces no insight sections.";
    lines.push("", ...wrap(text, opts.width));
  }
  return lines;
}
