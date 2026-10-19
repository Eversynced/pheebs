import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");

// Windows spells it `Path`; drop every spelling so the child sees only the one set here.
export function withPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = path;
  return env;
}

// Run a hook, feeding the payload on stdin and writing logs to a throwaway dir. The home is
// throwaway too: a hook reads ~/.pheebs, and a session start writes there and can launch
// the developer's own auto-update. Pass `home` to keep one across runs and inspect it after.
export function runHookRows(
  args: string[],
  payload: unknown,
  input: string | Buffer = JSON.stringify(payload),
  {
    path,
    extraEnv,
    setupHome,
    home: keptHome,
  }: {
    path?: string;
    extraEnv?: NodeJS.ProcessEnv;
    setupHome?: (home: string) => void;
    home?: string;
  } = {},
): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "pheebs-test-"));
  const home = keptHome ?? mkdtempSync(join(tmpdir(), "pheebs-home-"));
  setupHome?.(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PHEEBS_LOG_PATH: dir,
    PHEEBS_CODEBASE_ID: "test/hooks",
    PHEEBS_DEBUG: "1", // route the remote transport to the no-network debug sink
    ...extraEnv,
  };
  if (path !== undefined) withPath(env, path);
  try {
    execFileSync(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(dir, f), "utf-8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (!keptHome) rmSync(home, { recursive: true, force: true });
  }
}
