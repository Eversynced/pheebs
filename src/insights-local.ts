import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repertoireSection } from "./repertoire.js";

// The window a backend reports when none is asked for, so `days` reads the same from either source.
// Only `repertoire` is computed here, and it runs over the model's own four weeks whatever this is.
export const DEFAULT_DAYS = 30;

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
 * The report a backend's `/insights` would answer, built from the log alone, in the same shape so
 * the same normalize and render code draws it. `local` marks it for a script reading `--json`.
 * Judgement signals stay unavailable: they rest on prompt labels from a classifier and on
 * telemetry exported to a backend, and neither is in the log.
 */
export function localInsights(rows: unknown[], days: number, today: Date): Record<string, unknown> {
  return {
    local: true,
    days,
    sections: {
      repertoire: repertoireSection(rows, today),
      judgement_signals: { enabled: false, reason: "needs_backend" },
    },
  };
}
