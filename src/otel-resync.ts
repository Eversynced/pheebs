import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { claudePath, codexPath } from "./commands/path.js";
import { syncClaudeOtelEnv, syncCodexOtel } from "./otel.js";

/**
 * Re-apply the OTel gate to config files pheebs already wrote.
 *
 * Changing or clearing the endpoint only rewrites `~/.pheebs/config.json`, but the exporter
 * config lives in the *agent's* settings — so without this, `config unset base-url` leaves
 * Claude Code and Codex still exporting telemetry, with the token, to the old backend, while
 * `doctor` reports the install is local-only. The sync functions already strip their own keys
 * when the gate fails, so re-running them is all that is needed.
 *
 * Only files that already exist are touched: this must never create agent config for a tool
 * the developer never ran `pheebs init` for. Best-effort per tool — a malformed or unwritable
 * file is skipped rather than aborting the command the user actually asked for.
 */
export function resyncOtelConfigs(): void {
  syncClaudeFile();
  syncCodexFile();
}

function syncClaudeFile(): void {
  const { path } = claudePath(false, "user-level");
  if (!existsSync(path)) {
    return;
  }
  try {
    const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    syncClaudeOtelEnv(settings, true);
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {}
}

function syncCodexFile(): void {
  const { path } = codexPath(false, "user-level");
  if (!existsSync(path)) {
    return;
  }
  try {
    const config = parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    syncCodexOtel(config, true);
    writeFileSync(path, `${stringifyToml(config)}\n`);
  } catch {}
}
