import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AI_TOOLS, type AiTool } from "../hooks/definitions.js";

const HOME = homedir();

/** Whether `name` resolves on PATH. Windows has no `which` outside Git Bash; `where` is its
 *  counterpart and likewise exits non-zero when nothing matches. */
export function commandExists(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DETECTORS: Record<AiTool, () => boolean> = {
  [AI_TOOLS.CLAUDE_CODE]: () => commandExists("claude") || existsSync(join(HOME, ".claude")),
  [AI_TOOLS.CURSOR]: () => commandExists("cursor") || existsSync(join(HOME, ".cursor")),
  [AI_TOOLS.CODEX]: () => commandExists("codex") || existsSync(join(HOME, ".codex")),
};

export function detectInstalledTools(): AiTool[] {
  return (Object.keys(DETECTORS) as AiTool[]).filter((tool) => DETECTORS[tool]());
}
