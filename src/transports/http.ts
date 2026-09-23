import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classifyPromptUrl, hasBackend, ingestUrl } from "../backend-config.js";
import type { LogEntry } from "../logger.js";
import { readStoredToken } from "../token.js";
import type { ClassifyResult, RemoteTransport } from "../transport.js";

// Classification is a blocking request/response, so it self-bounds below the backend's ~3s.
const CLASSIFY_TIMEOUT_MS = 2500;

// Dropped when the backend rejects our token; `pheebs doctor` reads it to tell the
// developer to re-set the token. The event itself is still kept in the local JSONL log.
export const TRANSPORT_ERROR_PATH = join(homedir(), ".pheebs", ".last-transport-error");

// Never sent to the server. `logPath` is client-internal; `developer` is omitted because
// the server stamps identity from the token — a client-supplied developer is ignored.
const OMIT_KEYS = new Set(["logPath", "developer"]);

function writeMarker(status: number): void {
  try {
    mkdirSync(dirname(TRANSPORT_ERROR_PATH), { recursive: true });
    writeFileSync(TRANSPORT_ERROR_PATH, `${new Date().toISOString()} token rejected (${status})\n`);
  } catch {}
}

/**
 * Fire-and-forget POST of one event envelope to the backend `/ingest` route, authenticated
 * with the stored pheebs token. The envelope is sent generically — the server splits it into
 * columns vs. extras. Never throws or blocks the hook: the local JSONL log is the durable copy.
 */
export class HttpTransport implements RemoteTransport {
  send(entry: LogEntry): void {
    try {
      if (!hasBackend()) return; // local-only: no endpoint configured, the local log is the whole story

      const stored = readStoredToken();
      if (!stored) return; // no token to authenticate with; the local log is still written

      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (!OMIT_KEYS.has(key)) payload[key] = value;
      }

      fetch(ingestUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stored.token}`,
        },
        body: JSON.stringify(payload),
      })
        .then((res) => {
          // 401/403 is the one status worth surfacing (a stale token). Everything else —
          // success, other 4xx, 5xx — is swallowed: the local log is the durable copy.
          if (res.status === 401 || res.status === 403) {
            writeMarker(res.status);
          } else if (res.status === 422) {
            process.stderr.write("pheebs: event rejected as unprocessable (422)\n");
          }
        })
        .catch((err: unknown) => {
          process.stderr.write(`pheebs: remote send failed: ${err}\n`);
        });
    } catch {
      // Belt-and-suspenders: send() must never throw into the hook (e.g. an unserializable
      // payload). The event is already in the local JSONL log.
    }
  }

  /**
   * POST a prompt to the backend `/classify-prompt` proxy with the token; the proxy holds the model
   * credential and enforces consent again server-side. Returns undefined on any gated or degraded
   * path — no backend, no token, non-2xx, an `allowed:false` verdict, timeout, or any error — and
   * the caller degrades to unclassified.
   */
  async classify(prompt: string): Promise<ClassifyResult | undefined> {
    if (!hasBackend()) return undefined;

    const stored = readStoredToken();
    if (!stored?.token) return undefined;

    try {
      const res = await fetch(classifyPromptUrl(), {
        method: "POST",
        // The signal owns its own timer, so nothing is left to clear on the way out of a hook.
        signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stored.token}`,
        },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) return undefined;

      const data = (await res.json()) as {
        allowed?: boolean;
        result?: { label?: string; requests_verification?: boolean; classifier_version?: string };
      };
      if (!data.allowed || typeof data.result?.label !== "string") return undefined;

      return {
        label: data.result.label,
        requests_verification: data.result.requests_verification,
        classifier_version: data.result.classifier_version,
      };
    } catch {
      return undefined;
    }
  }
}
