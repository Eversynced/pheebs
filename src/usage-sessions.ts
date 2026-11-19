import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile, restrictToOwner } from "./pheebs-store.js";
import type { SessionMark, SessionRecord, UsageTool } from "./usage-types.js";

/**
 * The sessions whose transcripts the flusher will read for token usage. A record holds the session
 * id, tool and codebase and two timestamps, never a path: the flusher finds the transcript from
 * the id (see `locateTranscript`).
 *
 * The hook writes `<key>.json` and the flusher writes `<key>.mark.json`, so no file has two
 * writers and a hook can never undo a cursor.
 */
const SESSIONS_ROOT = join(homedir(), ".pheebs", "sessions");
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const TOOLS = new Set<string>(["claude_code", "codex"]);

export interface Options {
  root?: string;
  now?: number;
}

export function sessionKey(tool: UsageTool, sessionId: string): string {
  return createHash("sha256").update(`${tool}\n${sessionId}`).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as SessionRecord;
  return (
    TOOLS.has(r.tool) &&
    typeof r.session_id === "string" &&
    typeof r.codebase === "string" &&
    typeof r.ended === "boolean" &&
    Number.isFinite(r.touched_at) &&
    Number.isFinite(r.started_at)
  );
}

// Staged and renamed, so a reader never sees half a file.
function writeAtomic(path: string, value: unknown): void {
  const staged = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
}

/**
 * Called from a hook, so it is one small write and nothing more. The transcript is never opened
 * here. It throws on an unwritable folder, and the caller treats that as nothing to record.
 */
export function noteSession(
  record: Omit<SessionRecord, "touched_at" | "started_at">,
  { root = SESSIONS_ROOT, now = Date.now() }: Options = {},
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${sessionKey(record.tool, record.session_id)}.json`);
  const previous = readJsonFile<Partial<SessionRecord>>(path);
  const fresh = previous === undefined;
  const started_at = Number.isFinite(previous?.started_at) ? (previous?.started_at as number) : now;
  writeAtomic(path, { ...record, started_at, touched_at: now });
  if (fresh && process.platform === "win32") restrictToOwner(path);
}

export function listSessions(
  root = SESSIONS_ROOT,
): { key: string; record: SessionRecord; mark: SessionMark }[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const sessions: { key: string; record: SessionRecord; mark: SessionMark }[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const key = name.slice(0, -5);
    const record = readJsonFile<unknown>(join(root, name));
    if (!isRecord(record)) continue;
    const mark = readJsonFile<SessionMark>(join(root, `${key}.mark.json`));
    sessions.push({ key, record, mark: mark?.cursors ? mark : { cursors: {} } });
  }
  return sessions;
}

export function writeMark(key: string, mark: SessionMark, root = SESSIONS_ROOT): void {
  writeAtomic(join(root, `${key}.mark.json`), mark);
}

/** Drops records, and their marks, untouched for 30 days. */
export function pruneSessions(now = Date.now(), root = SESSIONS_ROOT): void {
  for (const { key, record } of listSessions(root)) {
    if (now - record.touched_at < KEEP_MS) continue;
    for (const name of [`${key}.json`, `${key}.mark.json`]) {
      try {
        rmSync(join(root, name), { force: true });
      } catch {}
    }
  }
}
