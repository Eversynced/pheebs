import {
  bySession,
  field,
  inSession,
  isoDay,
  type Row,
  type Timed,
  TOOL_OUTCOMES,
  VERIFY_INTENTS,
  weekOf,
} from "./repertoire.js";

export type Coverage =
  | { value: number; unit: "share"; trend?: number[] }
  | { reason: "insufficient_data" | "needs_classifier_gate" };

interface Session {
  day: string;
  edited: boolean;
  byTool: boolean;
  /** A prompt asked for a check after an edit, under a classifier the backend may not accept. */
  byLabel: boolean;
}

function sessionOf(events: Timed[]): Session {
  const session: Session = { day: "", edited: false, byTool: false, byLabel: false };
  for (const { row, day } of events) {
    const event = field(row, "event");
    const intent = field(row, "tool_intent");
    if (day > session.day) session.day = day;
    // Only what followed an edit: a check before any change verified nothing the AI wrote.
    if (session.edited) {
      if (TOOL_OUTCOMES.has(event ?? "") && VERIFY_INTENTS.has(intent ?? "")) session.byTool = true;
      if (
        event === "prompt_submitted" &&
        field(row, "requests_verification") === "true" &&
        field(row, "classifier_version")
      ) {
        session.byLabel = true;
      }
    }
    if (event === "tool_use_completed" && intent === "edit") session.edited = true;
  }
  return session;
}

/**
 * Of the sessions with an AI edit, the share where a check followed an edit, read under the
 * definition a backend uses for the same signal, over the same `days` window and weekly trend.
 *
 * A check counts whether the agent ran it or the engineer asked for it. The asking half rests on
 * a prompt label, and a backend counts a label only under a classifier version it has validated:
 * the log carries `classifier_version` but not that verdict. So a session the asking half alone
 * could verify is one this cannot decide, and the signal is withheld rather than undercounted.
 * Without any classifier no prompt carries a version, and the tool half is the whole answer.
 */
export function verificationCoverage(rows: unknown[], days: number, today: Date): Coverage {
  const since = isoDay(new Date(today.getTime() - days * 86_400_000));

  const timed: Timed[] = [];
  for (const value of rows) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Row;
    const at = Date.parse(field(row, "timestamp") ?? "");
    if (Number.isFinite(at) && inSession(row)) timed.push({ row, at, day: isoDay(new Date(at)) });
  }

  // A session belongs to the day it ended on, and it is read whole, even where it began earlier.
  const edited = bySession(timed)
    .map(sessionOf)
    .filter((s) => s.edited && s.day >= since);
  if (edited.length === 0) return { reason: "insufficient_data" };
  if (edited.some((s) => !s.byTool && s.byLabel)) return { reason: "needs_classifier_gate" };

  const share = (of: Session[]) => of.filter((s) => s.byTool).length / of.length;
  const weeks = new Map<string, Session[]>();
  for (const s of edited) weeks.set(weekOf(s.day), [...(weeks.get(weekOf(s.day)) ?? []), s]);
  const trend = [...weeks.keys()].sort().map((w) => share(weeks.get(w) as Session[]));

  return { value: share(edited), unit: "share", ...(trend.length >= 2 && { trend }) };
}
