export {
  AI_TOOLS,
  type AiTool,
  EVENTS,
  type HookDefinition,
  type PheebsEvent,
  TOOL_LABELS,
} from "./types.js";

import { CLAUDE_DEFINITIONS } from "./definitions.claude.js";
import type { AiTool, HookDefinition } from "./types.js";

export const ALL_DEFINITIONS: readonly HookDefinition[] = [...CLAUDE_DEFINITIONS];

export function getHookDefinitionsForTool(tool: AiTool): readonly HookDefinition[] {
  return ALL_DEFINITIONS.filter((d) => d.tool === tool);
}

// The shape of the hook entries pheebs writes into Claude Code's settings file.
// These are structures we construct and own, so they are typed concretely — unlike
// the parsed user settings we read back, which stay Record<string, unknown> at the
// external boundary (we don't control their shape).
interface CommandHook {
  type: "command";
  command: string;
  async?: boolean;
}

interface HookEntry {
  hooks: CommandHook[];
  matcher?: string;
}

/** Also matches the `pheebs hook-cursor` and `pheebs hook-codex` entries an old install wrote,
 *  which `uninstall` still has to find. */
export function isPheebsEntry(entry: unknown): boolean {
  // `entry` is a parsed user-settings value (external boundary), so narrow it
  // explicitly rather than casting blindly.
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj.command === "string" && obj.command.includes("pheebs hook")) {
    return true;
  }

  if (!Array.isArray(obj.hooks)) {
    return false;
  }
  return obj.hooks.some((h) => {
    if (typeof h !== "object" || h === null) {
      return false;
    }
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === "string" && cmd.includes("pheebs hook");
  });
}

const HOOK_CLI_PREFIX = "pheebs hook";

function buildEntry(def: HookDefinition, command: string): HookEntry {
  const entry: HookEntry = {
    hooks: [{ type: "command", command, async: true }],
  };
  if (def.matcher) {
    entry.matcher = def.matcher;
  }
  return entry;
}

export function buildHooksConfig(): Record<string, HookEntry[]> {
  const hooks: Record<string, HookEntry[]> = {};

  for (const def of ALL_DEFINITIONS) {
    if (!hooks[def.hookKey]) {
      hooks[def.hookKey] = [];
    }

    const command = def.cliArgs
      ? `${HOOK_CLI_PREFIX} ${def.eventName} ${def.cliArgs}`
      : `${HOOK_CLI_PREFIX} ${def.eventName}`;

    hooks[def.hookKey].push(buildEntry(def, command));
  }
  return hooks;
}
