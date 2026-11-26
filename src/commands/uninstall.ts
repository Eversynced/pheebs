import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripBom } from "../bom.js";
import {
  AI_TOOLS,
  type AiTool,
  getHookDefinitionsForTool,
  isPheebsEntry,
} from "../hooks/definitions.js";
import { forgetInstalls, listInstalls } from "../installs.js";
import {
  isLegacyTool,
  type LegacyTool,
  legacyConfigPaths,
  removeLegacyInstall,
} from "../legacy.js";
import { syncClaudeOtelEnv } from "../otel.js";
import { removeOutbox } from "../outbox.js";
import { removeSessions } from "../usage-sessions.js";
import { resolveSettingsPath } from "./path.js";

/** Returns whether the file was dealt with. A malformed one is left alone and reported, so
 *  the caller can keep its registry entry rather than forgetting a repo it never cleared. */
export function removeFromJsonConfig(settingsPath: string, tool: AiTool): boolean {
  if (!existsSync(settingsPath)) return true;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(stripBom(readFileSync(settingsPath, "utf-8")));
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

/** Best-effort per file: one unwritable or malformed settings file must not strand the repos
 *  later in the sweep, which would leave their hooks calling a binary that is about to go. */
function removeFrom(tool: AiTool | LegacyTool, settingsPath: string): boolean {
  try {
    return isLegacyTool(tool)
      ? removeLegacyInstall(tool, settingsPath)
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
  const targets = new Map<string, AiTool | LegacyTool>();

  targets.set(resolveSettingsPath(false).path, AI_TOOLS.CLAUDE_CODE);
  targets.set(resolveSettingsPath(true).path, AI_TOOLS.CLAUDE_CODE);
  for (const { tool, path } of legacyConfigPaths()) {
    targets.set(path, tool);
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

  // Events still queued for the backend go with the hooks: nothing would send them now. The local
  // log keeps its copy.
  if (!removeOutbox()) {
    console.warn("pheebs: could not remove the send queue in ~/.pheebs/outbox; delete it by hand");
  }
  removeSessions();
}
