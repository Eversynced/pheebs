import { classifyMode } from "./backend-config.js";
import { AI_TOOLS, type AiTool } from "./hooks/types.js";
import { optOutStatus, readStoredToken } from "./token.js";
import { type ClassifyResult, getTransport } from "./transport.js";

// Attributes attached to a prompt event. The client stores only these — never the prompt text.
export interface ClassifyAttributes {
  prompt_intent: string;
  requests_verification?: boolean;
  classifier_version?: string;
  // How big the work is, as the classifier sized it. Copied, never derived: sizing a task by rule
  // would be the keyword-rules approach that a classifier exists to replace, and the map from a
  // size to a model class is a consumer's table, not the client's.
  task_scope?: string;
}

/**
 * Classify a prompt's intent, returning attributes to attach to the event — or undefined only
 * when classification is switched off (`pheebs config set classify off`) or there is no prompt.
 * Every other path (no token, no consent, opted out, timeout, proxy error, gated) resolves to
 * `unclassified` so a prompt event always carries an intent, and the developer is never blocked.
 *
 * `on` sends prompt text only to the backend, under a token and its tenant's consent; `local`
 * sends it only to the developer's own Claude Code login, unless they opted out. `local` runs on
 * Claude Code only: Cursor and Codex wait on their hooks.
 */
export async function classifyPrompt(
  prompt: string,
  tool: AiTool,
): Promise<ClassifyAttributes | undefined> {
  const mode = classifyMode();
  if (mode === "off" || !prompt) return undefined;

  const result =
    mode === "local" ? await classifyOnMachine(prompt, tool) : await classifyRemotely(prompt);
  if (!result?.label) return { prompt_intent: "unclassified" };

  return {
    prompt_intent: result.label,
    ...(result.requests_verification !== undefined
      ? { requests_verification: result.requests_verification }
      : {}),
    ...(result.classifier_version !== undefined
      ? { classifier_version: result.classifier_version }
      : {}),
    ...(result.task_scope !== undefined ? { task_scope: result.task_scope } : {}),
  };
}

async function classifyRemotely(prompt: string): Promise<ClassifyResult | undefined> {
  const stored = readStoredToken();
  if (!stored?.token || !stored.prompt_collection) return undefined;
  return getTransport().classify(prompt);
}

async function classifyOnMachine(
  prompt: string,
  tool: AiTool,
): Promise<ClassifyResult | undefined> {
  if (tool !== AI_TOOLS.CLAUDE_CODE) return undefined;
  const optOut = optOutStatus();
  // Unknown is not permission: wait for the answer rather than classify a developer who may have
  // opted out.
  if (optOut === "opted_out" || optOut === "unknown") return undefined;
  // Imported here so hooks outside local mode never load the spawn path and the codebook.
  const { classifyLocally } = await import("./classify-local.js");
  return classifyLocally(prompt);
}
