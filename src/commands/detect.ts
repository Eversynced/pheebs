import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AI_TOOLS, type AiTool } from "../hooks/definitions.js";
import { systemExe } from "../windows.js";

const HOME = homedir();

/** False on any failure, so a lookup tool that is itself missing reads as not installed. Windows
 *  has no `which` outside Git Bash; `where` with a `$PATH:` prefix searches PATH alone, so a file
 *  of the same name in the current folder does not count. */
export function commandExists(name: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync(systemExe("where.exe"), [`$PATH:${name}`], { stdio: "pipe", windowsHide: true });
    } else {
      execFileSync("which", [name], { stdio: "pipe" });
    }
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
