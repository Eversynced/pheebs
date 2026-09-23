// Local, derived classification of tool events into a coarse intent tag.
//
// PRIVACY: callers pass the raw command/tool name in here, but only the small
// derived ToolIntent string ever leaves this module. Raw command strings and
// file paths must never be persisted or sent remotely.

export type ToolIntent =
  | "test_run"
  | "build"
  | "typecheck"
  | "lint"
  | "vcs"
  | "read"
  | "edit"
  | "other";

// Sub-tag for `tool_intent=vcs`: which kind of VCS action ran. Separates writes
// that close work (commit/push/open a PR) from read-only git (status/log/diff),
// so a downstream test-gate metric doesn't count a `git status` after a test as a
// gate. `tool_intent` stays coarse; this rides alongside it only on `vcs`.
export type VcsAction = "commit" | "push" | "pr_create" | "other";

// Tool names that map directly to an intent without inspecting any input.
const TOOL_NAME_INTENTS: Record<string, ToolIntent> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
};

// Tool names whose intent depends on the shell command being run.
const SHELL_TOOL_NAMES = new Set(["Bash", "Shell", "shell"]);

// Ordered keyword table for shell commands: the first entry whose prefix matches
// the command's leading token(s) wins. Add new tools by extending a `prefixes`
// list here — this is the single place the mapping lives.
const COMMAND_KEYWORDS: ReadonlyArray<{ intent: ToolIntent; prefixes: string[] }> = [
  {
    intent: "test_run",
    prefixes: [
      "pytest",
      "jest",
      "vitest",
      "go test",
      "cargo test",
      "npm test",
      "npm run test",
      "yarn test",
      "yarn run test",
      "pnpm test",
      "pnpm run test",
      "make test",
      "make check",
      "rspec",
      "phpunit",
      "mocha",
    ],
  },
  {
    // Standalone type checkers. `tsc` and `cargo check` live here, not under
    // `build`: most are verification runs (checking types) rather than compiling
    // for output.
    intent: "typecheck",
    prefixes: ["mypy", "pyright", "tsc", "cargo check"],
  },
  {
    // `cargo clippy` (not a bare `clippy`, which is invoked through cargo). `ruff`
    // covers `ruff check`; `ruff format` also lands here, an accepted coarseness.
    intent: "lint",
    prefixes: ["eslint", "ruff", "flake8", "cargo clippy", "golangci-lint", "rubocop"],
  },
  {
    intent: "build",
    prefixes: [
      "make",
      "npm run build",
      "yarn build",
      "yarn run build",
      "pnpm build",
      "pnpm run build",
      "cargo build",
      "go build",
      "gradle",
      "mvn",
      "webpack",
    ],
  },
  {
    intent: "vcs",
    prefixes: ["git", "gh", "hg", "svn"],
  },
];

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const LEADING_TOKEN = /^\S+\s+/;
const SUDO_PREFIX = /^sudo\s+/;
const RUNNER_PREFIX = /^(?:npx|bunx|python3?\s+-m|uv\s+run|poetry\s+run)\s+/;

// Strip leading wrappers so the keyword match sees the actual command:
// env assignments, `sudo`, and a package/language runner (e.g. `CI=1 sudo npx
// jest` → `jest`, `uv run pytest` → `pytest`, `python -m pytest` → `pytest`).
function stripCommandPrefix(command: string): string {
  let rest = command.trim();
  while (ENV_ASSIGNMENT.test(rest)) {
    rest = rest.replace(LEADING_TOKEN, "");
  }
  if (SUDO_PREFIX.test(rest)) {
    rest = rest.replace(SUDO_PREFIX, "");
  }
  if (RUNNER_PREFIX.test(rest)) {
    rest = rest.replace(RUNNER_PREFIX, "");
  }
  return rest;
}

// Match `prefix` against `command` on token boundaries: the prefix must be
// followed by end-of-string or a non-alphanumeric char. So `git` matches
// `git status` and `npm run test` matches `npm run test:unit`, but `git` does
// not match `github-cli`.
function matchesPrefix(command: string, prefix: string): boolean {
  if (!command.startsWith(prefix)) return false;
  const next = command[prefix.length];
  return next === undefined || !/[A-Za-z0-9]/.test(next);
}

export function classifyShellCommand(command: string): ToolIntent {
  const normalized = stripCommandPrefix(command);
  for (const { intent, prefixes } of COMMAND_KEYWORDS) {
    if (prefixes.some((prefix) => matchesPrefix(normalized, prefix))) {
      return intent;
    }
  }
  return "other";
}

// Write actions ordered by precedence: in a chained command
// (`git add -A && git commit && git push`) the strongest wins. Read-only git
// matches none and stays `other`. Same token-boundary match as COMMAND_KEYWORDS.
const VCS_WRITE_ACTIONS: ReadonlyArray<{ action: VcsAction; prefixes: string[] }> = [
  { action: "pr_create", prefixes: ["gh pr create"] },
  { action: "push", prefixes: ["git push"] },
  { action: "commit", prefixes: ["git commit"] },
];

const VCS_ACTION_RANK: Record<VcsAction, number> = { other: 0, commit: 1, push: 2, pr_create: 3 };

// Shell operators that split a line into separate commands. classifyShellCommand
// looks at the leading token only; here the intent is already `vcs`, so we split
// to catch the write action in `git add -A && git commit`.
const COMMAND_SEPARATORS = /&&|\|\||;|\||\n/;

// Reads the command in-process only; callers persist just the derived tag,
// never the command itself.
export function classifyVcsAction(command: string): VcsAction {
  let best: VcsAction = "other";
  for (const segment of command.split(COMMAND_SEPARATORS)) {
    const normalized = stripCommandPrefix(segment);
    for (const { action, prefixes } of VCS_WRITE_ACTIONS) {
      if (
        VCS_ACTION_RANK[action] > VCS_ACTION_RANK[best] &&
        prefixes.some((prefix) => matchesPrefix(normalized, prefix))
      ) {
        best = action;
      }
    }
  }
  return best;
}

export function classifyIntent(toolName: string | undefined, command?: string): ToolIntent {
  if (toolName && SHELL_TOOL_NAMES.has(toolName)) {
    return typeof command === "string" ? classifyShellCommand(command) : "other";
  }
  if (toolName && toolName in TOOL_NAME_INTENTS) {
    return TOOL_NAME_INTENTS[toolName];
  }
  return "other";
}
