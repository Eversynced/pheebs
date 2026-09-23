import { EVENTS, type HookDefinition } from "./types.js";

export const CURSOR_DEFINITIONS: readonly HookDefinition[] = [
  { tool: "cursor", hookKey: "sessionStart", eventName: EVENTS.SessionStarted },
  { tool: "cursor", hookKey: "beforeSubmitPrompt", eventName: EVENTS.PromptSubmitted },
  { tool: "cursor", hookKey: "subagentStart", eventName: EVENTS.SubagentSpawned },
  { tool: "cursor", hookKey: "subagentStop", eventName: EVENTS.SubagentCompleted },
  { tool: "cursor", hookKey: "beforeShellExecution", eventName: EVENTS.ToolInvoked },
  { tool: "cursor", hookKey: "afterShellExecution", eventName: EVENTS.ToolUseCompleted },
  { tool: "cursor", hookKey: "beforeMCPExecution", eventName: EVENTS.ToolInvoked },
  { tool: "cursor", hookKey: "afterMCPExecution", eventName: EVENTS.ToolUseCompleted },
  { tool: "cursor", hookKey: "afterFileEdit", eventName: EVENTS.ToolUseCompleted },
  { tool: "cursor", hookKey: "postToolUseFailure", eventName: EVENTS.ToolUseFailed },
  { tool: "cursor", hookKey: "preCompact", eventName: EVENTS.ContextCompacted },
  { tool: "cursor", hookKey: "stop", eventName: EVENTS.TurnEnded },
  { tool: "cursor", hookKey: "sessionEnd", eventName: EVENTS.SessionEnd },
];
