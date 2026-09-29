import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AI_TOOLS, type AiTool } from "./hooks/definitions.js";
import { readJsonFile } from "./pheebs-store.js";

/**
 * The paths `init` has written, so later commands can reach installs outside the current
 * directory.
 *
 * Project-local is the default scope, which means the exporter config — endpoint and Bearer
 * token — lives in a file per repo. Nothing else knows where those files are: `config unset
 * base-url` would leave every repo but this one still exporting to the old backend, and
 * `uninstall` would leave their hooks calling a binary that is gone. Deriving the set is not
 * possible, so it is recorded.
 *
 * Local only, and never part of an event: this is the developer's own map of their machine,
 * kept 0600 beside the token, and no path in it is ever sent anywhere. The carve-out for it
 * is written into invariant 1 in AGENTS.md; nothing else may join it.
 */

const INSTALLS_PATH = join(homedir(), ".pheebs", "installs.json");

export interface InstallRecord {
  tool: AiTool;
  path: string;
}

const TOOLS = new Set<string>(Object.values(AI_TOOLS));

/** `tool` is checked against the real set because the consumers act on it: the resync writes
 *  the token into the path, and `uninstall` rewrites it in that tool's format. */
function isRecord(entry: unknown): entry is InstallRecord {
  if (typeof entry !== "object" || entry === null) return false;
  const { tool, path } = entry as InstallRecord;
  return typeof path === "string" && path !== "" && TOOLS.has(tool);
}

/** Every recorded install, unreachable ones included. */
function readInstalls(): InstallRecord[] {
  const raw = readJsonFile<unknown>(INSTALLS_PATH);
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/**
 * Atomic rewrite. A torn write leaves JSON that will not parse, and `readJsonFile` reports
 * that as an empty registry, which silently forgets every repo at once.
 */
function writeInstalls(records: InstallRecord[]): void {
  try {
    const temporary = `${INSTALLS_PATH}.${process.pid}`;
    mkdirSync(dirname(INSTALLS_PATH), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
    renameSync(temporary, INSTALLS_PATH);
  } catch {}
}

/**
 * Recorded installs whose file is still there. Pruning happens here rather than on write: a
 * path under an unmounted volume reads as absent, and dropping it would lose the only record
 * of a repo that is merely offline.
 */
export function listInstalls(): InstallRecord[] {
  return readInstalls().filter((entry) => existsSync(entry.path));
}

/**
 * Note that `init` wrote `path` for `tool`. Best-effort: a registry that cannot be written is
 * a degraded `uninstall` later, never a failed `init` now.
 */
export function recordInstall(tool: AiTool, path: string): void {
  const kept = readInstalls().filter((entry) => !(entry.tool === tool && entry.path === path));
  writeInstalls([...kept, { tool, path }]);
}

/** Drop the installs that were actually cleared, keeping the rest. A repo skipped as
 *  malformed or unwritable must not lose the sole record of where it is, or the next
 *  `uninstall` cannot reach it either. */
export function forgetInstalls(clearedPaths: Iterable<string>): void {
  const cleared = new Set(clearedPaths);
  writeInstalls(readInstalls().filter((entry) => !cleared.has(entry.path)));
}
