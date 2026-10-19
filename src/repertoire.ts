// Layer 1 from rows of the local log, under the same definitions a backend computing the
// `repertoire` section uses, so a number means the same thing whichever one produced it. The
// practices, their detectors and the per-harness table are the registry's
// (docs/ai-proficiency-model-practice-and-signal-registry.md); the states, the window and placement
// are the model's (docs/ai-proficiency-model.md). Pure: the caller reads the log and passes `today`.

type Row = Record<string, unknown>;

export type PracticeState = "unobserved" | "adopted" | "recurring" | "insufficient_data" | "n/a";
export type CompetencyState = Exclude<PracticeState, "n/a">;

export interface Competency {
  name: string;
  state: CompetencyState;
  recurring_share?: number;
}

/** The facts behind every practice for one harness on one UTC day. */
interface PracticeDay {
  ai_tool: string;
  day: string;
  md1_models: Set<string>;
  md3_efforts: Set<string>;
  md5_modes: Set<string>;
  ar3_commands: Set<string>;
  mc2_servers: Set<string>;
  or3_agents: Set<string>;
  flags: Set<Flag>;
}

type Flag =
  | "ar1"
  | "ar2"
  | "mc1"
  | "ev1"
  | "ev2"
  | "ev3"
  | "ev4"
  | "ev5"
  | "cx1"
  | "cx2"
  | "or1"
  | "or2"
  | "or6"
  | "or7"
  | "md4";
type Values = "md1_models" | "md3_efforts" | "md5_modes" | "ar3_commands" | "mc2_servers";

interface ClientVersion {
  ai_tool: string;
  version: string;
  first_day: string;
}

/** The model's trailing window, four calendar weeks, which is also how long a detector must have
 * been observable before it is judged. */
export const FULL_WINDOW_DAYS = 28;

// A field as text, the way a stored event's extras read: a boolean `true` and the string "true"
// are the same fact, and a number compares by its digits.
function field(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

const filled = (row: Row, key: string): string | undefined => {
  const value = field(row, key);
  return value ? value : undefined;
};

// Date and context-window suffixes are stripped, so claude-opus-5[1m] and claude-opus-5-20260101
// are one model rather than three.
function canonicalModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-[0-9]{8}$/, "");
}

/** The Monday that starts a date's UTC week. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return isoDay(date);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// A version that does not parse is not known to carry the field, so it does not qualify. A
// pre-release sorts below its release, as semver orders them.
function atLeast(version: string, min: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) } : undefined;
  };
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return !a.pre || b.pre;
}

type Harness = "claude_code" | "cursor" | "codex";

// Per harness, the registry's cell for the practice and the first client version that emits its
// field. `n/a` is settled: the harness cannot report it. `unverified` is the registry's "never
// produced the value the practice needs", which reads Insufficient data rather than n/a, because
// unverified is not unsupported.
type Cell = { since: string } | "n/a" | "unverified";

interface Practice {
  /** How a week, or the whole window, fires. */
  fired: (days: PracticeDay[]) => boolean;
  cells: Record<Harness, Cell>;
  /** Its detector joins telemetry that is exported to a backend and never written to the log. */
  needsBackend?: true;
}

const flag = (name: Flag) => (days: PracticeDay[]) => days.some((d) => d.flags.has(name));

// "2+ distinct" practices fire on the union over the span, never per day.
const distinct = (name: Values) => (days: PracticeDay[]) =>
  new Set(days.flatMap((d) => [...d[name]])).size >= 2;

// Agent breadth counts custom agent types only. The table is the whole rule: a type not in it
// counts as custom, so a new built-in is added here rather than guessed from its name.
const BUILT_IN_AGENTS = new Set([
  "general-purpose",
  "explore",
  "plan",
  "statusline-setup",
  "output-style-setup",
  "claude-code-guide",
  "workflow-subagent",
  "browseruse",
  "cursorguide",
]);

const customAgents = (days: PracticeDay[]) =>
  new Set(
    days.flatMap((d) => [...d.or3_agents]).filter((a) => !BUILT_IN_AGENTS.has(a.toLowerCase())),
  ).size >= 2;

const all = (since: string): Record<Harness, Cell> => ({
  claude_code: { since },
  cursor: { since },
  codex: { since },
});

const PRACTICES: Record<string, Practice> = {
  MD1: { fired: distinct("md1_models"), cells: all("0.3.0") },
  MD2: { fired: (days) => new Set(days.map((d) => d.ai_tool)).size >= 2, cells: all("0.2.4") },
  MD3: {
    fired: distinct("md3_efforts"),
    cells: { claude_code: { since: "0.9.0" }, cursor: { since: "1.0.0" }, codex: "n/a" },
  },
  MD4: {
    fired: flag("md4"),
    cells: { claude_code: { since: "0.9.0" }, cursor: "n/a", codex: "n/a" },
  },
  MD5: {
    fired: distinct("md5_modes"),
    cells: { claude_code: { since: "0.9.0" }, cursor: "n/a", codex: "n/a" },
  },
  // Its model half reads tokens-by-model from OpenTelemetry. Computing only the effort half would
  // report an engineer who switches models as never splitting phases, which is a claim about them
  // drawn from a gap in what this machine keeps.
  MD6: {
    fired: () => false,
    cells: { claude_code: { since: "0.9.0" }, cursor: "n/a", codex: "n/a" },
    needsBackend: true,
  },
  AR1: { fired: flag("ar1"), cells: all("0.15.0") },
  AR2: {
    fired: flag("ar2"),
    cells: { claude_code: { since: "0.3.0" }, cursor: { since: "0.10.0" }, codex: "n/a" },
  },
  AR3: {
    fired: distinct("ar3_commands"),
    cells: { claude_code: { since: "0.3.0" }, cursor: { since: "0.10.0" }, codex: "n/a" },
  },
  MC1: {
    fired: flag("mc1"),
    cells: {
      claude_code: { since: "0.2.4" },
      cursor: { since: "0.13.0" },
      codex: { since: "0.13.0" },
    },
  },
  MC2: { fired: distinct("mc2_servers"), cells: all("0.13.0") },
  EV1: { fired: flag("ev1"), cells: all("0.8.0") },
  EV2: { fired: flag("ev2"), cells: all("0.8.0") },
  EV3: { fired: flag("ev3"), cells: all("0.12.0") },
  // Claude Code and Cursor report a red test run as a completed tool call, so the failure the fix
  // loop starts from has never been observed there.
  EV4: {
    fired: flag("ev4"),
    cells: { claude_code: "unverified", cursor: "unverified", codex: { since: "0.14.0" } },
  },
  EV5: { fired: flag("ev5"), cells: all("0.14.0") },
  CX1: {
    fired: flag("cx1"),
    cells: { claude_code: { since: "0.2.4" }, cursor: { since: "0.2.4" }, codex: "unverified" },
  },
  CX2: {
    fired: flag("cx2"),
    cells: { claude_code: { since: "0.2.4" }, cursor: "n/a", codex: { since: "0.2.4" } },
  },
  OR1: { fired: flag("or1"), cells: all("0.2.4") },
  OR2: {
    fired: flag("or2"),
    cells: { claude_code: { since: "0.3.0" }, cursor: { since: "0.3.0" }, codex: "n/a" },
  },
  OR3: { fired: customAgents, cells: all("0.2.4") },
  OR6: { fired: flag("or6"), cells: all("0.15.0") },
  OR7: {
    fired: flag("or7"),
    cells: { claude_code: { since: "0.15.0" }, cursor: "n/a", codex: "n/a" },
  },
};

// Context management has two anchors, each "where applicable": either one is enough to judge it,
// and when both can be judged the stronger state is the one the engineer has shown. The compaction
// split is a team stat and sits outside every share and the index.
const COMPETENCIES: { name: string; anchors: string[]; stats: string[] }[] = [
  { name: "Models", anchors: ["MD1"], stats: ["MD2", "MD3", "MD4", "MD5", "MD6"] },
  { name: "Artifacts", anchors: ["AR2"], stats: ["AR1", "AR3"] },
  { name: "MCP", anchors: ["MC1"], stats: ["MC2"] },
  { name: "Evals", anchors: ["EV1"], stats: ["EV2", "EV3", "EV4", "EV5"] },
  { name: "Context management", anchors: ["CX1", "CX2"], stats: [] },
  { name: "Orchestration", anchors: ["OR1"], stats: ["OR2", "OR3", "OR6", "OR7"] },
];

const RANK: Record<CompetencyState, number> = {
  insufficient_data: 0,
  unobserved: 1,
  adopted: 2,
  recurring: 3,
};

const JUDGED: PracticeState[] = ["unobserved", "adopted", "recurring"];

/** A row with a usable time, and the UTC day it falls on. */
interface Timed {
  row: Row;
  at: number;
  day: string;
}

// A manual `pheebs scan` is stamped with the session id "scan" because it has no session. It is
// not a session, so it neither counts as one nor makes a week active.
function inSession(row: Row): boolean {
  const id = field(row, "session_id") ?? "";
  return id !== "" && id !== "scan";
}

function practiceDay(ai_tool: string, day: string): PracticeDay {
  return {
    ai_tool,
    day,
    md1_models: new Set(),
    md3_efforts: new Set(),
    md5_modes: new Set(),
    ar3_commands: new Set(),
    mc2_servers: new Set(),
    or3_agents: new Set(),
    flags: new Set(),
  };
}

const VERIFY_INTENTS = new Set(["test_run", "build", "typecheck", "lint"]);
const TOOL_OUTCOMES = new Set(["tool_use_completed", "tool_use_failed"]);
const SHIPS = new Set(["commit", "push", "pr_create"]);

function addFacts(day: PracticeDay, row: Row): void {
  const event = field(row, "event");
  const add = (name: Flag, when: boolean) => {
    if (when) day.flags.add(name);
  };

  const model = filled(row, "model");
  if (model) day.md1_models.add(canonicalModel(model));
  const effort = filled(row, "effort");
  if (effort) day.md3_efforts.add(effort);
  const mode = filled(row, "permission_mode");
  if (mode) day.md5_modes.add(mode);
  const command = filled(row, "command_name");
  if (command) day.ar3_commands.add(command);
  const server = filled(row, "mcp_server_name");
  if (server) day.mc2_servers.add(server);
  const agent = filled(row, "agent_type");
  if (event === "subagent_spawned" && agent) day.or3_agents.add(agent);

  const artifact = field(row, "artifact_type");
  const intent = field(row, "tool_intent");
  add("ar2", command !== undefined);
  add("mc1", (field(row, "tool_name") ?? "").startsWith("mcp__") || server !== undefined);
  add("ev1", TOOL_OUTCOMES.has(event ?? "") && VERIFY_INTENTS.has(intent ?? ""));
  add("cx1", event === "context_compacted" && field(row, "trigger_type") === "manual");
  add(
    "cx2",
    event === "session_started" && ["resume", "clear"].includes(field(row, "start_source") ?? ""),
  );
  add("or1", event === "subagent_spawned");
  add("md4", mode === "plan");
  add(
    "ar1",
    (event === "artifact_found" && artifact === "context_file") || event === "instructions_loaded",
  );
  add("ev2", event === "subagent_spawned" && field(row, "role") === "review");
  add("ev3", event === "artifact_found" && artifact === "eval_harness");
  add(
    "or2",
    field(row, "run_in_background") === "true" ||
      event === "task_created" ||
      /^[1-9][0-9]*$/.test(field(row, "background_task_count") ?? "") ||
      (event === "subagent_spawned" && field(row, "is_parallel_worker") === "true"),
  );
  add("or6", event === "artifact_found" && artifact === "hook_config");
  add("or7", event === "artifact_found" && artifact === "plugin_enabled");
}

/**
 * The fix loop and the test-gated ship are sequences inside one session, so each event is read
 * against only what came before it there, over the whole session: a sequence that began before
 * the window still counts, credited to the day of the step that completes it.
 */
function markPatterns(timed: Timed[], days: Map<string, PracticeDay>): void {
  const sessions = new Map<string, Timed[]>();
  for (const t of timed) {
    const id = field(t.row, "session_id") as string;
    const list = sessions.get(id);
    if (list) list.push(t);
    else sessions.set(id, [t]);
  }

  for (const events of sessions.values()) {
    // Stable, so events with one timestamp keep the order they were written in.
    events.sort((a, b) => a.at - b.at);
    let lastEdit: number | undefined;
    let lastTest: number | undefined;
    let firstFail: number | undefined;

    for (const { row, at, day } of events) {
      const event = field(row, "event");
      const intent = field(row, "tool_intent");
      const completed = event === "tool_use_completed";
      const isTest = TOOL_OUTCOMES.has(event ?? "") && intent === "test_run";
      const isPass = completed && intent === "test_run";
      const isFail = event === "tool_use_failed" && intent === "test_run";
      const isEdit = completed && intent === "edit";
      const isShip = completed && SHIPS.has(field(row, "vcs_action") ?? "");

      const target = days.get(`${field(row, "ai_tool") ?? ""}|${day}`);
      if (target) {
        if (isPass && firstFail !== undefined && lastEdit !== undefined && firstFail < lastEdit) {
          target.flags.add("ev4");
        }
        if (isShip && lastTest !== undefined && (lastEdit === undefined || lastTest > lastEdit)) {
          target.flags.add("ev5");
        }
      }

      if (isEdit) lastEdit = at;
      if (isTest) lastTest = at;
      if (isFail && firstFail === undefined) firstFail = at;
    }
  }
}

function practiceStates(
  days: PracticeDay[],
  versions: ClientVersion[],
  today: Date,
): Record<string, PracticeState> {
  const weeks = [...new Set(days.map((d) => weekOf(d.day)))].sort().reverse();
  // Placement needs two active weeks. Below that every practice is a statement about the
  // measurement, never Unobserved, which would be a claim about the engineer.
  if (weeks.length < 2) {
    return Object.fromEntries(Object.keys(PRACTICES).map((id) => [id, "insufficient_data"]));
  }
  const lastFour = weeks.slice(0, 4);
  const mix = [...new Set(days.map((d) => d.ai_tool))];
  const cutoff = isoDay(new Date(today.getTime() - FULL_WINDOW_DAYS * 86_400_000));

  const stateOf = (practice: Practice): PracticeState => {
    const cells = mix.map((tool) => practice.cells[tool as Harness]);
    // n/a only when every harness in the mix settles it so. A harness this table has no row for
    // is unknown, not unsupported.
    if (cells.every((cell) => cell === "n/a")) return "n/a";
    if (practice.needsBackend) return "insufficient_data";
    const judgeable = mix.some((tool, i) => {
      const cell = cells[i];
      if (cell === undefined || typeof cell === "string") return false;
      return versions.some(
        (v) => v.ai_tool === tool && atLeast(v.version, cell.since) && v.first_day <= cutoff,
      );
    });
    if (!judgeable) return "insufficient_data";

    const firedWeeks = lastFour.filter((w) =>
      practice.fired(days.filter((d) => weekOf(d.day) === w)),
    );
    if (firedWeeks.length >= 3) return "recurring";
    return practice.fired(days) ? "adopted" : "unobserved";
  };

  return Object.fromEntries(Object.entries(PRACTICES).map(([id, p]) => [id, stateOf(p)]));
}

function competencyStates(practices: Record<string, PracticeState>): Competency[] {
  return COMPETENCIES.map(({ name, anchors, stats }) => {
    const anchorStates = anchors
      .map((id) => practices[id])
      .filter((s): s is CompetencyState => s !== "n/a" && s !== "insufficient_data");
    // No judgeable anchor on this harness mix: the harness gave us nothing to judge it by.
    const state =
      anchorStates.length === 0
        ? "insufficient_data"
        : anchorStates.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    const competency: Competency = { name, state };

    const judged = [...anchors, ...stats]
      .map((id) => practices[id])
      .filter((s) => JUDGED.includes(s));
    if (judged.length > 0) {
      competency.recurring_share = judged.filter((s) => s === "recurring").length / judged.length;
    }
    return competency;
  });
}

interface Window {
  /** Rows in a session, inside the window. */
  windowed: Timed[];
  days: PracticeDay[];
  versions: ClientVersion[];
}

// Rows that are not events, or carry no usable time, are skipped rather than guessed at.
function readWindow(rows: unknown[], today: Date): Window {
  const since = isoDay(new Date(today.getTime() - (FULL_WINDOW_DAYS - 1) * 86_400_000));

  const timed: Timed[] = [];
  // Not windowed and not limited to sessions: a detector is observable from the first day a
  // qualifying client was seen, which can be long before the window opens.
  const firstSeen = new Map<string, ClientVersion>();
  for (const value of rows) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Row;
    const at = Date.parse(field(row, "timestamp") ?? "");
    if (!Number.isFinite(at)) continue;
    const day = isoDay(new Date(at));

    const version = filled(row, "version");
    if (version) {
      const ai_tool = field(row, "ai_tool") ?? "";
      const key = `${ai_tool}|${version}`;
      const seen = firstSeen.get(key);
      if (!seen || day < seen.first_day) firstSeen.set(key, { ai_tool, version, first_day: day });
    }
    if (inSession(row)) timed.push({ row, at, day });
  }

  const windowed = timed.filter((t) => t.day >= since);
  const days = new Map<string, PracticeDay>();
  for (const { row, day } of windowed) {
    const ai_tool = field(row, "ai_tool") ?? "";
    const key = `${ai_tool}|${day}`;
    let practice = days.get(key);
    if (!practice) {
      practice = practiceDay(ai_tool, day);
      days.set(key, practice);
    }
    addFacts(practice, row);
  }
  markPatterns(timed, days);

  return { windowed, days: [...days.values()], versions: [...firstSeen.values()] };
}

/** Every practice's state, keyed by registry id. */
export function practiceStatesOf(rows: unknown[], today: Date): Record<string, PracticeState> {
  const { days, versions } = readWindow(rows, today);
  return practiceStates(days, versions, today);
}

/** The `repertoire` section as the contract shapes it, over every row of the log. */
export function repertoireSection(rows: unknown[], today: Date): Record<string, unknown> {
  const { windowed, days, versions } = readWindow(rows, today);
  // No sessions is not zero sessions' worth of practice: there is nothing to say yet.
  if (windowed.length === 0) return { enabled: false, reason: "insufficient_data" };

  const sessions = new Set<string>();
  const weeks = new Set<string>();
  const commands = new Set<string>();
  let auto = 0;
  let manual = 0;
  for (const { row, day } of windowed) {
    sessions.add(field(row, "session_id") as string);
    weeks.add(weekOf(day));
    const command = filled(row, "command_name");
    if (command) commands.add(command);
    // `context_compacted` only: Codex follows each compaction with `compaction_completed`, and
    // counting both would report every Codex compaction twice.
    if (field(row, "event") === "context_compacted") {
      const trigger = field(row, "trigger_type");
      if (trigger === "auto") auto++;
      if (trigger === "manual") manual++;
    }
  }

  const states = practiceStates(days, versions, today);
  const judged = Object.values(states).filter((s) => JUDGED.includes(s));

  return {
    enabled: true,
    sessions: sessions.size,
    active_weeks: weeks.size,
    // Absent rather than 0 / 0 when nothing can be judged, which would read as an index.
    ...(judged.length > 0 && {
      coverage_index: {
        recurring: judged.filter((s) => s === "recurring").length,
        applicable: judged.length,
      },
    }),
    artifact_breadth: commands.size,
    compaction: { auto, manual },
    competencies: competencyStates(states),
  };
}
