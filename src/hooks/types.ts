export const AI_TOOLS = {
  CLAUDE_CODE: "claude_code",
  CURSOR: "cursor",
  CODEX: "codex",
} as const;

export type AiTool = (typeof AI_TOOLS)[keyof typeof AI_TOOLS];

// Set on a local classifier's `claude -p`. Managed (policy) hooks still fire under
// `disableAllHooks`, so a pheebs hook deployed that way runs inside the child; it reads this and
// records nothing. Kept here, not beside the spawn, so every hook reads it without loading that.
export const RECURSION_GUARD_ENV = "PHEEBS_LOCAL_CLASSIFIER";

export const EVENTS = {
  SessionStarted: "session_started",
  InstructionsLoaded: "instructions_loaded",
  ModelSwitched: "model_switched",
  PromptSubmitted: "prompt_submitted",
  CommandExpanded: "command_expanded",
  SubagentSpawned: "subagent_spawned",
  SubagentCompleted: "subagent_completed",
  ToolInvoked: "tool_invoked",
  ToolUseCompleted: "tool_use_completed",
  ToolUseFailed: "tool_use_failed",
  ContextCompacted: "context_compacted",
  CompactionCompleted: "compaction_completed",
  TaskCreated: "task_created",
  TaskCompleted: "task_completed",
  TurnEnded: "turn_ended",
  SessionEnd: "session_end",
  PermissionRequested: "permission_requested",
  ArtifactFound: "artifact_found",
} as const;

export type PheebsEvent = (typeof EVENTS)[keyof typeof EVENTS];

export interface HookDefinition {
  tool: AiTool;
  hookKey: string;
  eventName: PheebsEvent;
  matcher?: string;
  cliArgs?: string;
}

export const TOOL_LABELS: Record<AiTool, string> = {
  [AI_TOOLS.CLAUDE_CODE]: "Claude Code",
  [AI_TOOLS.CURSOR]: "Cursor",
  [AI_TOOLS.CODEX]: "Codex",
};
