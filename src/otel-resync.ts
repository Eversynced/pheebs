import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripBom } from "./bom.js";
import { resolveSettingsPath } from "./commands/path.js";
import { protectToken } from "./git-exclude.js";
import { AI_TOOLS } from "./hooks/definitions.js";
import { listInstalls } from "./installs.js";
import { legacyCodexPaths, stripLegacyCodexOtel } from "./legacy.js";
import { hasClaudeOtel, syncClaudeOtelEnv } from "./otel.js";
import { restrictToOwner } from "./pheebs-store.js";

/**
 * Re-apply the OTel gate to config files pheebs already wrote.
 *
 * Changing or clearing the endpoint only rewrites `~/.pheebs/config.json`, but the exporter
 * config lives in the *agent's* settings — so without this, `config unset base-url` leaves
 * Claude Code still exporting telemetry, with the token, to the old backend, while
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
  const targets = new Set<string>([
    resolveSettingsPath(false).path,
    resolveSettingsPath(true).path,
  ]);

  const legacyCodex = new Set(legacyCodexPaths());

  for (const { tool, path } of listInstalls()) {
    if (tool === AI_TOOLS.CLAUDE_CODE) targets.add(path);
    else if (tool === "codex") legacyCodex.add(path);
  }

  // Codex is no longer managed, so its exporter config cannot be refreshed, only stopped from
  // sending a token that has since changed.
  for (const path of legacyCodex) {
    try {
      stripLegacyCodexOtel(path);
    } catch {}
  }

  for (const path of targets) {
    const wrote = syncClaudeFile(path);

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
