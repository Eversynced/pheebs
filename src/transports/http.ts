import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { baseUrl, classifyPromptUrl, hasBackend } from "../backend-config.js";
import type { LogEntry } from "../logger.js";
import {
  enqueue,
  isFlusherLive,
  MAX_PAUSE_MS,
  readState,
  remainingMs,
  scopeDir,
  scopeKey,
} from "../outbox.js";
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

export function writeMarker(status: number): void {
  try {
    mkdirSync(dirname(TRANSPORT_ERROR_PATH), { recursive: true });
    writeFileSync(TRANSPORT_ERROR_PATH, `${new Date().toISOString()} token rejected (${status})\n`);
  } catch {}
}

// Re-invokes the running CLI rather than `pheebs` from PATH, which a hook environment may lack.
// Detached, unref'd and with no inherited stdio, so the hook exits at once and the agent never
// waits on the network; the child outlives the hook (see the 2026-10-20 ledger entry).
function startFlusher(): void {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  const child = spawn(process.execPath, [cliEntry, "flush", "--linger"], {
    detached: true,
    // Not the hook's directory, the developer's repo: Windows will not delete or rename a folder a
    // running process sits in, and the flusher can outlive the session by a minute.
    cwd: homedir(),
    stdio: "ignore",
    // A detached child gets its own console on Windows, which would flash a window over the editor.
    windowsHide: true,
  });
  // A spawn that fails asynchronously must not crash the hook process.
  child.on("error", () => {});
  child.unref();
}

/**
 * Queue one event envelope for the backend and make sure a flusher is on its way. The envelope is
 * sent generically: the server splits it into columns vs. extras. Nothing here touches the
 * network, and nothing throws into the hook, because the local JSONL log is the durable copy.
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

      const scope = scopeKey(baseUrl(), stored.token);
      const dir = scopeDir(scope);
      // Old scopes' queues are removed by the flusher, off the hook path: a backlog of thousands of
      // files is not something Cursor or Codex should wait on.
      enqueue(payload, dir);
      if (!isFlusherLive(dir) && remainingMs(readState(dir).nextAttemptAt, MAX_PAUSE_MS) === 0) {
        startFlusher();
      }
    } catch {
      // Belt-and-suspenders: send() must never throw into the hook (e.g. an unserializable
      // payload or an unwritable home). The event is already in the local JSONL log.
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
        // A followed redirect would carry the prompt to a host the developer never configured.
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stored.token}`,
        },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) return undefined;

      const data = (await res.json()) as {
        allowed?: boolean;
        result?: {
          label?: string;
          requests_verification?: boolean;
          classifier_version?: string;
          task_scope?: string;
        };
      };
      if (!data.allowed || typeof data.result?.label !== "string") return undefined;

      return {
        label: data.result.label,
        requests_verification: data.result.requests_verification,
        classifier_version: data.result.classifier_version,
        // Guarded like `label` above: a backend sending a number or null would otherwise put
        // that value, typed as a string, into the JSONL row and the ingest body.
        ...(typeof data.result.task_scope === "string"
          ? { task_scope: data.result.task_scope }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
}
