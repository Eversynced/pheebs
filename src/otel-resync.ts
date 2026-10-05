import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { stripBom } from "./bom.js";
import { resolveSettingsPath } from "./commands/path.js";
import { protectToken } from "./git-exclude.js";
import { AI_TOOLS, type AiTool } from "./hooks/definitions.js";
import { listInstalls } from "./installs.js";
import { hasClaudeOtel, hasCodexOtel, syncClaudeOtelEnv, syncCodexOtel } from "./otel.js";
import { restrictToOwner } from "./pheebs-store.js";

/**
 * Re-apply the OTel gate to config files pheebs already wrote.
 *
 * Changing or clearing the endpoint only rewrites `~/.pheebs/config.json`, but the exporter
 * config lives in the *agent's* settings — so without this, `config unset base-url` leaves
 * Claude Code and Codex still exporting telemetry, with the token, to the old backend, while
 * `doctor` reports the install is local-only.
 *
 * Every scope, not just the current directory: project-local is the default, so most of the
 * stale exporter config lives in repos the command was not run from. The registry is the only
 * record of where those are; the user-level and current-directory paths are derived on top of
 * it, so an install that predates the registry is still reached.
 *
 * Only files that already carry pheebs OTel config are touched. `enabled` here is the config
 * gate, not the developer's choice: an install made with `--no-otel` never asked to export,
 * and turning it on behind their back would put the Bearer token in a repo they kept it out of.
 *
 * Best-effort per file — a malformed or unwritable one is skipped rather than aborting the
 * command the user actually asked for.
 */
export function resyncOtelConfigs(): void {
  const targets = new Map<string, AiTool>();

  for (const tool of [AI_TOOLS.CLAUDE_CODE, AI_TOOLS.CODEX]) {
    targets.set(resolveSettingsPath(tool, false).path, tool);
    targets.set(resolveSettingsPath(tool, true).path, tool);
  }

  for (const { tool, path } of listInstalls()) {
    // Cursor has no OTel support, so nothing pheebs wrote there carries the token.
    if (tool === AI_TOOLS.CLAUDE_CODE || tool === AI_TOOLS.CODEX) {
      targets.set(path, tool);
    }
  }

  for (const [path, tool] of targets) {
    const wrote = tool === AI_TOOLS.CODEX ? syncCodexFile(path) : syncClaudeFile(path);

    // A refreshed endpoint means a freshly written token, in a file that may now sit in a
    // repo the developer has since started tracking.
    if (wrote) {
      restrictToOwner(path);
      protectToken(path, (message) => console.warn(`pheebs: ${message}`));
    }
  }
}

function syncClaudeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const settings = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as Record<string, unknown>;
    if (!hasClaudeOtel(settings)) return false;

    const wrote = syncClaudeOtelEnv(settings, true);
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    return wrote;
  } catch {
    return false;
  }
}

function syncCodexFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const config = parseToml(stripBom(readFileSync(path, "utf-8"))) as Record<string, unknown>;
    if (!hasCodexOtel(config)) return false;

    const wrote = syncCodexOtel(config, true);
    writeFileSync(path, `${stringifyToml(config)}\n`);
    return wrote;
  } catch {
    return false;
  }
}
