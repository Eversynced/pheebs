import { hasBackend, insightsUrl } from "./backend-config.js";
import { readStoredToken } from "./token.js";

// A developer is waiting at a prompt for this, so it self-bounds rather than hanging on a
// backend that never answers.
const INSIGHTS_TIMEOUT_MS = 10_000;

// The timeout does not bound a fast link: a 400 MB body arrives in about a second and buffers
// into the heap before anything gets to reject it. A report over a few MB is a broken backend.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type InsightsFetch =
  | { ok: true; payload: unknown; body: string }
  | { ok: false; error: string };

// Undefined once the response goes past the cap, with the rest of it left unread.
async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) return res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * `GET /insights` with the stored token. Every failure comes back as a message for the caller to
 * print rather than an exception, because the distinction a developer needs is which of the
 * reachable problems they have, not a stack trace.
 */
export async function fetchInsights(days?: number): Promise<InsightsFetch> {
  if (!hasBackend()) {
    return {
      ok: false,
      error:
        "No backend endpoint set, so there is nothing to report on. Set one with `pheebs config set base-url <url>`.",
    };
  }

  const stored = readStoredToken();
  if (!stored?.token) {
    return {
      ok: false,
      error: "No Pheebs token set. Run `pheebs config set token <token>`.",
    };
  }

  const url = new URL(insightsUrl());
  if (days !== undefined) url.searchParams.set("days", String(days));

  // The signal owns its own timer, which fires once and never holds the process open.
  const signal = AbortSignal.timeout(INSIGHTS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal,
      // Not followed: a redirect would render a report from a host the developer never
      // configured, and the whole payload is drawn into their terminal.
      redirect: "manual",
      headers: { Authorization: `Bearer ${stored.token}` },
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "Your token was rejected. Re-run `pheebs config set token <token>`.",
      };
    }
    if (res.status === 404 || res.status === 405) {
      return { ok: false, error: "This backend does not serve /insights." };
    }
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        error: "The backend redirected. Point `base-url` at the host that serves /insights.",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `The backend answered ${res.status}.` };
    }

    // The raw body is kept so `--json` can print exactly what arrived, key order included.
    const body = await readCapped(res);
    if (body === undefined) {
      return { ok: false, error: "The backend's response was too large to read." };
    }
    if (res.status === 204 || body.trim() === "") {
      return { ok: false, error: "The backend returned no report." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: "The backend answered something that is not JSON." };
    }
    // Any JSON at all would otherwise render as a clean, plausible, empty report, so a `base-url`
    // pointed at an unrelated endpoint would look like a working backend that computes nothing.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "That endpoint did not answer with a Pheebs /insights report." };
    }
    return { ok: true, payload: parsed, body };
  } catch {
    // The signal is asked rather than the error: a deadline that lands mid-body surfaces as a
    // plain abort whose name says nothing about what caused it.
    return {
      ok: false,
      error: signal.aborted
        ? "The backend did not answer in time."
        : "Could not reach the backend.",
    };
  }
}
