import type { LogEntry } from "../logger.js";
import type { ClassifyResult, RemoteTransport } from "../transport.js";

// In debug mode we skip all remote calls. Events are still captured in the local JSONL log,
// and classification degrades to unclassified upstream, so nothing is lost.
export class DebugTransport implements RemoteTransport {
  send(_entry: LogEntry): void {}

  classify(_prompt: string): Promise<ClassifyResult | undefined> {
    return Promise.resolve(undefined);
  }
}
