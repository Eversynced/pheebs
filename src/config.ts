import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";

export interface PheebsConfig {
  codebaseId: string;
  logPath: string; // absolute, tilde-expanded
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

// Extract org/repo from an SSH or HTTPS git remote URL.
export function parseCodebaseId(remoteUrl: string): string {
  const match = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) return "unknown";
  const [, org, repo] = match;
  if (org.startsWith(".") || repo.startsWith(".")) return "unknown";
  return `${org}/${repo}`;
}

function tryGit(...args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// Resolve a codebase identifier for the working directory. Preference order:
//   1. PHEEBS_CODEBASE_ID override
//   2. git remote origin  → canonical "org/repo"
//   3. git repo root name → "local/<folder>"  (repo without a usable remote)
//   4. launch dir name    → "local/<folder>"  (started outside any git work tree)
// The "local/" prefix keeps these visually distinct from remote-backed repos so
// they can be quarantined out of per-codebase rollups. Only the final path
// *segment* (folder name) is ever used — never the full path — to stay within
// the privacy model (no file paths leave the machine).
export function detectCodebaseId(): string {
  const override = process.env.PHEEBS_CODEBASE_ID;
  if (override) return override;

  const remoteUrl = tryGit("remote", "get-url", "origin");
  if (remoteUrl) {
    const id = parseCodebaseId(remoteUrl);
    if (id !== "unknown") return id;
  }

  const dir = tryGit("rev-parse", "--show-toplevel") ?? process.cwd();
  const name = basename(dir);
  return name ? `local/${name}` : "unknown";
}

export function resolveLogPath(): string {
  const rawLogPath = process.env.PHEEBS_LOG_PATH || "~/.pheebs/logs/";
  return expandTilde(rawLogPath);
}

export function getConfig(): PheebsConfig {
  return { codebaseId: detectCodebaseId(), logPath: resolveLogPath() };
}
