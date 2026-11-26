#!/usr/bin/env node

import { AI_TOOLS } from "./hooks/definitions.js";
import { PHEEBS_VERSION } from "./version.js";

const args = process.argv.slice(2);

// Existing Cursor and Codex hook entries still call these. They must exit 0 without reading
// stdin, writing, or sending, so that agent is never slowed or broken before `pheebs uninstall`
// clears the entries.
const REMOVED_HOOK_COMMANDS = ["hook-cursor", "hook-codex"];
const REMOVED_TOOL_FLAGS = ["--cursor", "--codex"];

function hasFlag(...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

function helpText(manager: boolean): string {
  return `pheebs <command> [options]

Commands:
  hook <event>          Handle a Claude Code hook (reads JSON from stdin)
  init                  Register hooks + OTel (interactive in a terminal)
  doctor                Verify hooks are registered (both scopes unless one is named)
  config <cmd>          Get/set settings — endpoint, token, auto-update, classify
  insights              Report on your own work, from the backend or else the local log
  scan                  Scan repo for AI-config artifacts
  flush                 Send queued events to the backend now
  update                Update pheebs to the latest npm release
  uninstall             Remove pheebs hooks + OTel

Options:
  -p, --project         Project-local scope: init writes it (default), doctor checks only it
  -g, --global          User-level scope: applies to every repo
  --no-otel             Skip OpenTelemetry configuration (init)
  --days <n>            Window for insights, 1 to 365 (default: the backend's)
  --local               Report from the local log, even with a backend set
  --json                Print the raw insights payload, unchanged${
    manager ? "\n  --team                Report on the team instead (manager tokens only)" : ""
  }
  -h, --help            Show this help
  -v, --version         Show version

Run \`pheebs init\` with no flags in a terminal for the interactive setup wizard.
Run \`pheebs config\` to manage the endpoint, token, and toggles.`;
}

// Mentioning `--team` is a courtesy to the people it is for: the cached role only decides what
// help says, and the backend decides who is answered.
async function help(): Promise<string> {
  const { isCachedManager } = await import("./token.js");
  return helpText(isCachedManager());
}

const TOOL_FLAG_COMMANDS = ["init", "doctor", "scan"];

if (REMOVED_HOOK_COMMANDS.includes(args[0])) {
  process.exit(0);
} else if (TOOL_FLAG_COMMANDS.includes(args[0]) && hasFlag(...REMOVED_TOOL_FLAGS)) {
  console.error(
    "pheebs supports Claude Code only; `pheebs uninstall` clears old Cursor and Codex hooks, and the Claude Code ones too.",
  );
  process.exit(1);
} else if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(await help());
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(PHEEBS_VERSION);
} else if (args[0] === "hook" && args[1]) {
  const { handleHookEvent } = await import("./hooks/handler.js");
  await handleHookEvent(AI_TOOLS.CLAUDE_CODE, args[1], args.slice(2));
  // A classify request that timed out has already been answered for, but its pending connect
  // would hold the event loop, and so the agent, open.
  // Output written to a pipe is asynchronous on macOS, so it is flushed before the exit.
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(process.exitCode ?? 0);
} else if (args[0] === "init") {
  const interactive =
    Boolean(process.stdin.isTTY) && !hasFlag("-p", "--project", "-g", "--global", "--no-otel");

  if (interactive) {
    const { runInitInteractive } = await import("./commands/init.js");
    await runInitInteractive();
  } else {
    const project = !hasFlag("-g", "--global");
    const otel = !hasFlag("--no-otel");
    const { runInit } = await import("./commands/init.js");
    await runInit({ project, otel });
  }
} else if (args[0] === "doctor") {
  // Unflagged, doctor looks at both scopes: either one is a real install, and only the check
  // itself can tell which the developer has.
  const scope = hasFlag("-g", "--global")
    ? "user"
    : hasFlag("-p", "--project")
      ? "project"
      : "both";
  const { runDoctor } = await import("./commands/doctor.js");
  await runDoctor({ scope });
} else if (args[0] === "config") {
  const { runConfig } = await import("./commands/config.js");
  await runConfig(args.slice(1));
} else if (args[0] === "insights") {
  const { runInsights } = await import("./commands/insights.js");
  await runInsights(args.slice(1));
} else if (args[0] === "scan") {
  const { runScanInteractive } = await import("./scanner.js");
  await runScanInteractive(AI_TOOLS.CLAUDE_CODE);
} else if (args[0] === "flush") {
  const { runFlush } = await import("./flusher.js");
  const linger = args.includes("--linger");
  const outcome = await runFlush({ linger });
  if (!linger) console.log(`pheebs: ${outcome}`);
} else if (args[0] === "update") {
  const { runUpdate } = await import("./commands/update.js");
  await runUpdate();
} else if (args[0] === "uninstall") {
  const { runUninstall } = await import("./commands/uninstall.js");
  await runUninstall();
} else {
  console.error(`Unknown command: ${args[0]}\n\n${await help()}`);
  process.exit(1);
}
