import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "./pheebs-store.js";
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
// A mark outlives its record: a resumed session gets a new record and must carry on from the old
// offsets, or its whole transcript would be counted again.
const KEEP_MARK_MS = 180 * 24 * 60 * 60 * 1000;

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
    typeof r.scope === "string" &&
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
  record: Omit<SessionRecord, "touched_at" | "started_at" | "ended"> & { ended?: boolean },
  { root = SESSIONS_ROOT, now = Date.now() }: Options = {},
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${sessionKey(record.tool, record.session_id)}.json`);
  const previous = readJsonFile<Partial<SessionRecord>>(path);
  const started_at = Number.isFinite(previous?.started_at) ? (previous?.started_at as number) : now;
  // Only a start or an end says whether the session is over. A Stop that lands after SessionEnd
  // must not reopen it.
  const ended = record.ended ?? previous?.ended === true;
  writeAtomic(path, { ...record, ended, started_at, touched_at: now });
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

/** Drops records untouched for 30 days, and marks with no record for 180. */
export function pruneSessions(now = Date.now(), root = SESSIONS_ROOT): void {
  const drop = (name: string) => {
    try {
      rmSync(join(root, name), { force: true });
    } catch {}
  };
  const live = new Set<string>();
  for (const { key, record } of listSessions(root)) {
    if (now - record.touched_at < KEEP_MS) live.add(key);
    else drop(`${key}.json`);
  }
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {}
  for (const name of names) {
    const match = /^([0-9a-f]{32})\.mark\.json$/.exec(name);
    if (!match || live.has(match[1])) continue;
    try {
      if (now - statSync(join(root, name)).mtimeMs >= KEEP_MARK_MS) drop(name);
    } catch {}
  }
}

/** Forgets every session, for `uninstall`. */
export function removeSessions(root = SESSIONS_ROOT): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

/** Forgets one session's record, for a scope that is no longer the configured one. */
export function forgetSession(key: string, root = SESSIONS_ROOT): void {
  for (const name of [`${key}.json`, `${key}.mark.json`]) {
    try {
      rmSync(join(root, name), { force: true });
    } catch {}
  }
}
