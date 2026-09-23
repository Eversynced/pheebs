import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  AI_TOOLS,
  type AiTool,
  getHookDefinitionsForTool,
  isPheebsEntry,
} from "../hooks/definitions.js";
import { syncClaudeOtelEnv, syncCodexOtel } from "../otel.js";
import { resolveSettingsPath } from "./path.js";

export function removeFromJsonConfig(settingsPath: string, tool: AiTool): void {
  if (!existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    console.warn(`pheebs: ${settingsPath} is malformed, skipping`);
    return;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return;

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
}

export function removeFromTomlConfig(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;

  let config: Record<string, unknown>;
  try {
    config = parseToml(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    console.warn(`pheebs: ${settingsPath} is malformed, skipping`);
    return;
  }

  const hooks = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return;

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
}

function removeToolHooks(tool: AiTool): void {
  const { path: userPath } = resolveSettingsPath(tool, false);
  const { path: projectPath } = resolveSettingsPath(tool, true);

  if (tool === AI_TOOLS.CODEX) {
    removeFromTomlConfig(userPath);
    removeFromTomlConfig(projectPath);
  } else {
    removeFromJsonConfig(userPath, tool);
    removeFromJsonConfig(projectPath, tool);
  }
}

export async function runUninstall(): Promise<void> {
  for (const tool of Object.values(AI_TOOLS)) {
    removeToolHooks(tool);
  }
}
