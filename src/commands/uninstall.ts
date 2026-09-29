import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  AI_TOOLS,
  type AiTool,
  getHookDefinitionsForTool,
  isPheebsEntry,
} from "../hooks/definitions.js";
import { forgetInstalls, listInstalls } from "../installs.js";
import { syncClaudeOtelEnv, syncCodexOtel } from "../otel.js";
import { resolveSettingsPath } from "./path.js";

/** Returns whether the file was dealt with. A malformed one is left alone and reported, so
 *  the caller can keep its registry entry rather than forgetting a repo it never cleared. */
export function removeFromJsonConfig(settingsPath: string, tool: AiTool): boolean {
  if (!existsSync(settingsPath)) return true;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    console.warn(`pheebs: ${settingsPath} is malformed, skipping`);
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return true;

  const hookKeys = [...new Set(getHookDefinitionsForTool(tool).map((d) => d.hookKey))];
  let removed = 0;

  for (const key of hookKeys) {
    const entries = hooks[key];
    if (!Array.isArray(entries)) continue;

    const before = entries.length;
    const filtered = entries.filter((e) => !isPheebsEntry(e));
    removed += before - filtered.length;

    if (filtered.length === 0) {
      delete hooks[key];
    } else {
      hooks[key] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  if (tool === AI_TOOLS.CLAUDE_CODE) {
    syncClaudeOtelEnv(settings, false);
  }

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`pheebs: removed ${removed} hook entries from ${settingsPath}`);
  return true;
}

/** Returns whether the file was dealt with, for the reason on `removeFromJsonConfig`. */
export function removeFromTomlConfig(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return true;

  let config: Record<string, unknown>;
  try {
    config = parseToml(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    console.warn(`pheebs: ${settingsPath} is malformed, skipping`);
    return false;
  }

  const hooks = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return true;

  const hookKeys = [...new Set(getHookDefinitionsForTool(AI_TOOLS.CODEX).map((d) => d.hookKey))];
  let removed = 0;

  for (const key of hookKeys) {
    const entries = Array.isArray(hooks[key]) ? hooks[key] : [hooks[key]].filter(Boolean);
    const before = entries.length;
    const filtered = entries.filter((e) => !isPheebsEntry(e));
    removed += before - filtered.length;

    if (filtered.length === 0) {
      delete hooks[key];
    } else {
      hooks[key] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
  }

  syncCodexOtel(config, false);

  writeFileSync(settingsPath, `${stringifyToml(config)}\n`);
  console.log(`pheebs: removed ${removed} hook entries from ${settingsPath}`);
  return true;
}

/** Best-effort per file: one unwritable or malformed settings file must not strand the repos
 *  later in the sweep, which would leave their hooks calling a binary that is about to go. */
function removeFrom(tool: AiTool, settingsPath: string): boolean {
  try {
    return tool === AI_TOOLS.CODEX
      ? removeFromTomlConfig(settingsPath)
      : removeFromJsonConfig(settingsPath, tool);
  } catch {
    console.warn(`pheebs: could not clear ${settingsPath}, skipping`);
    return false;
  }
}

/**
 * Every install, not just this directory's. Project-local is the default scope, so hooks and
 * the exporter config are spread across repos, and clearing only the current one leaves the
 * rest calling a binary that is about to be gone and still exporting with the token.
 *
 * The user-level and current-directory paths are still derived, so an install that predates
 * the registry is cleaned up too.
 */
export async function runUninstall(): Promise<void> {
  const targets = new Map<string, AiTool>();

  for (const tool of Object.values(AI_TOOLS)) {
    targets.set(resolveSettingsPath(tool, false).path, tool);
    targets.set(resolveSettingsPath(tool, true).path, tool);
  }

  for (const { tool, path } of listInstalls()) {
    targets.set(path, tool);
  }

  const cleared = new Set<string>();
  for (const [settingsPath, tool] of targets) {
    if (removeFrom(tool, settingsPath)) {
      cleared.add(settingsPath);
    }
  }

  forgetInstalls(cleared);
}
