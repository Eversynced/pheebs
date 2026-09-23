import { classifyEnabled } from "./backend-config.js";
import { readStoredToken } from "./token.js";
import { getTransport } from "./transport.js";

// Attributes attached to a prompt event. The client stores only these — never the prompt text.
export interface ClassifyAttributes {
  prompt_intent: string;
  requests_verification?: boolean;
  classifier_version?: string;
}

/**
 * Classify a prompt's intent, returning attributes to attach to the event — or undefined only
 * when classification is switched off (`pheebs config set classify off`) or there is no prompt.
 * Every other path (no token, no consent, timeout, proxy error, gated) resolves to
 * `unclassified` so a prompt event always carries an intent, and the developer is never blocked.
 *
 * Privacy: a prompt is the only raw content the client sends off-machine, so it gates on LOCAL
 * consent — a token AND its tenant's `prompt_collection` sign-off — and returns `unclassified`
 * WITHOUT sending any prompt text otherwise. The backend enforces the same consent again. The
 * actual call runs through the transport (`getTransport().classify`), the same swappable seam as
 * event ingest, so the classifier backend is a config choice rather than a client concern.
 */
export async function classifyPrompt(prompt: string): Promise<ClassifyAttributes | undefined> {
  if (!classifyEnabled() || !prompt) return undefined;

  const stored = readStoredToken();
  if (!stored?.token || !stored.prompt_collection) return { prompt_intent: "unclassified" };

  const result = await getTransport().classify(prompt);
  if (!result?.label) return { prompt_intent: "unclassified" };

  return {
    prompt_intent: result.label,
    ...(result.requests_verification !== undefined
      ? { requests_verification: result.requests_verification }
      : {}),
    ...(result.classifier_version !== undefined
      ? { classifier_version: result.classifier_version }
      : {}),
  };
}
