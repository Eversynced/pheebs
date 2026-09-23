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
