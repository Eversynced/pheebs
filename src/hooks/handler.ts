import { maybeAutoUpdate } from "../auto-update.js";
import { baseUrl, ensureConfig, hasBackend } from "../backend-config.js";
import { stripBom } from "../bom.js";
import { classifyPrompt } from "../classify.js";
import { getConfig } from "../config.js";
import { getDeveloperHandle } from "../developer-id.js";
import { appendLogEntry } from "../logger.js";
import { resyncOtelConfigs } from "../otel-resync.js";
import { endpointKey } from "../outbox.js";
import { runArtifactScan } from "../scanner.js";
import { readStoredToken, revalidateStoredTokenIfStale } from "../token.js";
import { noteSession } from "../usage-sessions.js";
import { PHEEBS_VERSION } from "../version.js";
import {
  AI_TOOLS,
  type AiTool,
  EVENTS,
  getHookDefinitionsForTool,
  type PheebsEvent,
} from "./definitions.js";
import {
  classifyCommandSequence,
  classifyIntent,
  classifyVcsAction,
  isShellTool,
} from "./intent.js";
import { classifyRole } from "./role.js";
import { RECURSION_GUARD_ENV } from "./types.js";

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

function applyShellFacts(
  extra: Record<string, unknown>,
  toolName: string | undefined,
  command: string | undefined,
): void {
  if (!command || !isShellTool(toolName)) return;
  const action = classifyVcsAction(command);
  if (extra.tool_intent === "vcs" || action !== "other") extra.vcs_action = action;
  const sequence = classifyCommandSequence(command);
  if (sequence) extra.command_sequence = sequence;
}

// Model ids and agent types are short tokens. A value outside this shape, such as a
// Bedrock inference-profile ARN carrying an account id or a path, is dropped rather than logged.
const ID_TOKEN = /^[A-Za-z0-9._:@[\]-]{1,100}$/;

function readIdToken(value: unknown): string | undefined {
  return typeof value === "string" && ID_TOKEN.test(value) ? value : undefined;
}

// The Agent tool's result names the model the subagent ran on. Only that token
// is read, so the subagent's prompt and output in the same response stay out.
function readResolvedModel(toolResponse: unknown): string | undefined {
  if (typeof toolResponse !== "object" || toolResponse === null) return undefined;
  return readIdToken((toolResponse as Record<string, unknown>).resolvedModel);
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

// Claude Code surfaces an MCP call as a single `tool_name` shaped `mcp__<server>__<method>`.
// Deriving `<server>` here reports it on its own field. Server names may contain single
// underscores, so `__` is the delimiter.
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
    applyShellFacts(extra, toolName, command);
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
      // SubagentStart carries no model, but the Agent call's result names the one
      // the subagent resolved to. The type and the call's own model ride beside it
      // as facts only: Claude fills in `model` itself, so neither shows who picked.
      if (toolName === "Agent") {
        const resolved = readResolvedModel(payload.tool_response);
        if (resolved) extra.subagent_model = resolved;
        const input = payload.tool_input as Record<string, unknown> | null | undefined;
        if (typeof input === "object" && input !== null) {
          const agentType = readIdToken(input.subagent_type);
          if (agentType) extra.agent_type = agentType;
          const requested = readIdToken(input.model);
          if (requested) extra.requested_model = requested;
        }
      }
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

// Cursor also runs the hooks in a project's `.claude/settings.json`, whatever the developer has
// installed for it. Claude Code names its hook events in PascalCase and never sends
// `cursor_version`.
function isCursorPayload(payload: Record<string, unknown>): boolean {
  // Valid JSON that is not an object (`42`, `null`) is no Cursor payload; the `in` check would throw.
  if (typeof payload !== "object" || payload === null) return false;
  if ("cursor_version" in payload) return true;
  const hookName = payload.hook_event_name;
  return typeof hookName === "string" && /^[a-z]/.test(hookName);
}

const TRANSCRIPT_EVENTS = new Set<string>([
  EVENTS.SessionStarted,
  EVENTS.TurnEnded,
  EVENTS.SessionEnd,
]);

// Records that a session has a transcript worth reading once it ends. Nothing is opened or looked
// up here, and no path is kept: the flusher finds the transcript by session id later. Skipped without a backend and token, or in
// debug mode, because only the flusher reads these and it only runs when it can send.
function noteTranscript(
  tool: AiTool,
  eventName: string,
  sessionId: string | undefined,
  codebase: string,
): void {
  if (tool !== AI_TOOLS.CLAUDE_CODE || !TRANSCRIPT_EVENTS.has(eventName)) return;
  if (!sessionId) return;
  try {
    const stored = readStoredToken();
    if (process.env.PHEEBS_DEBUG || !hasBackend() || !stored) return;
    noteSession({
      tool,
      session_id: sessionId,
      codebase,
      endpoint: endpointKey(baseUrl()),
      ended: eventName === EVENTS.TurnEnded ? undefined : eventName === EVENTS.SessionEnd,
    });
  } catch {}
}

export async function handleHookEvent(
  tool: AiTool,
  eventName: string,
  cliArgs: string[],
): Promise<void> {
  if (!isPheebsEvent(eventName)) {
    console.error(`pheebs: unknown hook event "${eventName}" for tool "${tool}", ignoring`);
    return;
  }

  // Inside a local classifier's own `claude -p`, an event would log the classification call as
  // developer activity.
  if (process.env[RECURSION_GUARD_ENV]) return;

  const acceptedEvents = getHookDefinitionsForTool(tool).map((d) => d.eventName);
  if (!acceptedEvents.includes(eventName)) {
    console.error(`pheebs: event "${eventName}" is not registered for tool "${tool}", ignoring`);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = stripBom(Buffer.concat(chunks).toString("utf-8"));

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error("pheebs: failed to parse hook stdin JSON, ignoring");
    return;
  }

  // Cursor runs these hooks too, and it is no longer a tool pheebs records: taking its events here
  // would log each one as `claude_code`.
  if (tool === AI_TOOLS.CLAUDE_CODE && isCursorPayload(payload)) return;

  if (process.env.PHEEBS_DEBUG) {
    console.error(`pheebs debug [${tool}/${eventName}]: ${JSON.stringify(payload, null, 2)}`);
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const extra = extractClaudeExtra(payload, cliArgs, eventName);

  const submittedAt = new Date().toISOString();

  // On a prompt, enrich the event with a classified intent. classifyPrompt sends prompt text only
  // where its mode's gate allows; it degrades rather than throws, and is bounded by the remote
  // timeout, or the longer local one under `classify local`.
  if (eventName === EVENTS.PromptSubmitted && typeof payload.prompt === "string") {
    const classified = await classifyPrompt(payload.prompt, tool);
    if (classified) Object.assign(extra, classified);
  }

  const developerHandle = getDeveloperHandle(sessionId);
  const config = getConfig();

  // Before the event is queued, so the flusher it starts finds the session already recorded.
  noteTranscript(tool, eventName, sessionId, config.codebaseId);

  appendLogEntry(
    {
      source: "hook",
      event: eventName,
      developer: developerHandle,
      codebase: config.codebaseId,
      ai_tool: tool,
      session_id: sessionId ?? "unknown",
      timestamp: submittedAt,
      version: PHEEBS_VERSION,
      ...extra,
    },
    config,
  );

  if (eventName === EVENTS.SessionStarted) {
    ensureConfig();
    runArtifactScan(tool, sessionId, developerHandle);
    maybeAutoUpdate();
    // After the write, so a slow backend never holds back the durable copy. The token file is
    // machine-wide, so what this resolves also reaches sessions already running.
    try {
      if (await revalidateStoredTokenIfStale()) resyncOtelConfigs();
    } catch {}
  }
}
