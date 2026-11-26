import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./usage-types.js";

// The hook never stores a transcript's path, so the flusher finds the file from the session id.
// The search is bounded: one level of project folders.
const MAX_PROJECT_DIRS = 5_000;

// A session id becomes part of a file name, so anything that is not id-shaped is refused, which
// keeps a path separator or `..` out of the lookup.
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export interface LocateOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function claudeConfigDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [env.CLAUDE_CONFIG_DIR, join(home, ".claude")];
  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith(".claude-")) dirs.push(join(home, name));
    }
  } catch {}
  return [...new Set(dirs.filter((dir): dir is string => !!dir))].filter((dir) =>
    existsSync(join(dir, "projects")),
  );
}

function findClaude(sessionId: string, home: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of claudeConfigDirs(home, env)) {
    const projects = join(dir, "projects");
    let names: string[];
    try {
      names = readdirSync(projects).slice(0, MAX_PROJECT_DIRS);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(projects, name, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

/**
 * Where a session's transcript is now, or undefined when it cannot be found: a custom config
 * directory outside `CLAUDE_CONFIG_DIR`, `~/.claude` and `~/.claude-*` is not searched. The caller retries later, so a miss costs nothing but another look.
 */
export function locateTranscript(
  record: SessionRecord,
  { home = homedir(), env = process.env }: LocateOptions = {},
): string | undefined {
  if (!SESSION_ID.test(record.session_id)) return undefined;
  return findClaude(record.session_id, home, env);
}
