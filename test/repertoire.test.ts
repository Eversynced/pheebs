import { describe, expect, it } from "vitest";
import { practiceStatesOf, repertoireSection } from "../src/repertoire.js";

// A Monday, so the active weeks below start on 09-28, 10-05, 10-12 and 10-19. The window opens on
// 09-22, and a client version counts as observable for a full window if it was first seen by 09-21.
const TODAY = new Date("2026-10-19T12:00:00Z");
const WEEKS = ["2026-09-29", "2026-10-06", "2026-10-13", "2026-10-19"];

type Fields = Record<string, unknown>;

function ev(day: string, event: string, fields: Fields = {}, time = "10:00:00"): Fields {
  return {
    timestamp: `${day}T${time}.000Z`,
    source: "hook",
    event,
    developer: "tok-1",
    codebase: "acme/app",
    ai_tool: "claude_code",
    session_id: `s-${day}`,
    version: "1.4.0",
    ...fields,
  };
}

// The client was seen long before the window, so every detector it carries is judgeable, and the
// developer has two active weeks, so placement applies.
function base(ai_tool = "claude_code"): Fields[] {
  return [
    ev("2026-09-01", "session_started", { ai_tool, session_id: "old" }),
    ev(WEEKS[1], "session_started", { ai_tool }),
    ev(WEEKS[2], "session_started", { ai_tool }),
  ];
}

describe("repertoireSection", () => {
  it("has nothing to say when no session falls inside the window", () => {
    const rows = [ev("2026-09-01", "session_started")];
    expect(repertoireSection(rows, TODAY)).toEqual({ enabled: false, reason: "insufficient_data" });
  });

  it("counts sessions, weeks, commands and compactions, leaving out manual scans", () => {
    const rows = [
      ev(WEEKS[2], "prompt_submitted", { command_name: "review" }),
      ev(WEEKS[2], "prompt_submitted", { command_name: "deploy" }),
      ev(WEEKS[3], "prompt_submitted", { command_name: "review" }),
      ev(WEEKS[3], "context_compacted", { trigger_type: "auto", ai_tool: "codex" }),
      // Codex fires this after the same compaction, so it is not a second one.
      ev(WEEKS[3], "compaction_completed", { trigger_type: "auto", ai_tool: "codex" }),
      ev(WEEKS[3], "context_compacted", { trigger_type: "manual" }),
      ev(WEEKS[1], "artifact_found", { session_id: "scan", artifact_type: "context_file" }),
    ];
    const section = repertoireSection(rows, TODAY);
    expect(section).toMatchObject({
      enabled: true,
      sessions: 2,
      active_weeks: 2,
      artifact_breadth: 2,
      compaction: { auto: 1, manual: 1 },
    });
  });

  it("judges no practice below two active weeks, and reports no index", () => {
    const section = repertoireSection([ev(WEEKS[3], "subagent_spawned")], TODAY);
    expect(section.coverage_index).toBeUndefined();
    for (const c of section.competencies as { state: string }[]) {
      expect(c.state).toBe("insufficient_data");
    }
  });

  it("reports the coverage index as its two parts, over the practices it can judge", () => {
    const rows = [
      ...base(),
      ...WEEKS.slice(1).map((day) => ev(day, "subagent_spawned")),
      ev(WEEKS[3], "session_started"),
    ];
    const section = repertoireSection(rows, TODAY);
    const states = Object.values(practiceStatesOf(rows, TODAY));
    const judged = states.filter((s) => ["unobserved", "adopted", "recurring"].includes(s));
    expect(section.coverage_index).toEqual({
      recurring: states.filter((s) => s === "recurring").length,
      applicable: judged.length,
    });
    expect(section.competencies).toContainEqual({
      name: "Orchestration",
      state: "recurring",
      recurring_share: 0.2,
    });
  });
});

describe("practiceStatesOf", () => {
  it("places a practice by how many of the last four active weeks it fired in", () => {
    const verify = (day: string) =>
      ev(day, "tool_use_completed", { tool_intent: "test_run" }, "11:00:00");
    const rows = [
      ...base(),
      ...[WEEKS[0], WEEKS[1], WEEKS[3]].map(verify),
      ev(WEEKS[3], "tool_use_completed", { tool_name: "mcp__linear__get_issue" }),
    ];
    const states = practiceStatesOf(rows, TODAY);
    expect(states.EV1).toBe("recurring");
    expect(states.MC1).toBe("adopted");
    expect(states.OR1).toBe("unobserved");
  });

  it("does not judge a detector the client has not carried for a full window", () => {
    const recent = [
      ev("2026-10-01", "session_started", { session_id: "new" }),
      ev(WEEKS[1], "subagent_spawned"),
      ev(WEEKS[2], "subagent_spawned"),
    ];
    expect(practiceStatesOf(recent, TODAY).OR1).toBe("insufficient_data");

    // An old client that predates a detector cannot have emitted it, whatever the engineer did.
    const old = base().map((r) => ({ ...r, version: "0.10.0" }));
    const states = practiceStatesOf(old, TODAY);
    expect(states.EV1).toBe("unobserved");
    expect(states.AR1).toBe("insufficient_data");
  });

  it("reads a practice n/a only when every harness in the mix settles it so", () => {
    const codex = practiceStatesOf(base("codex"), TODAY);
    expect(codex.MD4).toBe("n/a");
    // Unverified is not unsupported.
    expect(codex.CX1).toBe("insufficient_data");
    expect(codex.CX2).toBe("unobserved");

    const mixed = practiceStatesOf([...base("codex"), ...base("claude_code")], TODAY);
    expect(mixed.MD4).toBe("unobserved");
    expect(mixed.MD2).toBe("adopted");
  });

  it("finds split-phase delivery on an effort the plan segment did not use", () => {
    const rows = [
      ...base(),
      ...WEEKS.slice(1).flatMap((day) => [
        ev(day, "prompt_submitted", { permission_mode: "plan", effort: "high", model: "a" }),
        ev(day, "prompt_submitted", { permission_mode: "default", effort: "low", model: "b" }),
      ]),
    ];
    expect(practiceStatesOf(rows, TODAY).MD6).toBe("recurring");
    // MD1 and MD3 to MD6 recur, and single-harness MD2 does not.
    expect(repertoireSection(rows, TODAY).competencies).toContainEqual({
      name: "Models",
      state: "recurring",
      recurring_share: 5 / 6,
    });
  });

  describe("split-phase delivery across a model switch", () => {
    // One session in order, an hour apart, each step an event and its fields.
    const session = (...steps: [string, Fields][]) => [
      ...base(),
      ...steps.map(([event, fields], i) =>
        ev(WEEKS[3], event, { session_id: "split", ...fields }, `1${i}:00:00`),
      ),
    ];
    const plan: [string, Fields] = ["prompt_submitted", { permission_mode: "plan" }];
    const execute: [string, Fields] = ["tool_use_completed", { permission_mode: "acceptEdits" }];
    const start = (fields: Fields = { model: "claude-opus-5[1m]" }): [string, Fields] => [
      "session_started",
      fields,
    ];
    const toSonnet = (fields: Fields): [string, Fields] => [
      "model_switched",
      { to_model: "claude-sonnet-5", ...fields },
    ];

    it("counts a plan segment on one model, then execution on another the engineer chose", () => {
      const rows = session(
        start(),
        plan,
        toSonnet({ from_model: "claude-opus-5[1m]", switch_source: "command" }),
        execute,
      );
      expect(practiceStatesOf(rows, TODAY).MD6).toBe("adopted");
      expect(repertoireSection(rows, TODAY)).not.toHaveProperty("split_phase_undecided");
    });

    it("does not read a switch Claude Code made for itself as a split", () => {
      for (const switch_source of ["auto", "resume", "something_new", undefined]) {
        const rows = session(start(), plan, toSonnet({ switch_source }), execute);
        expect(practiceStatesOf(rows, TODAY).MD6).toBe("unobserved");
      }
    });

    it("does not read a model restored on resume, which fires no switch, as a split", () => {
      const rows = session(start(), plan, start({ start_source: "resume" }), execute);
      expect(practiceStatesOf(rows, TODAY).MD6).toBe("unobserved");
    });

    it("names a resumed session's starting model from the next switch's from_model", () => {
      const resumed = start({ start_source: "resume" });
      const rows = session(
        resumed,
        plan,
        toSonnet({ from_model: "claude-opus-5", switch_source: "picker" }),
        execute,
      );
      expect(practiceStatesOf(rows, TODAY).MD6).toBe("adopted");
    });

    it("counts a change it cannot resolve as undecided, never as Unobserved", () => {
      const rows = session(
        start({ start_source: "resume" }),
        plan,
        toSonnet({ switch_source: "command" }),
        execute,
      );
      expect(practiceStatesOf(rows, TODAY).MD6).toBe("insufficient_data");
      expect(repertoireSection(rows, TODAY).split_phase_undecided).toBe(1);
    });

    it("is not judged on a client from before model switches were captured", () => {
      const rows = session(
        start(),
        plan,
        toSonnet({ from_model: "claude-opus-5", switch_source: "command" }),
        execute,
      ).map((r) => ({ ...r, version: "0.9.5" }));
      expect(practiceStatesOf(rows, TODAY).MD6).toBe("insufficient_data");
    });
  });

  it("reads one model under its date and context-window suffixes", () => {
    const rows = [
      ...base(),
      ev(WEEKS[3], "prompt_submitted", { model: "claude-opus-5[1m]" }),
      ev(WEEKS[3], "prompt_submitted", { model: "claude-opus-5-20260101" }),
    ];
    expect(practiceStatesOf(rows, TODAY).MD1).toBe("unobserved");
    rows.push(ev(WEEKS[3], "prompt_submitted", { model: "claude-sonnet-5" }));
    expect(practiceStatesOf(rows, TODAY).MD1).toBe("adopted");
  });

  it("credits a test-gated ship only when a test ran after the last edit", () => {
    const ship = (steps: Fields[]) => [
      ...base(),
      ...steps.map((fields, i) =>
        ev(WEEKS[3], "tool_use_completed", { ...fields, session_id: "ship" }, `1${i}:00:00`),
      ),
    ];
    const edit: Fields = { tool_intent: "edit" };
    const test: Fields = { tool_intent: "test_run" };
    const commit: Fields = { vcs_action: "commit" };

    expect(practiceStatesOf(ship([edit, test, commit]), TODAY).EV5).toBe("adopted");
    expect(practiceStatesOf(ship([test, edit, commit]), TODAY).EV5).toBe("unobserved");
  });

  it("reads a sequence across the whole session, even when it began before the window", () => {
    const rows = [
      ...base(),
      ev("2026-09-20", "tool_use_completed", { tool_intent: "test_run", session_id: "long" }),
      ev(WEEKS[3], "tool_use_completed", { vcs_action: "push", session_id: "long" }),
    ];
    expect(practiceStatesOf(rows, TODAY).EV5).toBe("adopted");
  });

  it("finds a fix loop on Codex, which reports the failing run", () => {
    const loop = (first: string) => [
      ...base("codex"),
      ev(WEEKS[3], first, { ai_tool: "codex", tool_intent: "test_run" }, "10:00:00"),
      ev(WEEKS[3], "tool_use_completed", { ai_tool: "codex", tool_intent: "edit" }, "11:00:00"),
      ev(WEEKS[3], "tool_use_completed", { ai_tool: "codex", tool_intent: "test_run" }, "12:00:00"),
    ];
    expect(practiceStatesOf(loop("tool_use_failed"), TODAY).EV4).toBe("adopted");
    expect(practiceStatesOf(loop("tool_use_completed"), TODAY).EV4).toBe("unobserved");
  });

  it("reads a field the way a stored event does, whatever JSON type carried it", () => {
    const rows = [...base(), ev(WEEKS[3], "tool_use_started", { run_in_background: true })];
    expect(practiceStatesOf(rows, TODAY).OR2).toBe("adopted");
    const counted = [...base(), ev(WEEKS[3], "turn_ended", { background_task_count: 2 })];
    expect(practiceStatesOf(counted, TODAY).OR2).toBe("adopted");
  });

  it("counts only custom agent types toward agent breadth", () => {
    const spawn = (agent_type: string) => ev(WEEKS[3], "subagent_spawned", { agent_type });
    const builtIns = [...base(), spawn("Explore"), spawn("general-purpose")];
    expect(practiceStatesOf(builtIns, TODAY).OR3).toBe("unobserved");
    const custom = [...base(), spawn("reviewer"), spawn("test-runner")];
    expect(practiceStatesOf(custom, TODAY).OR3).toBe("adopted");
  });

  it("skips rows that are not events or have no usable time", () => {
    const rows = [
      ...base(),
      null,
      "text",
      [],
      ev(WEEKS[3], "subagent_spawned", { timestamp: "x" }),
    ];
    expect(practiceStatesOf(rows, TODAY).OR1).toBe("unobserved");
  });
});
