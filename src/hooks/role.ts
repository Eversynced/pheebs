// Local, derived classification of a spawned sub-agent into a coarse role.
//
// Evals T2 looks for a separate review pass (one agent generates, another
// reviews). SubagentStart already carries the agent type, so this just maps
// that existing field to a role. No new instrumentation, no raw content.

export type SubagentRole = "review" | "generate";

// Keys are lowercased to match the lookup below. This is the only place new
// agent types are slotted in — a custom reviewer agent (e.g. `security-review`)
// is tagged `generate` until it is listed here.
const AGENT_ROLES: Record<string, SubagentRole> = {
  "code-reviewer": "review",
  "general-purpose": "generate",
  explore: "generate",
  explorer: "generate",
  plan: "generate",
  "claude-code-guide": "generate",
};

// Table-only classification: unknown agent types default to `generate` so a
// review pass is never credited unless its type is listed above. Crediting a
// review that never happened is the more damaging error here than missing one.
export function classifyRole(agentType: string): SubagentRole {
  return AGENT_ROLES[agentType.toLowerCase()] ?? "generate";
}
