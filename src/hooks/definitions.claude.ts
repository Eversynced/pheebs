import { EVENTS, type HookDefinition } from "./types.js";

export const CLAUDE_DEFINITIONS: readonly HookDefinition[] = [
  { tool: "claude_code", hookKey: "SessionStart", eventName: EVENTS.SessionStarted },
  { tool: "claude_code", hookKey: "InstructionsLoaded", eventName: EVENTS.InstructionsLoaded },
  // Pre is not registered: it fires on the request, ahead of a confirmation gate
  // that can cancel it, so both would double-count a switch that never took.
  { tool: "claude_code", hookKey: "PostModelSwitch", eventName: EVENTS.ModelSwitched },
  { tool: "claude_code", hookKey: "UserPromptSubmit", eventName: EVENTS.PromptSubmitted },
  { tool: "claude_code", hookKey: "UserPromptExpansion", eventName: EVENTS.CommandExpanded },
  { tool: "claude_code", hookKey: "SubagentStart", eventName: EVENTS.SubagentSpawned },
  { tool: "claude_code", hookKey: "SubagentStop", eventName: EVENTS.SubagentCompleted },
  { tool: "claude_code", hookKey: "PostToolUse", eventName: EVENTS.ToolUseCompleted },
  { tool: "claude_code", hookKey: "PostToolUseFailure", eventName: EVENTS.ToolUseFailed },
  {
    tool: "claude_code",
    hookKey: "PreCompact",
    eventName: EVENTS.ContextCompacted,
    matcher: "auto",
    cliArgs: "--trigger-type auto",
  },
  {
    tool: "claude_code",
    hookKey: "PreCompact",
    eventName: EVENTS.ContextCompacted,
    matcher: "manual",
    cliArgs: "--trigger-type manual",
  },
  { tool: "claude_code", hookKey: "TaskCreated", eventName: EVENTS.TaskCreated },
  { tool: "claude_code", hookKey: "TaskCompleted", eventName: EVENTS.TaskCompleted },
  { tool: "claude_code", hookKey: "Stop", eventName: EVENTS.TurnEnded },
  { tool: "claude_code", hookKey: "SessionEnd", eventName: EVENTS.SessionEnd },
];
