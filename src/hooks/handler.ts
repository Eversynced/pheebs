import { maybeAutoUpdate } from "../auto-update.js";
import { ensureConfig } from "../backend-config.js";
import { classifyPrompt } from "../classify.js";
import { getConfig } from "../config.js";
import { getDeveloperHandle } from "../developer-id.js";
import { appendLogEntry } from "../logger.js";
import { runArtifactScan } from "../scanner.js";
import { PHEEBS_VERSION } from "../version.js";
import {
  AI_TOOLS,
  type AiTool,
  EVENTS,
  getHookDefinitionsForTool,
  type PheebsEvent,
} from "./definitions.js";
import { classifyIntent, classifyVcsAction } from "./intent.js";
import { classifyCodexOutcome } from "./outcome.js";
import { classifyRole } from "./role.js";

const VALID_EVENTS = new Set<string>(Object.values(EVENTS));

function isPheebsEvent(value: string): value is PheebsEvent {
  return VALID_EVENTS.has(value);
}

// Used only to derive the tool_intent tag locally — the returned string is read
// in-process and never leaves the hook.
function readCommand(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "command" in value) {
    const command = (value as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}

// Claude Code's Skill tool carries the skill name as `tool_input.skill`. Only
// that token is captured, keeping the rest of the input out of telemetry.
function readSkillName(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "skill" in value) {
    const skill = (value as Record<string, unknown>).skill;
    if (typeof skill === "string" && skill.length > 0) {
      return skill;
    }
  }
  return undefined;
}

// Bash sets tool_input.run_in_background on a backgrounded call. Only the boolean
// is read; the command is never persisted. Foreground calls omit the key, so only
// a true is reported.
function readRunInBackground(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).run_in_background === true
  );
}

// Cursor's beforeSubmitPrompt payload has no structured command field — a slash
// command arrives as raw prompt text. Only the leading token is extracted
// ("deploy" from "/deploy …"); the prompt itself is never persisted.
function readSlashCommandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  const token = trimmed.slice(1).split(/\s/)[0];
  return token.length > 0 ? token : undefined;
}

// Cursor carries a dedicated `mcp_server_name`, but Claude Code and Codex surface
// an MCP call as a single `tool_name` shaped `mcp__<server>__<method>`. Deriving
// `<server>` here lets all three report MCP servers on one shared field. Server
// names may contain single underscores, so `__` is the delimiter.
function deriveMcpServerName(toolName: string | undefined): string | undefined {
  const prefix = "mcp__";
  if (!toolName?.startsWith(prefix)) return undefined;
  const rest = toolName.slice(prefix.length);
  const sep = rest.indexOf("__");
  const server = sep === -1 ? rest : rest.slice(0, sep);
  return server.length > 0 ? server : undefined;
}

// Prompt size is a coarse proxy for front-loaded context (specs or mocks pasted
// up front). Only the scalar length is persisted; the text is read in-process
// and discarded.
function readPromptLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

// A trailing newline does not open a new line, so a 3-line file counts 3.
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

// Hunk lines are unified-diff format, prefixed "+", "-", or a space. Summing over
// hunks catches every occurrence, so `replace_all` needs no special case.
function countPatchLines(patch: unknown): number | undefined {
  if (!Array.isArray(patch)) return undefined;
  let changed = 0;
  for (const hunk of patch) {
    if (typeof hunk !== "object" || hunk === null) continue;
    const lines = (hunk as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line === "string" && (line.startsWith("+") || line.startsWith("-"))) changed += 1;
    }
  }
  return changed;
}

// Change size (added + removed) for one edit. The patch, content and file path it
// reads are discarded — only the integer is persisted. Returns `undefined` rather
// than 0 on an unrecognized shape, since 0 is a real measurement. MultiEdit has no
// branch: it is unexposed in Claude Code 2.1.246, so its payload shape is unverified.
function readLinesChanged(toolName: string | undefined, toolResponse: unknown): number | undefined {
  if (typeof toolResponse !== "object" || toolResponse === null) return undefined;
  const response = toolResponse as Record<string, unknown>;

  if (toolName === "Edit") return countPatchLines(response.structuredPatch);

  if (toolName === "Write") {
    // An overwrite carries a real patch; only a create is charged at full size.
    if (response.type === "create") {
      return typeof response.content === "string" ? countLines(response.content) : undefined;
    }
    return response.type === "update" ? countPatchLines(response.structuredPatch) : undefined;
  }

  if (toolName === "NotebookEdit") {
    // Notebooks carry no patch, so a replace is charged as a whole-cell rewrite. An
    // absent source is real (`insert` carries no old_source), but one that is present
    // and not a string is a shape we do not know, not an empty cell.
    const hasNew = "new_source" in response;
    const hasOld = "old_source" in response;
    if (!hasNew && !hasOld) return undefined;
    const newSource = hasNew ? response.new_source : "";
    const oldSource = hasOld ? response.old_source : "";
    if (typeof newSource !== "string" || typeof oldSource !== "string") return undefined;
    return countLines(newSource) + countLines(oldSource);
  }

  return undefined;
}

type Extractor = (
  payload: Record<string, unknown>,
  cliArgs: string[],
  eventName: string,
) => Record<string, unknown>;

export function extractClaudeExtra(
  payload: Record<string, unknown>,
  cliArgs: string[],
  eventName: string,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  // permission_mode (default | plan | acceptEdits | bypassPermissions) and the
  // reasoning effort level ride along on every Claude Code hook payload, so we
  // capture them per-event. This lets analysis correlate the active mode/effort
  // with the model. NOTE: `model` is only emitted on session_started, so model×mode
  // joins are session-grained, never per-event: join to the start snapshot by
  // session_id, then advance it over that session's model_switched events.
  if (typeof payload.permission_mode === "string") {
    extra.permission_mode = payload.permission_mode;
  }
  if (typeof payload.effort === "object" && payload.effort !== null) {
    const level = (payload.effort as Record<string, unknown>).level;
    if (typeof level === "string") extra.effort = level;
  }

  if (eventName === "session_started") {
    if (typeof payload.source === "string") extra.start_source = payload.source;
    if (typeof payload.model === "string") extra.model = payload.model;
  }

  // Stays unset when the payload carries no prompt text — the event still emits.
  if (eventName === "prompt_submitted") {
    const promptLength = readPromptLength(payload.prompt);
    if (promptLength !== undefined) extra.prompt_length = promptLength;
  }

  if (eventName === "command_expanded") {
    if (typeof payload.command_name === "string") extra.command_name = payload.command_name;
    if (typeof payload.expansion_type === "string") extra.expansion_type = payload.expansion_type;
    if (typeof payload.command_source === "string") extra.command_source = payload.command_source;
  }

  // A context file was loaded into the agent (AR1: loaded, not merely present).
  // Only the coarse reason and scope are kept; the payload's file_path is never
  // persisted.
  if (eventName === "instructions_loaded") {
    if (typeof payload.load_reason === "string") extra.load_reason = payload.load_reason;
    if (typeof payload.memory_type === "string") extra.memory_type = payload.memory_type;
  }

  // The schema also declares `auto` and `resume` sources, for switches Claude Code
  // makes for itself, so `switch_source` is carried raw and the consumer decides
  // what counts as deliberate. Neither was observed: on 2.1.267 a `--continue`
  // resume fired no hook at all.
  if (eventName === "model_switched") {
    if (typeof payload.from_model === "string") extra.from_model = payload.from_model;
    if (typeof payload.to_model === "string") extra.to_model = payload.to_model;
    if (typeof payload.source === "string") extra.switch_source = payload.source;
  }

  if (eventName === "subagent_spawned") {
    if (typeof payload.agent_type === "string") {
      extra.agent_type = payload.agent_type;
      extra.role = classifyRole(payload.agent_type);
    }
    if (typeof payload.agent_id === "string") extra.agent_id = payload.agent_id;
  }

  if (eventName === "subagent_completed") {
    if (typeof payload.agent_type === "string") extra.agent_type = payload.agent_type;
    if (typeof payload.agent_id === "string") extra.agent_id = payload.agent_id;
    if (typeof payload.stop_hook_active === "boolean")
      extra.stop_hook_active = payload.stop_hook_active;
  }

  if (eventName === "turn_ended") {
    if (typeof payload.stop_hook_active === "boolean")
      extra.stop_hook_active = payload.stop_hook_active;
    if (Array.isArray(payload.background_tasks))
      extra.background_task_count = payload.background_tasks.length;
    if (Array.isArray(payload.session_crons))
      extra.session_cron_count = payload.session_crons.length;
  }

  if (eventName === "task_created") {
    if (typeof payload.task_id === "string") extra.task_id = payload.task_id;
    if (typeof payload.task_subject === "string") extra.task_subject = payload.task_subject;
    if (typeof payload.teammate_name === "string") extra.teammate_name = payload.teammate_name;
  }

  if (eventName === "tool_use_completed" || eventName === "tool_use_failed") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    if (toolName) extra.tool_name = toolName;
    if (typeof payload.duration_ms === "number") extra.duration_ms = payload.duration_ms;
    const command = readCommand(payload.tool_input);
    extra.tool_intent = classifyIntent(toolName, command);
    // Refine vcs into commit/push/pr_create so a test-gate metric anchors on
    // write actions, not read-only git. Command read in-process, never persisted.
    if (extra.tool_intent === "vcs" && command) extra.vcs_action = classifyVcsAction(command);
    // Normalize MCP server identity onto the same field Cursor uses.
    const mcpServer = deriveMcpServerName(toolName);
    if (mcpServer) extra.mcp_server_name = mcpServer;
    // Per-call parallel-execution signal (OR2). Captured on both completed and
    // failed events, since a backgrounded call that fails was still backgrounded.
    if (readRunInBackground(payload.tool_input)) extra.run_in_background = true;
    // The Skill tool invokes a named skill (including model-driven auto-invoke)
    // without firing command_expanded, so the name would otherwise be lost. Persist
    // just the skill token under command_name — the same field slash-invoked commands
    // use — so skill usage is attributable by any invocation path.
    if (toolName === "Skill") {
      const skillName = readSkillName(payload.tool_input);
      if (skillName) {
        extra.command_name = skillName;
      }
    }
    // A failed edit changed no lines, so it leaves the field unset rather than 0.
    if (eventName === "tool_use_completed") {
      const linesChanged = readLinesChanged(toolName, payload.tool_response);
      if (linesChanged !== undefined) extra.lines_changed = linesChanged;
    }
  }

  if (eventName === "tool_use_failed") {
    if (typeof payload.is_interrupt === "boolean") extra.is_interrupt = payload.is_interrupt;
  }

  if (eventName === "session_end" && typeof payload.reason === "string") {
    extra.reason = payload.reason;
  }

  if (eventName === "task_completed") {
    if (typeof payload.task_id === "string") extra.task_id = payload.task_id;
    if (typeof payload.task_subject === "string") extra.task_subject = payload.task_subject;
    if (typeof payload.teammate_name === "string") extra.teammate_name = payload.teammate_name;
  }

  const triggerIdx = cliArgs.indexOf("--trigger-type");
  if (triggerIdx !== -1 && cliArgs[triggerIdx + 1]) {
    extra.trigger_type = cliArgs[triggerIdx + 1];
  }

  return extra;
}

type FieldSpec = [source: string, type: string, target?: string];

const CURSOR_FIELDS: FieldSpec[] = [
  ["conversation_id", "string"],
  ["generation_id", "string"],
  ["model", "string"],
  ["composer_mode", "string"],
  ["cursor_version", "string"],
  ["sandbox", "boolean"],
  ["status", "string"],
  ["loop_count", "number"],
  ["duration", "number", "duration_ms"],
  ["input_tokens", "number"],
  ["output_tokens", "number"],
  ["cache_read_tokens", "number"],
  ["cache_write_tokens", "number"],
];

function pickFields(payload: Record<string, unknown>, specs: FieldSpec[]): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [source, type, target] of specs) {
    if (typeof payload[source] === type) {
      extra[target ?? source] = payload[source];
    }
  }
  return extra;
}

// Cursor tool events carry an explicit `tool_name` for some hooks; for shell
// and file-edit hooks the tool is inferred from the hook event name instead.
function inferCursorToolName(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.tool_name === "string") return payload.tool_name;
  const hookName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (hookName.includes("Shell")) return "Shell";
  if (hookName.includes("FileEdit")) return "Write";
  return undefined;
}

// Cursor ships the turn's model configuration as a list of `{id, value}` entries
// rather than as discrete keys, so every id has to be looked up. Both ids observed
// arrive as strings — `fast` is a stringly-typed boolean (`"true"`), so reading it
// as a JSON boolean would silently capture nothing.
function readModelParam(modelParams: unknown, id: string): string | undefined {
  if (!Array.isArray(modelParams)) return undefined;
  for (const entry of modelParams) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.id === id && typeof record.value === "string") return record.value;
  }
  return undefined;
}

// `type` is a first-class field on every attachment entry, so rule-ness is never
// inferred from a path shape — the `file_path` beside it is a real path and is
// never read.
function countRuleAttachments(attachments: unknown): number {
  if (!Array.isArray(attachments)) return 0;
  let rules = 0;
  for (const entry of attachments) {
    if (typeof entry === "object" && entry !== null) {
      if ((entry as Record<string, unknown>).type === "rule") rules += 1;
    }
  }
  return rules;
}

const CURSOR_COMPACT_FIELDS: FieldSpec[] = [
  ["trigger", "string", "trigger_type"],
  ["context_usage_percent", "number"],
  ["context_tokens", "number"],
  ["context_window_size", "number"],
  ["message_count", "number"],
  ["messages_to_compact", "number"],
  ["is_first_compaction", "boolean"],
];

export function extractCursorExtra(
  payload: Record<string, unknown>,
  _cliArgs: string[],
  eventName: string,
): Record<string, unknown> {
  const extra = pickFields(payload, CURSOR_FIELDS);

  // Only these three carry `model_params`; the tool events the vendor doc names for
  // it carry none. Reading it only where a GUI capture has actually shown it keeps a
  // new surface from emitting before anyone has looked at its shape. `effort` lands
  // on the field Claude Code already fills so a consumer needs no per-harness branch;
  // `fast` is undocumented but is the vendor's own raw model setting, passed through
  // verbatim rather than coerced, since "true" is the only value we have ever seen.
  if (
    eventName === "session_started" ||
    eventName === "prompt_submitted" ||
    eventName === "turn_ended"
  ) {
    const effort = readModelParam(payload.model_params, "effort");
    if (effort) extra.effort = effort;
    const fastMode = readModelParam(payload.model_params, "fast");
    if (fastMode) extra.fast_mode = fastMode;
  }

  if (eventName === "session_started") {
    if (typeof payload.is_background_agent === "boolean")
      extra.is_background_agent = payload.is_background_agent;
  }

  // Cursor has no command-expansion hook, so a slash command lands here as prompt
  // text. Reporting it under command_name makes skill usage attributable across
  // tools, on the same field Claude Code's command_expanded fills.
  if (eventName === "prompt_submitted") {
    const commandName = readSlashCommandName(payload.prompt);
    if (commandName) extra.command_name = commandName;
    const promptLength = readPromptLength(payload.prompt);
    if (promptLength !== undefined) extra.prompt_length = promptLength;
    // A rule-less list reports nothing rather than 0: `attachments` is populated only
    // on Cursor's GUI surface, and it stayed empty on `beforeReadFile` with a rule
    // demonstrably loaded, so an empty list cannot be told apart from a surface that
    // does not report. This field is a presence signal, not a measured zero.
    const ruleCount = countRuleAttachments(payload.attachments);
    if (ruleCount) extra.rule_attachment_count = ruleCount;
  }

  if (eventName === "subagent_spawned") {
    if (typeof payload.subagent_id === "string") extra.agent_id = payload.subagent_id;
    if (typeof payload.subagent_type === "string") {
      extra.agent_type = payload.subagent_type;
      extra.role = classifyRole(payload.subagent_type);
    }
    if (typeof payload.subagent_model === "string") extra.subagent_model = payload.subagent_model;
    if (typeof payload.is_parallel_worker === "boolean")
      extra.is_parallel_worker = payload.is_parallel_worker;
  }

  if (eventName === "subagent_completed") {
    if (typeof payload.subagent_type === "string") extra.agent_type = payload.subagent_type;
    if (typeof payload.status === "string") extra.status = payload.status;
    if (typeof payload.duration_ms === "number") extra.subagent_duration_ms = payload.duration_ms;
    if (typeof payload.message_count === "number") extra.message_count = payload.message_count;
    if (typeof payload.tool_call_count === "number")
      extra.tool_call_count = payload.tool_call_count;
    if (typeof payload.loop_count === "number") extra.loop_count = payload.loop_count;
  }

  if (
    eventName === "tool_invoked" ||
    eventName === "tool_use_completed" ||
    eventName === "tool_use_failed"
  ) {
    const toolName = inferCursorToolName(payload);
    if (toolName) extra.tool_name = toolName;
    if (typeof payload.duration === "number") extra.duration_ms = payload.duration;
    if (typeof payload.mcp_server_name === "string") {
      extra.mcp_server_name = payload.mcp_server_name;
    }
    const command = typeof payload.command === "string" ? payload.command : undefined;
    extra.tool_intent = classifyIntent(toolName, command);
    if (extra.tool_intent === "vcs" && command) extra.vcs_action = classifyVcsAction(command);
  }

  if (eventName === "tool_use_failed") {
    if (typeof payload.failure_type === "string") extra.failure_type = payload.failure_type;
    if (typeof payload.is_interrupt === "boolean") extra.is_interrupt = payload.is_interrupt;
  }

  if (eventName === "context_compacted") {
    Object.assign(extra, pickFields(payload, CURSOR_COMPACT_FIELDS));
  }

  if (eventName === "turn_ended") {
    if (typeof payload.status === "string") extra.status = payload.status;
    if (typeof payload.loop_count === "number") extra.loop_count = payload.loop_count;
  }

  if (eventName === "session_end") {
    if (typeof payload.reason === "string") extra.reason = payload.reason;
    if (typeof payload.duration_ms === "number") extra.session_duration_ms = payload.duration_ms;
    if (typeof payload.is_background_agent === "boolean")
      extra.is_background_agent = payload.is_background_agent;
  }

  if (Array.isArray(payload.attachments)) {
    extra.attachment_count = payload.attachments.length;
  }

  return extra;
}

const CODEX_FIELDS: FieldSpec[] = [
  ["model", "string"],
  ["input_tokens", "number"],
  ["output_tokens", "number"],
  ["duration_ms", "number"],
];

const CODEX_TOOL_FIELDS: FieldSpec[] = [["tool_name", "string"]];

const CODEX_PERMISSION_FIELDS: FieldSpec[] = [
  ["permission_type", "string"],
  ["approved", "boolean"],
];

export function extractCodexExtra(
  payload: Record<string, unknown>,
  _cliArgs: string[],
  eventName: string,
): Record<string, unknown> {
  const extra = pickFields(payload, CODEX_FIELDS);

  // Same field name Claude Code emits, so consumers need no per-harness branch.
  // Presence check, not an event allowlist, so a new carrier event is captured
  // free; docs/spike-findings-ledger.md owns that list. Constant per harness
  // today, so it is a raw fact rather than a mode signal.
  if (typeof payload.permission_mode === "string") {
    extra.permission_mode = payload.permission_mode;
  }

  if (eventName === "session_started" && typeof payload.source === "string") {
    extra.start_source = payload.source;
  }

  // Codex has no command-expansion hook either, so the command name comes from
  // the raw prompt text on UserPromptSubmit, as it does for Cursor.
  if (eventName === "prompt_submitted") {
    const commandName = readSlashCommandName(payload.prompt);
    if (commandName) extra.command_name = commandName;
    const promptLength = readPromptLength(payload.prompt);
    if (promptLength !== undefined) extra.prompt_length = promptLength;
  }

  if (eventName === "subagent_spawned" || eventName === "subagent_completed") {
    if (typeof payload.agent_id === "string") extra.agent_id = payload.agent_id;
    if (typeof payload.agent_type === "string") {
      extra.agent_type = payload.agent_type;
      if (eventName === "subagent_spawned") extra.role = classifyRole(payload.agent_type);
    }
  }

  if (eventName === "subagent_completed" && typeof payload.stop_hook_active === "boolean") {
    extra.stop_hook_active = payload.stop_hook_active;
  }

  if (eventName === "tool_invoked" || eventName === "tool_use_completed") {
    Object.assign(extra, pickFields(payload, CODEX_TOOL_FIELDS));
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const command =
      readCommand(payload.tool_input) ??
      (typeof payload.command === "string" ? payload.command : undefined);
    extra.tool_intent = classifyIntent(toolName, command);
    if (extra.tool_intent === "vcs" && command) extra.vcs_action = classifyVcsAction(command);
    // Normalize MCP server identity onto the same field Cursor uses.
    const mcpServer = deriveMcpServerName(toolName);
    if (mcpServer) extra.mcp_server_name = mcpServer;
  }

  if (eventName === "permission_requested") {
    if (typeof payload.tool_name === "string") extra.tool_name = payload.tool_name;
    Object.assign(extra, pickFields(payload, CODEX_PERMISSION_FIELDS));
  }

  if (eventName === "turn_ended") {
    if (typeof payload.stop_hook_active === "boolean")
      extra.stop_hook_active = payload.stop_hook_active;
  }

  if (eventName === "context_compacted" || eventName === "compaction_completed") {
    if (typeof payload.trigger === "string") extra.trigger_type = payload.trigger;
  }

  return extra;
}

const EXTRACTORS: Record<AiTool, Extractor> = {
  [AI_TOOLS.CLAUDE_CODE]: extractClaudeExtra,
  [AI_TOOLS.CURSOR]: extractCursorExtra,
  [AI_TOOLS.CODEX]: extractCodexExtra,
};

export async function handleHookEvent(
  tool: AiTool,
  eventName: string,
  cliArgs: string[],
): Promise<void> {
  if (!isPheebsEvent(eventName)) {
    console.error(`pheebs: unknown hook event "${eventName}" for tool "${tool}", ignoring`);
    return;
  }

  const acceptedEvents = getHookDefinitionsForTool(tool).map((d) => d.eventName);
  if (!acceptedEvents.includes(eventName)) {
    console.error(`pheebs: event "${eventName}" is not registered for tool "${tool}", ignoring`);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error("pheebs: failed to parse hook stdin JSON, ignoring");
    return;
  }

  if (process.env.PHEEBS_DEBUG) {
    console.error(`pheebs debug [${tool}/${eventName}]: ${JSON.stringify(payload, null, 2)}`);
  }

  const sessionId =
    typeof payload.session_id === "string"
      ? payload.session_id
      : typeof payload.conversation_id === "string"
        ? payload.conversation_id
        : undefined;
  const extra = EXTRACTORS[tool](payload, cliArgs, eventName);

  // Codex has no failure hook: derive pass/fail from the raw tool_response and
  // synthesize the tool_use_failed event Claude and Cursor emit natively.
  let event = eventName;
  if (tool === AI_TOOLS.CODEX && eventName === EVENTS.ToolUseCompleted) {
    if (classifyCodexOutcome(payload.tool_response) === "failed") {
      event = EVENTS.ToolUseFailed;
    }
  }

  // On a prompt, enrich the event with a classified intent. classifyPrompt gates on local
  // consent and sends no prompt text otherwise; it degrades to undefined and never blocks long.
  if (event === EVENTS.PromptSubmitted && typeof payload.prompt === "string") {
    const classified = await classifyPrompt(payload.prompt);
    if (classified) Object.assign(extra, classified);
  }

  const developerHandle = getDeveloperHandle();
  const config = getConfig();

  appendLogEntry(
    {
      source: "hook",
      event,
      developer: developerHandle,
      codebase: config.codebaseId,
      ai_tool: tool,
      session_id: sessionId ?? "unknown",
      timestamp: new Date().toISOString(),
      version: PHEEBS_VERSION,
      ...extra,
    },
    config,
  );

  // Only Claude Code's hook entries are registered `async: true`. Cursor runs hooks
  // synchronously under a 10s timeout and Codex sets no async flag, so on those two the
  // session start waits on this scan — it has to stay bounded.
  if (eventName === EVENTS.SessionStarted) {
    ensureConfig();
    runArtifactScan(tool, sessionId);
    maybeAutoUpdate();
  }
}
