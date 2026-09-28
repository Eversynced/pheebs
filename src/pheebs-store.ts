import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared persistence for the small owner-private files under ~/.pheebs (the token and
// the endpoint config). Both need the same JSON-read and 0600-write behavior, so it lives
// in one place rather than being hand-rolled per file.

/** Read and JSON-parse a file; undefined if it is missing, empty, or malformed. */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrow an existing file to owner-only. For the agent config files pheebs writes the Bearer
 * token into: those belong to the agent, not to pheebs, so they are written in the agent's
 * own format and only their permissions are ours to tighten. Best-effort, and never widens.
 */
export function restrictToOwner(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {}
}

/** Write JSON with owner-only (0600) perms, creating the parent dir. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // mode is ignored when the file already exists, so enforce it explicitly.
  try {
    chmodSync(path, 0o600);
  } catch {}
}
