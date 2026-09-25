import { EVENTS, type HookDefinition } from "./types.js";

export const CODEX_DEFINITIONS: readonly HookDefinition[] = [
  { tool: "codex", hookKey: "SessionStart", eventName: EVENTS.SessionStarted },
  { tool: "codex", hookKey: "UserPromptSubmit", eventName: EVENTS.PromptSubmitted },
  { tool: "codex", hookKey: "SubagentStart", eventName: EVENTS.SubagentSpawned },
  { tool: "codex", hookKey: "SubagentStop", eventName: EVENTS.SubagentCompleted },
  { tool: "codex", hookKey: "PreToolUse", eventName: EVENTS.ToolInvoked, matcher: ".*" },
  { tool: "codex", hookKey: "PostToolUse", eventName: EVENTS.ToolUseCompleted, matcher: ".*" },
  { tool: "codex", hookKey: "PermissionRequest", eventName: EVENTS.PermissionRequested },
  { tool: "codex", hookKey: "PreCompact", eventName: EVENTS.ContextCompacted },
  { tool: "codex", hookKey: "PostCompact", eventName: EVENTS.CompactionCompleted },
  { tool: "codex", hookKey: "Stop", eventName: EVENTS.TurnEnded },
];

/** Codex drops a project-local config layer unless the project is trusted, and skips any handler
 *  without a matching trusted_hash. Both are the developer's own security call, granted in Codex's
 *  own TUI, so pheebs writes a project-scoped install that stays inert until they make it. */
export const CODEX_TRUST_WARNING =
  "Codex only runs project-local hooks once you trust this project in its TUI, so these hooks stay inert until you do.";
