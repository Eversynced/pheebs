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
// gate. `tool_intent` stays coarse; this rides alongside it on `vcs`, and on any
// other intent when a write action ran in the chain, since a check in the same
// chain wins `tool_intent` and would otherwise hide the commit or push.
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
// Claude Code on Windows runs commands through `PowerShell` rather than `Bash`.
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell", "Shell", "shell"]);

// Ordered keyword table for shell commands: the first entry whose prefix matches
// a segment's leading token(s) wins. Add new tools by extending a `prefixes`
// list here, this is the single place the mapping lives.
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
      "bun test",
      "bun run test",
      "swift test",
      "dotnet test",
      // Only the action-first form: `xcodebuild -scheme App test` puts flags
      // before the action and stays `build`, an accepted coarseness.
      "xcodebuild test",
    ],
  },
  {
    // Standalone type checkers. `tsc` and `cargo check` live here, not under
    // `build`: most are verification runs (checking types) rather than compiling
    // for output.
    intent: "typecheck",
    prefixes: [
      "mypy",
      "pyright",
      "tsc",
      "cargo check",
      "npm run typecheck",
      "pnpm typecheck",
      "pnpm run typecheck",
      "yarn typecheck",
      "yarn run typecheck",
      "bun run typecheck",
      "terraform validate",
    ],
  },
  {
    // `cargo clippy` (not a bare `clippy`, which is invoked through cargo). `ruff`
    // covers `ruff check`; `ruff format` also lands here, an accepted coarseness.
    intent: "lint",
    prefixes: [
      "eslint",
      "ruff",
      "flake8",
      "cargo clippy",
      "golangci-lint",
      "rubocop",
      "biome",
      "npm run lint",
      "pnpm lint",
      "pnpm run lint",
      "yarn lint",
      "yarn run lint",
      "bun run lint",
      "tflint",
    ],
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
      "swift build",
      "xcodebuild",
      "dotnet build",
    ],
  },
  {
    intent: "vcs",
    prefixes: ["git", "gh", "hg", "svn"],
  },
];

// Shell operators that split a line into separate commands. Agents chain a
// `cd` or an inline edit before the real command, so the leading token alone
// misses most checks. Also used to catch the write action in `git add -A && git commit`.
// A lone `&` backgrounds a job; the `&` in `2>&1`, `>&2`, `&>` and `&&` is not one.
const COMMAND_SEPARATORS = /&&|\|\||;|\||\n|(?<![<>&])&(?![>&])/;

// A heredoc opener: `<<WORD`, `<<'WORD'`, `<<"WORD"` or `<<-WORD`. Sticky, so it matches only at `lastIndex`.
const HEREDOC_OPENER = /<<-?[ \t]*(['"]?)(\w+)\1/y;

// Quoted text, comments and heredoc bodies are data the command carries, not
// commands it runs, so a `;` in a commit message or an inline script must not
// split it. Quotes and heredocs become empty quoted placeholders to keep token
// boundaries; comments are dropped; an escaped character becomes `_` (a
// backslash-newline a space) so `\'` opens no quote and `\;` splits nothing.
// One left-to-right pass: a regex per construct backtracks quadratically on
// unterminated input, and this runs inside a hook. An unterminated quote or
// heredoc masks to the end, since the rest is data either way.
function maskQuotedText(command: string): string {
  let masked = "";
  let i = 0;
  // Heredoc bodies start on the line after the opener, so the rest of the
  // opening line is scanned like any other command text.
  const pendingHeredocs: string[] = [];
  while (i < command.length) {
    const char = command[i];
    if (char === "\\") {
      masked += command[i + 1] === "\n" ? " " : "_";
      i += 2;
    } else if (char === '"') {
      i++;
      while (i < command.length && command[i] !== '"') i += command[i] === "\\" ? 2 : 1;
      masked += '""';
      i++;
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      masked += "''";
      i = close === -1 ? command.length : close + 1;
    } else if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      const lineEnd = command.indexOf("\n", i);
      i = lineEnd === -1 ? command.length : lineEnd;
    } else if (command.startsWith("<<<", i)) {
      masked += "<<<";
      i += 3;
    } else if (char === "<" && command[i + 1] === "<") {
      HEREDOC_OPENER.lastIndex = i;
      const opener = HEREDOC_OPENER.exec(command);
      if (!opener) {
        masked += "<<";
        i += 2;
        continue;
      }
      pendingHeredocs.push(opener[2]);
      masked += '<<""';
      i = HEREDOC_OPENER.lastIndex;
    } else if (char === "\n" && pendingHeredocs.length > 0) {
      masked += "\n";
      i++;
      for (const word of pendingHeredocs.splice(0)) i = heredocEnd(command, i, word);
    } else {
      masked += char;
      i++;
    }
  }
  return masked;
}

// Index just past the line that is exactly `word` (leading tabs allowed), or
// the end of input when the heredoc never closes.
function heredocEnd(command: string, bodyStart: number, word: string): number {
  let lineStart = bodyStart;
  while (lineStart <= command.length) {
    const newline = command.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? command.length : newline;
    if (command.slice(lineStart, lineEnd).replace(/^\t+/, "") === word) return lineEnd;
    lineStart = lineEnd + 1;
  }
  return command.length;
}

const CHECK_INTENTS: ReadonlySet<ToolIntent> = new Set(["test_run", "typecheck", "lint", "build"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const LEADING_TOKEN = /^\S+\s+/;
// Shell syntax that opens a command without being part of its name: a subshell
// or group, negation, `time`, and the keywords that introduce a command in an
// `if`, `while` or `for` body.
const LEADING_SYNTAX = /^(?:\(+\s*|[{!]\s+|(?:if|then|else|elif|do|while|until|time)(?:\s+|$))/;
const SUDO_PREFIX = /^sudo\s+/;
const RUNNER_PREFIX = /^(?:npx|bunx|uvx|python3?\s+-m|uv\s+run|poetry\s+run)\s+/;

// Strip leading wrappers so the keyword match sees the actual command:
// shell syntax, env assignments, `sudo`, and a package/language runner (e.g. `CI=1 sudo npx
// jest` → `jest`, `uv run pytest` → `pytest`, `python -m pytest` → `pytest`).
function stripCommandPrefix(command: string): string {
  let rest = command.trim();
  while (LEADING_SYNTAX.test(rest)) {
    rest = rest.replace(LEADING_SYNTAX, "");
  }
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

function classifySegment(segment: string): ToolIntent {
  const normalized = stripCommandPrefix(segment);
  for (const { intent, prefixes } of COMMAND_KEYWORDS) {
    if (prefixes.some((prefix) => matchesPrefix(normalized, prefix))) {
      return intent;
    }
  }
  return "other";
}

// A check anywhere in the chain wins, because verification is what callers
// count; otherwise the first recognized segment, so `cd x && git commit` stays vcs.
export function classifyShellCommand(command: string): ToolIntent {
  let firstRecognized: ToolIntent = "other";
  for (const segment of maskQuotedText(command).split(COMMAND_SEPARATORS)) {
    const intent = classifySegment(segment);
    if (CHECK_INTENTS.has(intent)) return intent;
    if (firstRecognized === "other") firstRecognized = intent;
  }
  return firstRecognized;
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

// Reads the command in-process only; callers persist just the derived tag,
// never the command itself.
export function classifyVcsAction(command: string): VcsAction {
  let best: VcsAction = "other";
  for (const segment of maskQuotedText(command).split(COMMAND_SEPARATORS)) {
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
