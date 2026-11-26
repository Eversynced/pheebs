import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { stripBom } from "./bom.js";
import { isPheebsEntry } from "./hooks/definitions.js";

/**
 * What `uninstall` needs to clear Cursor and Codex hooks and Codex's exporter config.
 * Nothing here writes a hook: `init` does not manage either tool, and the only reason this file
 * exists is that their entries can still sit in developers' config files and call this binary.
 */

export const LEGACY_TOOLS = ["cursor", "codex"] as const;
export type LegacyTool = (typeof LEGACY_TOOLS)[number];

const LEGACY_CONFIG: Record<LegacyTool, { dir: string; file: string }> = {
  cursor: { dir: ".cursor", file: "hooks.json" },
  codex: { dir: ".codex", file: "config.toml" },
};

export function isLegacyTool(value: unknown): value is LegacyTool {
  return typeof value === "string" && (LEGACY_TOOLS as readonly string[]).includes(value);
}

/** The user-level and current-directory config path of each removed tool. Install records add
 *  the rest. */
export function legacyConfigPaths(): { tool: LegacyTool; path: string }[] {
  return LEGACY_TOOLS.flatMap((tool) => {
    const { dir, file } = LEGACY_CONFIG[tool];
    return [homedir(), process.cwd()].map((base) => ({ tool, path: join(base, dir, file) }));
  });
}

/** Where an old Codex config can sit without a record. */
export function legacyCodexPaths(): string[] {
  return legacyConfigPaths()
    .filter((entry) => entry.tool === "codex")
    .map((entry) => entry.path);
}

/** Drops every pheebs entry under every hook key, and a key only if it held nothing else. */
function stripPheebsHooks(hooks: Record<string, unknown>): number {
  let removed = 0;
  for (const key of Object.keys(hooks)) {
    const value = hooks[key];
    const entries = Array.isArray(value) ? value : [value];
    const kept = entries.filter((entry) => !isPheebsEntry(entry));
    if (kept.length === entries.length) continue;
    removed += entries.length - kept.length;
    if (kept.length === 0) delete hooks[key];
    else hooks[key] = kept;
  }
  return removed;
}

/** Codex's exporter config sat under `[otel]`, with the token in its headers. Only a table that
 *  carries a pheebs token is ours to remove: the developer may have an `[otel]` of their own.
 *  `config set token` only accepts `pheebs_` tokens, so the prefix is how a token of ours shows. */
function stripCodexOtel(config: Record<string, unknown>): boolean {
  if (!JSON.stringify(config.otel ?? null).includes("Bearer pheebs_")) return false;
  delete config.otel;
  // The old exporter setup also switched `[analytics] enabled` on, which Codex needs to export.
  const analytics = config.analytics;
  if (typeof analytics === "object" && analytics !== null && !Array.isArray(analytics)) {
    delete (analytics as Record<string, unknown>).enabled;
    if (Object.keys(analytics).length === 0) delete config.analytics;
  }
  return true;
}

function readLegacyConfig(
  tool: LegacyTool,
  path: string,
  quiet = false,
): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = stripBom(readFileSync(path, "utf-8"));
  } catch {
    if (!quiet) console.warn(`pheebs: could not read ${path}, skipping`);
    return undefined;
  }
  try {
    const config = tool === "codex" ? parseToml(raw) : JSON.parse(raw);
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      return config as Record<string, unknown>;
    }
  } catch {}
  if (!quiet) console.warn(`pheebs: ${path} is malformed, skipping`);
  return undefined;
}

/** Renamed into place, so a crash mid-write cannot leave a truncated file the developer owns.
 *  Written beside the real file, because a symlinked config (a dotfiles manager) must stay one. */
function writeLegacyConfig(tool: LegacyTool, path: string, config: Record<string, unknown>): void {
  const text =
    tool === "codex" ? `${stringifyToml(config)}\n` : `${JSON.stringify(config, null, 2)}\n`;
  const target = realpathSync(path);
  const temp = `${target}.pheebs-tmp`;
  try {
    writeFileSync(temp, text, { mode: statSync(target).mode & 0o777 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Removes the pheebs exporter table from a recorded Codex config, for the token resync: a
 *  rotated or revoked token would otherwise keep exporting from a tool pheebs no longer manages.
 *  Silent on a bad file, because the resync runs inside a session's hook. */
export function stripLegacyCodexOtel(path: string): void {
  if (!existsSync(path)) return;
  const config = readLegacyConfig("codex", path, true);
  if (config && stripCodexOtel(config)) writeLegacyConfig("codex", path, config);
}

/** Returns whether the file was dealt with. A malformed one is left alone and reported, so the
 *  caller keeps its registry entry rather than forgetting a repo it never cleared. A file with
 *  nothing of ours in it is not rewritten. */
export function removeLegacyInstall(tool: LegacyTool, path: string): boolean {
  if (!existsSync(path)) return true;

  const config = readLegacyConfig(tool, path);
  if (!config) return false;

  const hooks = config.hooks;
  let removed = 0;
  if (typeof hooks === "object" && hooks !== null && !Array.isArray(hooks)) {
    removed = stripPheebsHooks(hooks as Record<string, unknown>);
    if (Object.keys(hooks).length === 0) delete config.hooks;
  }
  const otelRemoved = tool === "codex" && stripCodexOtel(config);
  if (removed === 0 && !otelRemoved) return true;

  writeLegacyConfig(tool, path, config);
  console.log(
    `pheebs: removed ${removed} hook entries${otelRemoved ? " and the OTel config" : ""} from ${path}`,
  );
  return true;
}
