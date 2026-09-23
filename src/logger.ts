import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PheebsConfig } from "./config.js";
import type { AiTool } from "./hooks/definitions.js";
import { getTransport } from "./transport.js";

export interface LogEntry {
  timestamp: string;
  source: "hook";
  event: string;
  developer: string;
  codebase: string;
  ai_tool: AiTool;
  session_id: string;
  [key: string]: unknown;
}

export function appendLogEntry(entry: LogEntry, config: PheebsConfig): void {
  const date = new Date().toISOString();
  const dayStamp = date.slice(0, 10);
  const safeCodebaseId = config.codebaseId.replace(/\//g, "--");
  const filename = `${safeCodebaseId}-${dayStamp}.jsonl`;
  const fullPath = path.join(config.logPath, filename);

  mkdirSync(path.dirname(fullPath), { recursive: true });

  if (!entry.timestamp) entry.timestamp = date;

  appendFileSync(fullPath, `${JSON.stringify(entry)}\n`);

  getTransport().send(entry);
}
