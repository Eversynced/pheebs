import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasBackend, validateUrl } from "./backend-config.js";
import { readJsonFile, writeJsonFile } from "./pheebs-store.js";

const TOKEN_PATH = join(homedir(), ".pheebs", ".token");

export type TokenRole = "engineer" | "manager";

/** Locally stored Pheebs API token. Only `id` (not the secret) is ever stamped on events. */
export interface StoredToken {
  token: string;
  id?: string;
  developer?: string;
  tenant?: string;
  /** Tenant consent gate for prompt collection, cached so it can be honored offline. */
  prompt_collection?: boolean;
  /** Which report the token can draw, cached to decide whether to offer `insights --team`. */
  role?: TokenRole;
  /** ISO time of the last successful validation; drives TTL revalidation. */
  last_validated_at?: string;
  /** ISO time of the last revalidation that got no answer; spaces out offline retries. */
  last_attempt_at?: string;
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
  /** Display only: the backend resolves the role from the token's own record on every call. */
  role?: string;
  reason?: string;
  /** Set by the client, never the backend: the HTTP status of a non-2xx answer. */
  status?: number;
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

/**
 * Courtesy only: whether to mention `--team`. A value edited by hand in `~/.pheebs/` gains
 * nothing, since `/insights/team` checks the role again on every call.
 */
export function isCachedManager(): boolean {
  return readStoredToken()?.role === "manager";
}

// Anything but the two known roles is not cached, so an unknown value reads as the default.
function roleOf(result: ValidateResult): TokenRole | undefined {
  return result.role === "manager" || result.role === "engineer" ? result.role : undefined;
}

export function writeStoredToken(stored: StoredToken): void {
  writeJsonFile(TOKEN_PATH, stored);
}

/** The token id used as the developer identity, if one has been resolved. */
export function getStoredTokenId(): string | undefined {
  const id = readStoredToken()?.id;
  // Hand-editable JSON: anything but a non-empty string is no id at all.
  return typeof id === "string" && id ? id : undefined;
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
export async function validateToken(
  token: string,
  timeoutMs?: number,
): Promise<ValidateResult | undefined> {
  // Indistinguishable from an unreachable backend on purpose: with no endpoint there is
  // nothing to reject the token, so the caller degrades exactly as it does when offline.
  if (!hasBackend()) return undefined;

  try {
    const res = await fetch(validateUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    // 5xx is a backend failure, not a verdict: degrade offline, don't reject.
    if (res.status >= 500) return undefined;
    if (!res.ok) return { allowed: false, reason: "unknown", status: res.status };
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
            role: existing.role,
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
    role: roleOf(result),
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

// Past this, the next session start revalidates so a server-side revoke reaches the machine.
const REVALIDATE_TTL_MS = 12 * 60 * 60 * 1000;

// After a revalidation that got no answer, so an offline machine does not wait on every session.
const RETRY_AFTER_MS = 60 * 60 * 1000;

// Session start waits on this under Cursor and Codex, which run hooks synchronously.
const REVALIDATE_TIMEOUT_MS = 2000;

function within(iso: string | undefined, ms: number): boolean {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) && Date.now() - at < ms;
}

/**
 * If the stored token is past its TTL, revalidate and rewrite the cache. Bounded: a backend
 * that gives no verdict keeps the cached id and is retried after RETRY_AFTER_MS. A token
 * stored offline has never been validated, so it is always stale and resolves its id on the
 * first answer. Returns true when the token was revoked and cleared, so the caller can pull it
 * out of the exporter config too.
 */
export async function revalidateStoredTokenIfStale(): Promise<boolean> {
  // Without an endpoint there is no one to ask, and so no failed attempt to record.
  if (!hasBackend()) return false;
  const stored = readStoredToken();
  if (!stored) return false;
  if (within(stored.last_validated_at, REVALIDATE_TTL_MS)) return false;
  if (within(stored.last_attempt_at, RETRY_AFTER_MS)) return false;

  const result = await validateToken(stored.token, REVALIDATE_TIMEOUT_MS);

  // The file is shared by every session and by `config set token`, and the wait above is long
  // enough for either to rewrite it. Writing back over a token this call did not read would
  // resurrect an unset token or overwrite a new one.
  const current = readStoredToken();
  if (!current || current.token !== stored.token) return false;

  if (result?.reason === "revoked") {
    clearStoredToken();
    return true;
  }

  // A non-2xx status comes from a proxy as often as from the backend, so it is no answer and
  // keeps the id. Written over what is on disk now, not what was read before the wait.
  if (result === undefined || result.status !== undefined) {
    writeStoredToken({ ...current, last_attempt_at: new Date().toISOString() });
    return false;
  }

  // A 2xx without an id is the backend's own rejection: drop the identity and consent with it.
  if (!result.id) {
    writeStoredToken({ token: stored.token, last_validated_at: new Date().toISOString() });
    return false;
  }

  writeStoredToken({
    token: stored.token,
    id: result.id,
    developer: result.developer,
    tenant: result.tenant ?? undefined,
    // Narrows only. A revoke reaches the machine here, but a grant waits for the developer to
    // set the token again, so prompt text never starts leaving a machine with no local action.
    prompt_collection: stored.prompt_collection === true && result.prompt_collection === true,
    role: roleOf(result),
    last_validated_at: new Date().toISOString(),
  });
  return false;
}
