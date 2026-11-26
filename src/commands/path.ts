import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = ".claude";
const CLAUDE_CONFIG_FILENAME = "settings.json";
const CLAUDE_PROJECT_CONFIG_FILENAME = "settings.local.json";

export function resolveSettingsPath(project: boolean): { path: string; level: string } {
  const base = project ? join(process.cwd(), CLAUDE_DIR) : join(homedir(), CLAUDE_DIR);
  const file = project ? CLAUDE_PROJECT_CONFIG_FILENAME : CLAUDE_CONFIG_FILENAME;
  return { path: join(base, file), level: project ? "project-level" : "user-level" };
}
