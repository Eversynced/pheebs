// Derives a coarse pass/fail tag from a Codex tool_response so the handler can
// synthesize the tool_use_failed event Claude and Cursor emit natively.
//
// PRIVACY: the raw tool_response is read only to derive the tag; it never leaves
// this module. Returns undefined when no signal is present (do not guess a failure).

export type ToolOutcome = "passed" | "failed";

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof obj[key] === "number") return obj[key] as number;
  }
  return undefined;
}

export function classifyCodexOutcome(toolResponse: unknown): ToolOutcome | undefined {
  if (typeof toolResponse !== "object" || toolResponse === null) return undefined;
  const response = toolResponse as Record<string, unknown>;

  // Shell tools (Bash / apply_patch): a non-zero exit status is a failure.
  const exitCode = numberField(response, ["exit_code", "exitCode"]);
  if (exitCode !== undefined) return exitCode === 0 ? "passed" : "failed";

  // MCP tool results carry an explicit error flag.
  if (typeof response.isError === "boolean") return response.isError ? "failed" : "passed";

  if (typeof response.success === "boolean") return response.success ? "passed" : "failed";

  // No recognizable signal: do not guess a failure.
  return undefined;
}
