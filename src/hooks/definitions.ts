export {
  AI_TOOLS,
  type AiTool,
  EVENTS,
  type HookDefinition,
  type PheebsEvent,
  TOOL_LABELS,
} from "./types.js";

import { CLAUDE_DEFINITIONS } from "./definitions.claude.js";
import { CODEX_DEFINITIONS } from "./definitions.codex.js";
import { CURSOR_DEFINITIONS } from "./definitions.cursor.js";
import { AI_TOOLS, type AiTool, type HookDefinition } from "./types.js";

export const ALL_DEFINITIONS: readonly HookDefinition[] = [
  ...CLAUDE_DEFINITIONS,
  ...CURSOR_DEFINITIONS,
  ...CODEX_DEFINITIONS,
];

export function getHookDefinitionsForTool(tool: AiTool): readonly HookDefinition[] {
  return ALL_DEFINITIONS.filter((d) => d.tool === tool);
}

// The shape of the hook entries pheebs writes into each tool's settings file.
// These are structures we construct and own, so they are typed concretely — unlike
// the parsed user settings we read back, which stay Record<string, unknown> at the
// external boundary (we don't control their shape).
interface CommandHook {
  type: "command";
  command: string;
  async?: boolean;
}

// Claude Code and Codex nest command hooks under `hooks`, optionally keyed by a matcher.
interface NestedHookEntry {
  hooks: CommandHook[];
  matcher?: string;
}

// Cursor registers a flat command entry with its own execution options.
interface CursorHookEntry {
  command: string;
  failClosed: boolean;
  timeout: number;
}

type HookEntry = NestedHookEntry | CursorHookEntry;

export function isPheebsEntry(entry: unknown): boolean {
  // `entry` is a parsed user-settings value (external boundary), so narrow it
  // explicitly rather than casting blindly.
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const obj = entry as Record<string, unknown>;

  // Cursor format: flat { command: "pheebs hook-cursor ..." }
  if (typeof obj.command === "string" && obj.command.includes("pheebs hook")) {
    return true;
  }

  // Claude Code / Codex format: nested { hooks: [{ command: "pheebs hook ..." }] }
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

const HOOK_CLI_PREFIX: Record<AiTool, string> = {
  [AI_TOOLS.CLAUDE_CODE]: "pheebs hook",
  [AI_TOOLS.CURSOR]: "pheebs hook-cursor",
  [AI_TOOLS.CODEX]: "pheebs hook-codex",
};

function buildClaudeCodeEntry(def: HookDefinition, command: string): NestedHookEntry {
  const entry: NestedHookEntry = {
    hooks: [{ type: "command", command, async: true }],
  };
  if (def.matcher) {
    entry.matcher = def.matcher;
  }
  return entry;
}

const CURSOR_HOOK_TIMEOUT_SECONDS = 10;

function buildCursorEntry(_def: HookDefinition, command: string): CursorHookEntry {
  return { command, failClosed: false, timeout: CURSOR_HOOK_TIMEOUT_SECONDS };
}

function buildCodexEntry(def: HookDefinition, command: string): NestedHookEntry {
  const group: NestedHookEntry = {
    hooks: [{ type: "command", command }],
  };
  if (def.matcher) {
    group.matcher = def.matcher;
  }
  return group;
}

export function buildHooksConfig(tool: AiTool = "claude_code"): Record<string, HookEntry[]> {
  const hooks: Record<string, HookEntry[]> = {};
  const buildEntry =
    tool === AI_TOOLS.CURSOR
      ? buildCursorEntry
      : tool === AI_TOOLS.CODEX
        ? buildCodexEntry
        : buildClaudeCodeEntry;

  for (const def of getHookDefinitionsForTool(tool)) {
    if (!hooks[def.hookKey]) {
      hooks[def.hookKey] = [];
    }

    const command = def.cliArgs
      ? `${HOOK_CLI_PREFIX[tool]} ${def.eventName} ${def.cliArgs}`
      : `${HOOK_CLI_PREFIX[tool]} ${def.eventName}`;

    hooks[def.hookKey].push(buildEntry(def, command));
  }
  return hooks;
}
