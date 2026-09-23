#!/usr/bin/env node

import { AI_TOOLS, type AiTool } from "./hooks/definitions.js";
import { PHEEBS_VERSION } from "./version.js";

const args = process.argv.slice(2);

const HOOK_COMMANDS: Record<string, AiTool> = {
  hook: AI_TOOLS.CLAUDE_CODE,
  "hook-cursor": AI_TOOLS.CURSOR,
  "hook-codex": AI_TOOLS.CODEX,
};

function hasFlag(...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

const HELP = `pheebs <command> [options]

Commands:
  hook <event>          Handle a Claude Code hook (reads JSON from stdin)
  hook-cursor <event>   Handle a Cursor hook
  hook-codex <event>    Handle a Codex hook
  init                  Register hooks + OTel (interactive in a terminal)
  doctor                Verify hooks are registered
  config <cmd>          Get/set settings — endpoint, token, auto-update, classify
  insights              Report on your own work, from the backend
  scan                  Scan repo for AI-config artifacts
  update                Update pheebs to the latest npm release
  uninstall             Remove pheebs hooks + OTel

Options:
  -p, --project         Use project-local settings instead of user-level
  --cursor              Target Cursor
  --codex               Target Codex
  --no-otel             Skip OpenTelemetry configuration (init)
  --days <n>            Window for insights, 1 to 365 (default: the backend's)
  --json                Print the raw insights payload, unchanged
  -h, --help            Show this help
  -v, --version         Show version

Run \`pheebs init\` with no flags in a terminal for the interactive setup wizard.
Run \`pheebs config\` to manage the endpoint, token, and toggles.`;

function resolveTool(): AiTool {
  if (args.includes("--cursor")) return AI_TOOLS.CURSOR;
  if (args.includes("--codex")) return AI_TOOLS.CODEX;
  return AI_TOOLS.CLAUDE_CODE;
}

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(HELP);
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(PHEEBS_VERSION);
} else if (Object.hasOwn(HOOK_COMMANDS, args[0]) && args[1]) {
  const tool = HOOK_COMMANDS[args[0]];
  const { handleHookEvent } = await import("./hooks/handler.js");
  await handleHookEvent(tool, args[1], args.slice(2));
} else if (args[0] === "init") {
  const interactive =
    Boolean(process.stdin.isTTY) && !hasFlag("-p", "--project", "--cursor", "--codex", "--no-otel");

  if (interactive) {
    const { runInitInteractive } = await import("./commands/init.js");
    await runInitInteractive();
  } else {
    const project = hasFlag("-p", "--project");
    const otel = !hasFlag("--no-otel");
    const tool = resolveTool();
    const { runInit } = await import("./commands/init.js");
    await runInit({ project, tool, otel });
  }
} else if (args[0] === "doctor") {
  const project = hasFlag("-p", "--project");
  const hasToolFlag = hasFlag("--cursor", "--codex");
  const tool = hasToolFlag ? resolveTool() : undefined;
  const { runDoctor } = await import("./commands/doctor.js");
  await runDoctor({ project, tool });
} else if (args[0] === "config") {
  const { runConfig } = await import("./commands/config.js");
  await runConfig(args.slice(1));
} else if (args[0] === "insights") {
  const { runInsights } = await import("./commands/insights.js");
  await runInsights(args.slice(1));
} else if (args[0] === "scan") {
  const tool = resolveTool();
  const { runScanInteractive } = await import("./scanner.js");
  await runScanInteractive(tool);
} else if (args[0] === "update") {
  const { runUpdate } = await import("./commands/update.js");
  await runUpdate();
} else if (args[0] === "uninstall") {
  const { runUninstall } = await import("./commands/uninstall.js");
  await runUninstall();
} else {
  console.error(`Unknown command: ${args[0]}\n\n${HELP}`);
  process.exit(1);
}
