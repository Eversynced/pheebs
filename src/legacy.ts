import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { stripBom } from "./bom.js";
import { isPheebsEntry } from "./hooks/definitions.js";

/**
 * What `uninstall` needs to clear an install made when Cursor and Codex were supported.
 * Nothing here writes a hook: both tools are gone from `init`, and the only reason this file
 * exists is that their hooks and Codex's exporter config still sit in developers' config files
 * and still call this binary.
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
 *  carries a pheebs token is ours to remove: the developer may have an `[otel]` of their own. */
function stripCodexOtel(config: Record<string, unknown>): boolean {
  if (!JSON.stringify(config.otel ?? null).includes("Bearer pheebs_")) return false;
  delete config.otel;
  const analytics = config.analytics as Record<string, unknown> | undefined;
  if (analytics) {
    delete analytics.enabled;
    if (Object.keys(analytics).length === 0) delete config.analytics;
  }
  return true;
}

function readLegacyConfig(tool: LegacyTool, path: string): Record<string, unknown> | undefined {
  try {
    const raw = stripBom(readFileSync(path, "utf-8"));
    const config = tool === "codex" ? parseToml(raw) : JSON.parse(raw);
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      return config as Record<string, unknown>;
    }
  } catch {}
  console.warn(`pheebs: ${path} is malformed, skipping`);
  return undefined;
}

function writeLegacyConfig(tool: LegacyTool, path: string, config: Record<string, unknown>): void {
  writeFileSync(
    path,
    tool === "codex" ? `${stringifyToml(config)}\n` : `${JSON.stringify(config, null, 2)}\n`,
  );
}

/** Removes the pheebs exporter table from a recorded Codex config, for the token resync: a
 *  rotated or revoked token would otherwise keep exporting from a tool pheebs no longer manages. */
export function stripLegacyCodexOtel(path: string): void {
  if (!existsSync(path)) return;
  const config = readLegacyConfig("codex", path);
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
