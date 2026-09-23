import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasBackend, validateUrl } from "./backend-config.js";
import { readJsonFile, writeJsonFile } from "./pheebs-store.js";

const TOKEN_PATH = join(homedir(), ".pheebs", ".token");

/** Locally stored Pheebs API token. Only `id` (not the secret) is ever stamped on events. */
export interface StoredToken {
  token: string;
  id?: string;
  developer?: string;
  tenant?: string;
  /** Tenant consent gate for prompt collection, cached so it can be honored offline. */
  prompt_collection?: boolean;
  /** ISO time of the last successful validation; drives TTL revalidation. */
  last_validated_at?: string;
}

/** Shape returned by the backend's /validate-token route. */
export interface ValidateResult {
  id?: string;
  developer?: string;
  tenant?: string | null;
  allowed: boolean;
  /** True when the developer has opted out of classification (base telemetry still flows). */
  opt_out?: boolean;
  /** True when the token's tenant has consented to prompt collection. */
  prompt_collection?: boolean;
  reason?: string;
}

export interface SetTokenOutcome {
  status: "set" | "opted_out" | "rejected" | "offline" | "unvalidated";
  message: string;
  developer?: string;
}

export function readStoredToken(): StoredToken | undefined {
  const parsed = readJsonFile<StoredToken>(TOKEN_PATH);
  return parsed?.token ? parsed : undefined;
}

export function writeStoredToken(stored: StoredToken): void {
  writeJsonFile(TOKEN_PATH, stored);
}

/** The token id used as the developer identity, if one has been resolved. */
export function getStoredTokenId(): string | undefined {
  return readStoredToken()?.id;
}

/** Remove the stored token. Returns whether a file existed. */
export function clearStoredToken(): boolean {
  try {
    if (!existsSync(TOKEN_PATH)) return false;
    unlinkSync(TOKEN_PATH);
    return true;
  } catch {
    return false;
  }
}

/** Last 4 characters of a token, for non-sensitive display. */
export function tokenLast4(token: string): string {
  return token.slice(-4);
}

/**
 * Resolve a token against the backend. Returns the validation result, or undefined if the
 * backend is unreachable (the caller decides how to degrade). The token travels in the body;
 * the /validate-token route is unauthenticated and needs no other credential.
 */
export async function validateToken(token: string): Promise<ValidateResult | undefined> {
  // Indistinguishable from an unreachable backend on purpose: with no endpoint there is
  // nothing to reject the token, so the caller degrades exactly as it does when offline.
  if (!hasBackend()) return undefined;

  try {
    const res = await fetch(validateUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    // 5xx is a backend failure, not a verdict: degrade offline, don't reject.
    if (res.status >= 500) return undefined;
    if (!res.ok) return { allowed: false, reason: "unknown" };
    return (await res.json()) as ValidateResult;
  } catch {
    return undefined;
  }
}

/**
 * Validate and store a token. Caches the resolved id/developer so `developer-id` can stamp
 * the id offline. Degrades gracefully when the backend is unreachable. Pure of any
 * printing/exiting so both the CLI command and the init wizard can reuse it.
 */
export async function setToken(token: string): Promise<SetTokenOutcome> {
  const l4 = tokenLast4(token);
  const result = await validateToken(token);

  if (result === undefined) {
    // Backend unreachable OR none configured: preserve any identity already resolved for this
    // token. The two are distinguished only in the message — telling a local-only developer to
    // wait for "the next successful call" points at a call that will never happen.
    const existing = readStoredToken();
    const preserved =
      existing?.token === token
        ? {
            token,
            id: existing.id,
            developer: existing.developer,
            tenant: existing.tenant,
            prompt_collection: existing.prompt_collection,
            last_validated_at: existing.last_validated_at,
          }
        : { token };
    writeStoredToken(preserved);
    return hasBackend()
      ? {
          status: "offline",
          message: `Stored token …${l4}; identity will resolve on the next successful call.`,
        }
      : {
          status: "unvalidated",
          message: `Stored token …${l4}; set an endpoint with \`pheebs config set base-url <url>\` to validate it.`,
        };
  }

  if (result.reason === "revoked") {
    return { status: "rejected", message: `Token …${l4} is revoked. Ask an admin for a new one.` };
  }

  if (!result.id) {
    return {
      status: "rejected",
      message: `Token …${l4} was rejected (${result.reason ?? "unknown"}).`,
    };
  }

  writeStoredToken({
    token,
    id: result.id,
    developer: result.developer,
    tenant: result.tenant ?? undefined,
    prompt_collection: result.prompt_collection,
    last_validated_at: new Date().toISOString(),
  });
  const who = result.developer ?? result.id;

  if (result.opt_out) {
    return {
      status: "opted_out",
      developer: result.developer,
      message: `Token set for ${who} (…${l4}); classification is opted out.`,
    };
  }

  return { status: "set", developer: result.developer, message: `Token set for ${who} (…${l4}).` };
}

// Past this, the next event revalidates so a server-side revoke reaches the machine.
const REVALIDATE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * If the stored token is past its TTL, revalidate and rewrite the cache. Non-blocking:
 * the caller keeps using the cached id; a revoked token drops its id here.
 */
export async function revalidateStoredTokenIfStale(): Promise<void> {
  const stored = readStoredToken();
  if (!stored?.id) return;
  const last = stored.last_validated_at ? Date.parse(stored.last_validated_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < REVALIDATE_TTL_MS) return;

  const result = await validateToken(stored.token);
  if (result === undefined) return; // unreachable: keep the cache

  // Revoked/unknown: drop the id so identity falls back. opt_out keeps its id.
  if (result.reason === "revoked" || !result.id) {
    writeStoredToken({ token: stored.token });
    return;
  }

  writeStoredToken({
    token: stored.token,
    id: result.id,
    developer: result.developer,
    tenant: result.tenant ?? undefined,
    prompt_collection: result.prompt_collection,
    last_validated_at: new Date().toISOString(),
  });
}
