import { homedir } from "node:os";
import { join } from "node:path";
import { AI_TOOLS, type AiTool } from "../hooks/definitions.js";

type Level = "project-level" | "user-level";

const CLAUDE_DIR = ".claude";
const CURSOR_DIR = ".cursor";
const CODEX_DIR = ".codex";

const CODEX_CONFIG_FILENAME = "config.toml";
const CURSOR_CONFIG_FILENAME = "hooks.json";
const CLAUDE_CONFIG_FILENAME = "settings.json";
const CLAUDE_PROJECT_CONFIG_FILENAME = "settings.local.json";

export function cursorPath(project: boolean, level: Level) {
  const base = project ? join(process.cwd(), CURSOR_DIR) : join(homedir(), CURSOR_DIR);
  return { path: join(base, CURSOR_CONFIG_FILENAME), level };
}

export function codexPath(project: boolean, level: Level) {
  const base = project ? join(process.cwd(), CODEX_DIR) : join(homedir(), CODEX_DIR);
  return { path: join(base, CODEX_CONFIG_FILENAME), level };
}

export function claudePath(project: boolean, level: Level) {
  const base = project ? join(process.cwd(), CLAUDE_DIR) : join(homedir(), CLAUDE_DIR);
  const file = project ? CLAUDE_PROJECT_CONFIG_FILENAME : CLAUDE_CONFIG_FILENAME;
  return { path: join(base, file), level };
}

export function resolveSettingsPath(
  tool: AiTool,
  project: boolean,
): { path: string; level: string } {
  const level = project ? "project-level" : "user-level";

  if (tool === AI_TOOLS.CURSOR) {
    return cursorPath(project, level);
  }

  if (tool === AI_TOOLS.CODEX) {
    return codexPath(project, level);
  }

  return claudePath(project, level);
}
