import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_WINDOW_DAYS, field, isoDay, type Row, repertoireSection } from "./repertoire.js";
import { verificationCoverage } from "./verification.js";

// The window a backend reports when none is asked for, so `days` reads the same from either source.
// Verification coverage runs over it; `repertoire` runs over the model's own four weeks regardless.
export const DEFAULT_DAYS = 30;

const DAY = 86_400_000;

/**
 * Every event in the log directory. A line that is not JSON, or a file that cannot be read, is
 * skipped: one bad line is not a reason to report nothing, and the log is written by hooks that
 * can be killed mid-write.
 */
export function readLogRows(dir: string): unknown[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }

  const rows: unknown[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
  }
  return rows;
}

/**
 * The developer stamps on the rows the report reads, and the rows without one. The counts are not
 * split by them: a log folder is one developer's, so a filter would only hide rows. Two stamps are
 * still reported rather than merged in silence, since two tokens on one machine is the case where
 * the merged number is wrong. Only rows from `since` on are counted, because a stamp on an older
 * row moves no number in the report and would only raise a false two-stamp warning.
 *
 * `unknown` is a stamp a hook wrote when it could not resolve an identity, and a row with no
 * `developer` at all is a different fact, so each is counted on its own and neither is attributed.
 */
export function developersOf(
  rows: unknown[],
  since: string,
): { stamps: string[]; unknown: number; unstamped: number } {
  const stamps = new Set<string>();
  let unknown = 0;
  let unstamped = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const at = Date.parse(field(row as Row, "timestamp") ?? "");
    if (!Number.isFinite(at) || isoDay(new Date(at)) < since) continue;
    const developer = (row as Row).developer;
    if (developer === "unknown") unknown++;
    else if (typeof developer === "string" && developer !== "") stamps.add(developer);
    else unstamped++;
  }
  return { stamps: [...stamps].sort(), unknown, unstamped };
}

/**
 * The report a backend's `/insights` would answer, built from the log alone, in the same shape so
 * the same normalize and render code draws it. `local` marks it for a script reading `--json`.
 *
 * Of the judgement signals only verification coverage can come from the log, since its checks are
 * tool events. The other four rest on prompt labels from a classifier and on telemetry exported to
 * a backend. `unavailable` is the local report's own field, naming why each one is missing, and so
 * is `developers`.
 */
export function localInsights(rows: unknown[], days: number, today: Date): Record<string, unknown> {
  const coverage = verificationCoverage(rows, days, today);
  // The earlier of the two windows: verification coverage's `days` and Repertoire's four weeks.
  const since = isoDay(new Date(today.getTime() - Math.max(days, FULL_WINDOW_DAYS - 1) * DAY));
  return {
    local: true,
    days,
    developers: developersOf(rows, since),
    sections: {
      repertoire: repertoireSection(rows, today),
      judgement_signals: {
        enabled: true,
        ...("value" in coverage && { verification_coverage: coverage }),
        unavailable: {
          ...("reason" in coverage && { verification_coverage: coverage.reason }),
          pushback_rate: "needs_backend",
          refinement_to_repair: "needs_backend",
          wholesale_accept: "needs_backend",
          model_fit: "needs_backend",
        },
      },
    },
  };
}
