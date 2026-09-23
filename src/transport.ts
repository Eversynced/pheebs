import type { LogEntry } from "./logger.js";
import { DebugTransport } from "./transports/debug.js";
import { HttpTransport } from "./transports/http.js";

/** One classification verdict from the backend. */
export interface ClassifyResult {
  label: string;
  requests_verification?: boolean;
  classifier_version?: string;
}

// The single seam for backend calls — event ingest and prompt classification both ride it.
// Swapping the transport (or pointing it at a different endpoint) swaps the backend for both,
// so the classifier's execution model stays a config choice, not a client re-architecture.
export interface RemoteTransport {
  send(entry: LogEntry): void;
  classify(prompt: string): Promise<ClassifyResult | undefined>;
}

export function getTransport(): RemoteTransport {
  if (process.env.PHEEBS_DEBUG) {
    return new DebugTransport();
  }
  return new HttpTransport();
}
