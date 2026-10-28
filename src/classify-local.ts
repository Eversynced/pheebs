import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  CODEBOOK,
  CODEBOOK_VERSION,
  INTENT_SCHEMA,
  LABELS,
  MODEL,
  TASK_SCOPES,
} from "./codebook.js";
import { RECURSION_GUARD_ENV } from "./hooks/types.js";
import { PHEEBS_OTEL_KEYS } from "./otel.js";
import type { ClassifyResult } from "./transport.js";

const LOCAL_CLASSIFY_TIMEOUT_MS = 8000;

export const LOCAL_CLASSIFIER_VERSION = `claude-code:${MODEL}@${CODEBOOK_VERSION}`;

// `--bare` would skip hooks too, but it refuses the subscription login this path exists to use,
// so hooks, settings, MCP servers, and skills are each switched off by name instead.
const ARGS = [
  "-p",
  "--model",
  MODEL,
  "--effort",
  "low",
  "--system-prompt",
  CODEBOOK,
  "--json-schema",
  JSON.stringify(INTENT_SCHEMA),
  "--output-format",
  "json",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
  "--strict-mcp-config",
  "--no-session-persistence",
  "--disable-slash-commands",
];

// The hook inherits the session's settings env, telemetry switch included. A child that kept it
// would export its own token usage under the developer's identity and inflate every cost figure.
//
// An env API key goes too: headless `claude -p` uses one without the approval an interactive
// session asks for, so a key the developer declined would receive the prompt. Without it the
// child uses the login stored on the machine.
const STRIPPED_KEYS = new Set([...PHEEBS_OTEL_KEYS, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OTEL_") || STRIPPED_KEYS.has(key)) continue;
    env[key] = value;
  }
  env[RECURSION_GUARD_ENV] = "1";
  return env;
}

// Checked against the enums, unlike a backend label, which is copied through: this client owns
// the codebook, so a value outside it is a failed run here, not a table the client does not know.
function parse(stdout: string): ClassifyResult | undefined {
  try {
    const parsed = JSON.parse(stdout);
    // A `verbose` the child still reads from the legacy global config turns the output into the
    // whole message list, with the result as its last entry.
    const result = Array.isArray(parsed)
      ? parsed.filter((message) => message?.type === "result").at(-1)
      : parsed;
    const out = result?.structured_output;
    if (!LABELS.includes(out?.label)) return undefined;
    return {
      label: out.label,
      ...(typeof out.requests_verification === "boolean"
        ? { requests_verification: out.requests_verification }
        : {}),
      ...(TASK_SCOPES.includes(out.task_scope) ? { task_scope: out.task_scope } : {}),
      classifier_version: LOCAL_CLASSIFIER_VERSION,
    };
  } catch {
    return undefined;
  }
}

interface ClaudeRun {
  code: number | null;
  stdout: string;
}

// Resolves undefined on a spawn error or the deadline, and never rejects.
function runClaude(
  args: string[],
  { input = "", cwd, env }: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeRun | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    try {
      const child = spawn("claude", args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      // Not spawn's `timeout`: that sends SIGTERM and then waits for `close`, which a child
      // ignoring the signal never sends. Destroying stdout lets the hook exit even while a
      // grandchild still holds the pipe.
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        resolve(undefined);
      }, LOCAL_CLASSIFY_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", () => {
        clearTimeout(deadline);
        resolve(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        resolve({ code, stdout });
      });
      // A child that dies before reading stdin raises EPIPE here, which must not crash the hook.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } catch {
      resolve(undefined);
    }
  });
}

export async function classifyLocally(prompt: string): Promise<ClassifyResult | undefined> {
  // Run outside the repo so the child picks up no project CLAUDE.md, which would change what the
  // codebook is classifying against.
  const run = await runClaude(ARGS, { input: prompt, cwd: tmpdir(), env: childEnv() });
  return run?.code === 0 ? parse(run.stdout) : undefined;
}

// Only whether `claude` starts here. A provider whose model ids differ still fails per prompt.
export async function canRunClaude(): Promise<boolean> {
  return (await runClaude(["--version"]))?.code === 0;
}
