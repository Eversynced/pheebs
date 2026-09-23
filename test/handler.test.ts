import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractClaudeExtra,
  extractCodexExtra,
  extractCursorExtra,
  handleHookEvent,
} from "../src/hooks/handler.js";

describe("extractClaudeExtra", () => {
  it("pulls session_started source and model", () => {
    const extra = extractClaudeExtra({ source: "startup", model: "opus" }, [], "session_started");
    expect(extra).toEqual({ start_source: "startup", model: "opus" });
  });

  it("captures model only on session_started, never on recurring events", () => {
    // Recurring hooks carry no `model`, so the current model is reconstructed from
    // the session_started snapshot plus any model_switched. This test pins that
    // limitation: flip it deliberately if Claude ever emits model per-event.
    for (const event of ["tool_use_completed", "turn_ended", "prompt_submitted"]) {
      expect(extractClaudeExtra({ model: "opus" }, [], event).model).toBeUndefined();
    }
    expect(extractClaudeExtra({ model: "opus" }, [], "session_started").model).toBe("opus");
  });

  it("counts turn_ended background tasks and crons", () => {
    const extra = extractClaudeExtra(
      { stop_hook_active: true, background_tasks: [1, 2], session_crons: [1] },
      [],
      "turn_ended",
    );
    expect(extra).toEqual({
      stop_hook_active: true,
      background_task_count: 2,
      session_cron_count: 1,
    });
  });

  it("reads trigger type from cliArgs", () => {
    const extra = extractClaudeExtra({}, ["--trigger-type", "manual"], "context_compacted");
    expect(extra.trigger_type).toBe("manual");
  });

  it("ignores fields of the wrong type", () => {
    const extra = extractClaudeExtra(
      { tool_name: 42, duration_ms: "slow" },
      [],
      "tool_use_completed",
    );
    expect(extra).toEqual({ tool_intent: "other" });
  });

  it("derives tool_intent from the Bash command without persisting it", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Bash", tool_input: { command: "pytest tests/unit" } },
      [],
      "tool_use_completed",
    );
    expect(extra.tool_intent).toBe("test_run");
    expect(JSON.stringify(extra)).not.toContain("pytest");
    expect(extra.command).toBeUndefined();
  });

  it("derives vcs_action on VCS commands without persisting the command", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Bash", tool_input: { command: "git add -A && git commit -m 'wip'" } },
      [],
      "tool_use_completed",
    );
    expect(extra.tool_intent).toBe("vcs");
    expect(extra.vcs_action).toBe("commit");
    expect(JSON.stringify(extra)).not.toContain("wip");
    expect(extra.command).toBeUndefined();
  });

  it("tags read-only VCS as other and omits vcs_action for non-VCS intents", () => {
    expect(
      extractClaudeExtra(
        { tool_name: "Bash", tool_input: { command: "git status" } },
        [],
        "tool_use_completed",
      ).vcs_action,
    ).toBe("other");
    expect(
      extractClaudeExtra(
        { tool_name: "Bash", tool_input: { command: "pytest" } },
        [],
        "tool_use_completed",
      ).vcs_action,
    ).toBeUndefined();
    expect(
      extractClaudeExtra({ tool_name: "Read" }, [], "tool_use_completed").vcs_action,
    ).toBeUndefined();
  });

  it("derives tool_intent from the tool name for read/edit tools", () => {
    expect(extractClaudeExtra({ tool_name: "Read" }, [], "tool_use_completed").tool_intent).toBe(
      "read",
    );
    expect(extractClaudeExtra({ tool_name: "Edit" }, [], "tool_use_failed").tool_intent).toBe(
      "edit",
    );
  });

  it("derives mcp_server_name from an mcp__<server>__<method> tool_name", () => {
    const extra = extractClaudeExtra(
      { tool_name: "mcp__linear__list_issues" },
      [],
      "tool_use_completed",
    );
    expect(extra.mcp_server_name).toBe("linear");
    expect(extra.tool_name).toBe("mcp__linear__list_issues");
  });

  it("flags a backgrounded Bash call without persisting the command", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Bash", tool_input: { command: "npm run dev", run_in_background: true } },
      [],
      "tool_use_completed",
    );
    expect(extra.run_in_background).toBe(true);
    expect(JSON.stringify(extra)).not.toContain("npm run dev");
  });

  it("omits the flag for a foreground call and for an explicit false", () => {
    expect(
      extractClaudeExtra(
        { tool_name: "Bash", tool_input: { command: "ls" } },
        [],
        "tool_use_completed",
      ).run_in_background,
    ).toBeUndefined();
    expect(
      extractClaudeExtra(
        { tool_name: "Bash", tool_input: { command: "ls", run_in_background: false } },
        [],
        "tool_use_completed",
      ).run_in_background,
    ).toBeUndefined();
  });

  it("carries run_in_background onto a failed backgrounded call", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Bash", tool_input: { run_in_background: true } },
      [],
      "tool_use_failed",
    );
    expect(extra.run_in_background).toBe(true);
  });

  it("keeps single underscores in the server name (splits on the first __ delimiter)", () => {
    const extra = extractClaudeExtra(
      { tool_name: "mcp__claude_ai_Google_Calendar__create_event" },
      [],
      "tool_use_failed",
    );
    expect(extra.mcp_server_name).toBe("claude_ai_Google_Calendar");
  });

  it("omits mcp_server_name for non-MCP tool events", () => {
    expect(extractClaudeExtra({ tool_name: "Read" }, [], "tool_use_completed")).not.toHaveProperty(
      "mcp_server_name",
    );
  });

  it("captures the Skill tool's skill name as command_name", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Skill", tool_input: { skill: "demo-context-prepare" } },
      [],
      "tool_use_completed",
    );
    expect(extra.command_name).toBe("demo-context-prepare");
    expect(extra.tool_name).toBe("Skill");
  });

  it("does not set command_name for non-Skill tools", () => {
    const extra = extractClaudeExtra(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      [],
      "tool_use_completed",
    );
    expect(extra.command_name).toBeUndefined();
  });

  it("tags the spawned subagent role from agent_type", () => {
    expect(extractClaudeExtra({ agent_type: "code-reviewer" }, [], "subagent_spawned").role).toBe(
      "review",
    );
    expect(extractClaudeExtra({ agent_type: "general-purpose" }, [], "subagent_spawned").role).toBe(
      "generate",
    );
  });

  it("captures load_reason and memory_type on instructions_loaded without the file path", () => {
    const extra = extractClaudeExtra(
      { load_reason: "session_start", memory_type: "Project", file_path: "/repo/secret/CLAUDE.md" },
      [],
      "instructions_loaded",
    );
    expect(extra).toEqual({ load_reason: "session_start", memory_type: "Project" });
    expect(JSON.stringify(extra)).not.toContain("secret");
  });

  it("captures from_model, to_model and switch_source on model_switched", () => {
    const extra = extractClaudeExtra(
      {
        from_model: "claude-opus-5[1m]",
        to_model: "claude-sonnet-5",
        requested_model: "sonnet",
        source: "command",
        context_tokens: 62203,
        estimated_cache_write_usd: 0.622,
      },
      [],
      "model_switched",
    );
    expect(extra).toEqual({
      from_model: "claude-opus-5[1m]",
      to_model: "claude-sonnet-5",
      switch_source: "command",
    });
  });

  it("passes an automatic switch source through rather than suppressing the event", () => {
    // The vendor uses one hook for both, so the consumer decides what counts as
    // deliberate, not the client.
    const extra = extractClaudeExtra(
      { from_model: "claude-opus-5", to_model: "claude-sonnet-5", source: "resume" },
      [],
      "model_switched",
    );
    expect(extra.switch_source).toBe("resume");
  });

  it("leaves model_switched fields unset when the payload omits or mistypes them", () => {
    expect(extractClaudeExtra({ to_model: "claude-sonnet-5" }, [], "model_switched")).toEqual({
      to_model: "claude-sonnet-5",
    });
    expect(extractClaudeExtra({ from_model: 42, source: null }, [], "model_switched")).toEqual({});
  });

  it("captures permission_mode and effort level across events", () => {
    const onTool = extractClaudeExtra(
      { tool_name: "Read", permission_mode: "plan", effort: { level: "high" } },
      [],
      "tool_use_completed",
    );
    expect(onTool).toMatchObject({ permission_mode: "plan", effort: "high" });

    const onTurn = extractClaudeExtra(
      { permission_mode: "acceptEdits", effort: { level: "medium" } },
      [],
      "turn_ended",
    );
    expect(onTurn).toMatchObject({ permission_mode: "acceptEdits", effort: "medium" });
  });

  it("omits permission_mode and effort when absent or malformed", () => {
    const extra = extractClaudeExtra(
      { permission_mode: 1, effort: { level: 42 } },
      [],
      "tool_use_completed",
    );
    expect(extra.permission_mode).toBeUndefined();
    expect(extra.effort).toBeUndefined();
  });

  it("captures prompt_length on prompt_submitted without persisting the prompt", () => {
    const prompt = "Here is the full spec, mockups and screenshots pasted up front: secret details";
    const extra = extractClaudeExtra({ prompt }, [], "prompt_submitted");
    expect(extra.prompt_length).toBe(prompt.length);
    expect(JSON.stringify(extra)).not.toContain("secret details");
  });

  it("omits prompt_length when the prompt is absent or not a string", () => {
    expect(extractClaudeExtra({}, [], "prompt_submitted").prompt_length).toBeUndefined();
    expect(
      extractClaudeExtra({ prompt: 42 }, [], "prompt_submitted").prompt_length,
    ).toBeUndefined();
  });

  it("counts lines_changed from an Edit's structuredPatch", () => {
    const extra = extractClaudeExtra(
      {
        tool_name: "Edit",
        tool_response: {
          filePath: "/repo/secret/path.ts",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 6,
              newStart: 1,
              newLines: 8,
              lines: [" keep", "-gone", "+one", "+two", "+three", " keep"],
            },
          ],
        },
      },
      [],
      "tool_use_completed",
    );
    expect(extra.lines_changed).toBe(4);
    expect(JSON.stringify(extra)).not.toContain("secret/path");
  });

  it("sums lines_changed across multiple hunks", () => {
    const extra = extractClaudeExtra(
      {
        tool_name: "Edit",
        tool_response: {
          structuredPatch: [{ lines: [" a", "-b", "+c"] }, { lines: [" d", "-e", "-f", "+g"] }],
        },
      },
      [],
      "tool_use_completed",
    );
    expect(extra.lines_changed).toBe(5);
  });

  it("counts a Write create as its full body, dropping the trailing newline", () => {
    const extra = extractClaudeExtra(
      {
        tool_name: "Write",
        tool_response: { type: "create", content: "one\ntwo\nthree\n", structuredPatch: [] },
      },
      [],
      "tool_use_completed",
    );
    expect(extra.lines_changed).toBe(3);
  });

  it("counts a Write over an existing file from its patch, not its body", () => {
    // A 40-line file overwritten with 12 lines is a real diff — treating every
    // Write as a full-body count would materially over-report.
    const extra = extractClaudeExtra(
      {
        tool_name: "Write",
        tool_response: {
          type: "update",
          content: "a\nb\nc\n",
          structuredPatch: [{ lines: [" keep", "-x", "-y", " keep"] }],
        },
      },
      [],
      "tool_use_completed",
    );
    expect(extra.lines_changed).toBe(2);
  });

  it("counts a NotebookEdit from its cell sources, treating a replace as a whole-cell rewrite", () => {
    const replace = extractClaudeExtra(
      {
        tool_name: "NotebookEdit",
        tool_response: { edit_mode: "replace", old_source: "a\nb\nc", new_source: "x\ny" },
      },
      [],
      "tool_use_completed",
    );
    expect(replace.lines_changed).toBe(5);

    // insert carries no old_source; delete carries an empty new_source.
    const insert = extractClaudeExtra(
      { tool_name: "NotebookEdit", tool_response: { edit_mode: "insert", new_source: "a\nb" } },
      [],
      "tool_use_completed",
    );
    expect(insert.lines_changed).toBe(2);

    const del = extractClaudeExtra(
      {
        tool_name: "NotebookEdit",
        tool_response: { edit_mode: "delete", old_source: "a\nb\nc\nd", new_source: "" },
      },
      [],
      "tool_use_completed",
    );
    expect(del.lines_changed).toBe(4);
  });

  it("leaves lines_changed unset on a failed edit and on non-edit tools", () => {
    const failed = extractClaudeExtra(
      { tool_name: "Edit", tool_response: { structuredPatch: [{ lines: ["+a"] }] } },
      [],
      "tool_use_failed",
    );
    expect(failed).not.toHaveProperty("lines_changed");

    const read = extractClaudeExtra(
      { tool_name: "Read", tool_response: { file: "x" } },
      [],
      "tool_use_completed",
    );
    expect(read).not.toHaveProperty("lines_changed");
  });

  it("leaves lines_changed unset when the edit payload has no readable shape", () => {
    // undefined, never 0: 0 is a real "this edit changed nothing" measurement.
    for (const response of [undefined, {}, { structuredPatch: "nope" }]) {
      expect(
        extractClaudeExtra(
          { tool_name: "Edit", tool_response: response },
          [],
          "tool_use_completed",
        ),
      ).not.toHaveProperty("lines_changed");
    }
    expect(
      extractClaudeExtra(
        { tool_name: "Write", tool_response: { type: "create" } },
        [],
        "tool_use_completed",
      ),
    ).not.toHaveProperty("lines_changed");
  });

  it("leaves lines_changed unset on a Write whose type is absent or unrecognized", () => {
    // Only "create" and "update" are shapes we have captured; anything else is a
    // payload we do not know, and a patch count there would be a guess.
    for (const type of [undefined, "moved"]) {
      expect(
        extractClaudeExtra(
          {
            tool_name: "Write",
            tool_response: { type, structuredPatch: [{ lines: ["+a", "-b"] }] },
          },
          [],
          "tool_use_completed",
        ),
      ).not.toHaveProperty("lines_changed");
    }
  });

  it("leaves lines_changed unset when a notebook cell source is present but not a string", () => {
    // Absent is legitimate — `insert` carries no old_source — but a non-string is an
    // unknown shape and must not be counted as an empty cell.
    const extra = extractClaudeExtra(
      {
        tool_name: "NotebookEdit",
        tool_response: { edit_mode: "replace", old_source: null, new_source: "a\nb" },
      },
      [],
      "tool_use_completed",
    );
    expect(extra).not.toHaveProperty("lines_changed");
  });
});

describe("extractCursorExtra", () => {
  it("maps shared fields and renames duration", () => {
    const extra = extractCursorExtra(
      { conversation_id: "c1", model: "auto", duration: 1200 },
      [],
      "tool_use_completed",
    );
    expect(extra).toMatchObject({ conversation_id: "c1", model: "auto", duration_ms: 1200 });
  });

  it("captures model on every event type, not just tool events (per-turn model)", () => {
    // Unlike Claude, Cursor stamps `model` on essentially every hook payload, so
    // model variation within a session is observable per-turn.
    for (const event of ["prompt_submitted", "turn_ended", "session_started", "tool_invoked"]) {
      expect(extractCursorExtra({ model: "claude-sonnet-4" }, [], event).model).toBe(
        "claude-sonnet-4",
      );
    }
  });

  it("infers tool_name from the hook event name", () => {
    expect(
      extractCursorExtra({ hook_event_name: "afterShellExecution" }, [], "tool_invoked").tool_name,
    ).toBe("Shell");
    expect(
      extractCursorExtra({ hook_event_name: "afterFileEdit" }, [], "tool_invoked").tool_name,
    ).toBe("Write");
  });

  it("extracts compaction fields and renames trigger", () => {
    const extra = extractCursorExtra(
      { trigger: "auto", context_usage_percent: 80 },
      [],
      "context_compacted",
    );
    expect(extra).toMatchObject({ trigger_type: "auto", context_usage_percent: 80 });
  });

  it("counts attachments", () => {
    const extra = extractCursorExtra({ attachments: ["a", "b", "c"] }, [], "prompt_submitted");
    expect(extra.attachment_count).toBe(3);
  });

  // A Cursor GUI capture puts model_params on sessionStart, beforeSubmitPrompt and stop,
  // and on no tool event, contradicting the vendor hooks doc. Both ids arrive as strings:
  // `fast` is a stringly-typed boolean.
  it("reads effort and fast_mode off model_params on the events that carry it", () => {
    const modelParams = [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ];
    for (const event of ["session_started", "prompt_submitted", "turn_ended"]) {
      expect(extractCursorExtra({ model_params: modelParams }, [], event)).toMatchObject({
        effort: "high",
        fast_mode: "true",
      });
    }
  });

  it("leaves effort and fast_mode unset when model_params is absent", () => {
    const extra = extractCursorExtra({ model: "cursor-grok-4.6" }, [], "session_started");
    expect(extra).not.toHaveProperty("effort");
    expect(extra).not.toHaveProperty("fast_mode");
  });

  it("leaves effort unset when model_params carries no effort entry", () => {
    const extra = extractCursorExtra(
      { model_params: [{ id: "fast", value: "true" }] },
      [],
      "turn_ended",
    );
    expect(extra).not.toHaveProperty("effort");
    expect(extra.fast_mode).toBe("true");
  });

  it("ignores model_params on a tool event, where no capture has ever shown it", () => {
    // The payload here is synthetic — no Cursor tool event has been observed carrying
    // model_params. The assertion pins our own scoping decision, not vendor behavior:
    // a surface nobody has captured should not start emitting on its own.
    const extra = extractCursorExtra(
      { model_params: [{ id: "effort", value: "high" }] },
      [],
      "tool_use_completed",
    );
    expect(extra).not.toHaveProperty("effort");
  });

  it("counts rule attachments on a prompt without persisting the path", () => {
    const extra = extractCursorExtra(
      { attachments: [{ type: "rule", file_path: "/home/dev/repo/.cursor/rules/probe.mdc" }] },
      [],
      "prompt_submitted",
    );
    expect(extra.rule_attachment_count).toBe(1);
    expect(JSON.stringify(extra)).not.toContain("probe.mdc");
    expect(JSON.stringify(extra)).not.toContain("/home/dev");
  });

  it("emits no rule count when a prompt has no attachments at all", () => {
    const extra = extractCursorExtra({ prompt: "hello" }, [], "prompt_submitted");
    expect(extra).not.toHaveProperty("rule_attachment_count");
  });

  it("emits no rule count rather than a zero when the attachment list is empty", () => {
    const extra = extractCursorExtra({ attachments: [] }, [], "prompt_submitted");
    expect(extra).not.toHaveProperty("rule_attachment_count");
    expect(extra.attachment_count).toBe(0);
  });

  // Every captured attachments list holds exactly one entry and that entry is a rule.
  // The two cases below are defensive expectations taken from the type enum the vendor
  // doc declares, NOT shapes anyone has observed — a file attachment has never been seen.
  it("does not count a file-type attachment as a rule", () => {
    const extra = extractCursorExtra(
      { attachments: [{ type: "file", file_path: "/home/dev/repo/src/index.ts" }] },
      [],
      "prompt_submitted",
    );
    expect(extra).not.toHaveProperty("rule_attachment_count");
    expect(extra.attachment_count).toBe(1);
  });

  it("counts only the rules in a list that also holds a file", () => {
    const extra = extractCursorExtra(
      {
        attachments: [
          { type: "file", file_path: "/home/dev/repo/src/index.ts" },
          { type: "rule", file_path: "/home/dev/repo/.cursor/rules/probe.mdc" },
        ],
      },
      [],
      "prompt_submitted",
    );
    expect(extra.rule_attachment_count).toBe(1);
    expect(extra.attachment_count).toBe(2);
  });

  it("derives tool_intent from the shell command, inferring the tool name", () => {
    const extra = extractCursorExtra(
      { hook_event_name: "afterShellExecution", command: "git push" },
      [],
      "tool_use_completed",
    );
    expect(extra.tool_intent).toBe("vcs");
    expect(JSON.stringify(extra)).not.toContain("git push");
  });

  it("derives tool_intent from a non-shell tool name", () => {
    expect(extractCursorExtra({ tool_name: "Read" }, [], "tool_invoked").tool_intent).toBe("read");
  });

  it("captures mcp_server_name on MCP tool events (bare tool_name, dedicated server field)", () => {
    const extra = extractCursorExtra(
      {
        hook_event_name: "afterMCPExecution",
        tool_name: "list_directory",
        mcp_server_name: "filesystem",
        duration: 3894.865,
      },
      [],
      "tool_use_completed",
    );
    expect(extra).toMatchObject({
      tool_name: "list_directory",
      mcp_server_name: "filesystem",
      duration_ms: 3894.865,
    });
  });

  it("omits mcp_server_name for non-MCP tool events", () => {
    const extra = extractCursorExtra(
      { hook_event_name: "afterShellExecution", command: "ls" },
      [],
      "tool_use_completed",
    );
    expect(extra).not.toHaveProperty("mcp_server_name");
  });

  it("derives tool_intent on failed tool events too", () => {
    const extra = extractCursorExtra(
      { hook_event_name: "afterShellExecution", command: "pytest", failure_type: "timeout" },
      [],
      "tool_use_failed",
    );
    expect(extra.tool_intent).toBe("test_run");
    expect(JSON.stringify(extra)).not.toContain("pytest");
  });

  it("tags the spawned subagent role from subagent_type", () => {
    const extra = extractCursorExtra({ subagent_type: "code-reviewer" }, [], "subagent_spawned");
    expect(extra).toMatchObject({ agent_type: "code-reviewer", role: "review" });
  });

  it("derives command_name from a leading slash command without persisting the prompt", () => {
    const extra = extractCursorExtra(
      { prompt: "/demo-context-prepare some private task details" },
      [],
      "prompt_submitted",
    );
    expect(extra.command_name).toBe("demo-context-prepare");
    expect(JSON.stringify(extra)).not.toContain("private task details");
  });

  it("does not set command_name for a plain prompt", () => {
    const extra = extractCursorExtra({ prompt: "just a normal prompt" }, [], "prompt_submitted");
    expect(extra.command_name).toBeUndefined();
    expect(JSON.stringify(extra)).not.toContain("normal prompt");
  });

  it("captures prompt_length on prompt_submitted without persisting the prompt", () => {
    const prompt = "/demo-context-prepare some private task details";
    const extra = extractCursorExtra({ prompt }, [], "prompt_submitted");
    expect(extra.prompt_length).toBe(prompt.length);
    expect(JSON.stringify(extra)).not.toContain("private task details");
  });
});

describe("extractCodexExtra", () => {
  it("maps model and token fields", () => {
    const extra = extractCodexExtra(
      { model: "gpt", input_tokens: 10, output_tokens: 20 },
      [],
      "tool_use_completed",
    );
    expect(extra).toMatchObject({ model: "gpt", input_tokens: 10, output_tokens: 20 });
  });

  it("captures model on every event type, not just tool events (per-turn model)", () => {
    // Like Cursor, Codex stamps `model` on every hook payload, so per-turn model
    // is observable.
    for (const event of ["prompt_submitted", "turn_ended", "session_started", "tool_invoked"]) {
      expect(extractCodexExtra({ model: "gpt-5-codex" }, [], event).model).toBe("gpt-5-codex");
    }
  });

  it("captures permission request details", () => {
    const extra = extractCodexExtra(
      { tool_name: "shell", permission_type: "exec", approved: false },
      [],
      "permission_requested",
    );
    expect(extra).toMatchObject({ tool_name: "shell", permission_type: "exec", approved: false });
  });

  it("renames the compaction trigger", () => {
    const extra = extractCodexExtra({ trigger: "auto" }, [], "context_compacted");
    expect(extra.trigger_type).toBe("auto");
  });

  it("captures permission_mode on every event that carries it", () => {
    for (const event of [
      "session_started",
      "prompt_submitted",
      "tool_invoked",
      "tool_use_completed",
      "turn_ended",
    ]) {
      expect(
        extractCodexExtra({ permission_mode: "bypassPermissions" }, [], event).permission_mode,
      ).toBe("bypassPermissions");
    }
  });

  it("leaves permission_mode unset on the compaction events, which omit it", () => {
    for (const event of ["context_compacted", "compaction_completed"]) {
      expect(extractCodexExtra({ trigger: "auto" }, [], event)).not.toHaveProperty(
        "permission_mode",
      );
    }
  });

  it("omits permission_mode when absent or malformed rather than defaulting it", () => {
    expect(extractCodexExtra({}, [], "tool_invoked").permission_mode).toBeUndefined();
    expect(extractCodexExtra({ permission_mode: 1 }, [], "tool_invoked").permission_mode).toBe(
      undefined,
    );
  });

  it("passes start_source through unfiltered, including undocumented values", () => {
    // "compact" is undocumented; an allowlist here would drop a real value.
    for (const source of ["startup", "resume", "compact"]) {
      expect(extractCodexExtra({ source }, [], "session_started").start_source).toBe(source);
    }
  });

  it("derives tool_intent from tool_input.command", () => {
    const extra = extractCodexExtra(
      { tool_name: "shell", tool_input: { command: "pytest" } },
      [],
      "tool_use_completed",
    );
    expect(extra.tool_intent).toBe("test_run");
    expect(JSON.stringify(extra)).not.toContain("pytest");
  });

  it("falls back to a top-level command field", () => {
    const extra = extractCodexExtra(
      { tool_name: "shell", command: "go build ./..." },
      [],
      "tool_invoked",
    );
    expect(extra.tool_intent).toBe("build");
  });

  it("derives mcp_server_name from an mcp__<server>__<method> tool_name", () => {
    const invoked = extractCodexExtra(
      { tool_name: "mcp__linear__list_issues" },
      [],
      "tool_invoked",
    );
    expect(invoked.mcp_server_name).toBe("linear");
    const completed = extractCodexExtra(
      { tool_name: "mcp__claude_ai_Google_Calendar__create_event" },
      [],
      "tool_use_completed",
    );
    expect(completed.mcp_server_name).toBe("claude_ai_Google_Calendar");
  });

  it("omits mcp_server_name for non-MCP tool events", () => {
    expect(
      extractCodexExtra({ tool_name: "shell", command: "ls" }, [], "tool_invoked"),
    ).not.toHaveProperty("mcp_server_name");
  });

  it("tags role on spawn but not on completion", () => {
    expect(extractCodexExtra({ agent_type: "code-reviewer" }, [], "subagent_spawned").role).toBe(
      "review",
    );
    expect(
      extractCodexExtra({ agent_type: "code-reviewer" }, [], "subagent_completed").role,
    ).toBeUndefined();
  });

  it("captures prompt_length on prompt_submitted without persisting the prompt", () => {
    const prompt = "Full context dump with the whole spec up front — do not leak this body";
    const extra = extractCodexExtra({ prompt }, [], "prompt_submitted");
    expect(extra.prompt_length).toBe(prompt.length);
    expect(JSON.stringify(extra)).not.toContain("do not leak this body");
  });

  it("omits prompt_length when the prompt is absent or not a string", () => {
    expect(extractCodexExtra({}, [], "prompt_submitted").prompt_length).toBeUndefined();
    expect(extractCodexExtra({ prompt: 42 }, [], "prompt_submitted").prompt_length).toBeUndefined();
  });

  it("derives command_name from a leading slash command without persisting the prompt", () => {
    const extra = extractCodexExtra(
      { prompt: "/demo-context-prepare some private task details" },
      [],
      "prompt_submitted",
    );
    expect(extra.command_name).toBe("demo-context-prepare");
    expect(JSON.stringify(extra)).not.toContain("private task details");
  });

  it("does not set command_name for a plain prompt", () => {
    const extra = extractCodexExtra({ prompt: "just a normal prompt" }, [], "prompt_submitted");
    expect(extra.command_name).toBeUndefined();
    expect(JSON.stringify(extra)).not.toContain("normal prompt");
  });
});

describe("handleHookEvent — validation guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores an event name pheebs does not know", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleHookEvent("claude_code", "not_a_real_event", []);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("unknown hook event"));
  });

  it("ignores an event not registered for the given tool", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // permission_requested is a valid pheebs event, but only registered for Codex.
    await handleHookEvent("claude_code", "permission_requested", []);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("not registered"));
  });
});
