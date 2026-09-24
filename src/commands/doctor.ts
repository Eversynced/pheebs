import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { intro, log, note, outro } from "@clack/prompts";
import { parse as parseToml } from "smol-toml";
import { baseUrl, hasBackend } from "../backend-config.js";
import { resolveLogPath } from "../config.js";
import {
  AI_TOOLS,
  type AiTool,
  CODEX_TRUST_WARNING,
  getHookDefinitionsForTool,
  isPheebsEntry,
  TOOL_LABELS,
} from "../hooks/definitions.js";
import { readStoredToken } from "../token.js";
import { TRANSPORT_ERROR_PATH } from "../transports/http.js";
import { PHEEBS_VERSION } from "../version.js";
import { detectInstalledTools } from "./detect.js";
import { resolveSettingsPath } from "./path.js";
import { getLatestVersion, isNewer } from "./update.js";

type DoctorResult = {
  settingsPath: string;
  definitionCount: number;
  hookTypeCount: number;
  registeredTypes: number;
  issues: string[];
  fatal?: string;
};

/** Returns true if pheebs is reachable on PATH; emits guidance and returns false otherwise. */
function checkPathReachable(): boolean {
  let inPath = false;
  try {
    execSync("which pheebs", { stdio: "pipe" });
    inPath = true;
  } catch {}

  if (inPath) return true;

  let binDir = "";
  try {
    const prefix = execSync("npm config get prefix", { stdio: "pipe", encoding: "utf-8" }).trim();
    if (prefix) binDir = join(prefix, "bin");
  } catch {}

  const guidance = binDir
    ? `Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):\n  export PATH="${binDir}:$PATH"`
    : "Run `npm config get prefix` to find your npm prefix,\nthen add <prefix>/bin to your PATH in your shell profile.";
  note(guidance, "pheebs is not in your PATH — hooks will fail silently");
  return false;
}

function initFlag(tool: AiTool): string {
  if (tool === AI_TOOLS.CURSOR) return "`pheebs init --cursor`";
  if (tool === AI_TOOLS.CODEX) return "`pheebs init --codex`";
  return "`pheebs init`";
}

export function doctorCodex(settingsPath: string): DoctorResult {
  const definitions = getHookDefinitionsForTool(AI_TOOLS.CODEX);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];
  const base = {
    settingsPath,
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    registeredTypes: 0,
  };

  if (!existsSync(settingsPath)) {
    return { ...base, issues: [], fatal: `${settingsPath} not found` };
  }

  let config: Record<string, unknown>;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    config = parseToml(raw) as Record<string, unknown>;
  } catch {
    return { ...base, issues: [], fatal: `${settingsPath} is malformed` };
  }

  const hooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
  const issues: string[] = [];
  let registeredTypes = 0;

  for (const key of hookKeys) {
    const entry = hooks[key];
    if (entry === undefined) {
      issues.push(`${key}: missing entirely`);
      continue;
    }

    const candidates = Array.isArray(entry) ? entry : [entry];
    if (candidates.some(isPheebsEntry)) {
      registeredTypes++;
    } else {
      issues.push(`${key}: no pheebs entries found`);
    }
  }

  return { ...base, registeredTypes, issues };
}

export function doctorJsonConfig(settingsPath: string, tool: AiTool): DoctorResult {
  const definitions = getHookDefinitionsForTool(tool);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];
  const expectedCounts = new Map<string, number>();
  for (const def of definitions) {
    expectedCounts.set(def.hookKey, (expectedCounts.get(def.hookKey) ?? 0) + 1);
  }
  const base = {
    settingsPath,
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    registeredTypes: 0,
  };

  if (!existsSync(settingsPath)) {
    return { ...base, issues: [], fatal: `${settingsPath} not found` };
  }

  let config: Record<string, unknown>;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    return { ...base, issues: [], fatal: `${settingsPath} is malformed` };
  }

  const hooks = (config.hooks as Record<string, unknown[] | undefined>) ?? {};
  const issues: string[] = [];
  let registeredTypes = 0;

  for (const key of hookKeys) {
    const entries = hooks[key];
    if (!Array.isArray(entries)) {
      issues.push(`${key}: missing entirely`);
      continue;
    }

    const pheebsCount = entries.filter(isPheebsEntry).length;
    const expected = expectedCounts.get(key) ?? 0;

    if (pheebsCount === 0) {
      issues.push(`${key}: no pheebs entries found`);
    } else {
      registeredTypes++;
      if (pheebsCount < expected) {
        issues.push(`${key}: found ${pheebsCount}/${expected} pheebs entries`);
      }
    }
  }

  return { ...base, registeredTypes, issues };
}

function getLastEvent(
  logDir: string,
  files: string[],
): { file: string; event: string; timestamp: string } | null {
  if (files.length === 0) return null;

  const latest = files[files.length - 1];
  try {
    const tail = execFileSync("tail", ["-1", join(logDir, latest)], { encoding: "utf-8" }).trim();
    if (!tail) return null;
    const last = JSON.parse(tail) as Record<string, unknown>;
    return {
      file: latest,
      event: (last.event as string) ?? "unknown",
      timestamp: (last.timestamp as string) ?? "unknown",
    };
  } catch {
    return null;
  }
}

function reportToolResult(result: DoctorResult, tool: AiTool): boolean {
  if (result.fatal) {
    log.error(`${TOOL_LABELS[tool]}: ${result.fatal}`);
    log.info(`  Run ${initFlag(tool)} to fix.`);
    return false;
  }

  if (result.issues.length > 0) {
    log.warn(
      `${TOOL_LABELS[tool]}: ${result.registeredTypes}/${result.hookTypeCount} hook types registered — ${result.issues.length} issue(s) in ${result.settingsPath}`,
    );
    for (const issue of result.issues) {
      log.warn(`  ${issue}`);
    }
    log.info(`  Run ${initFlag(tool)} to fix.`);
    return false;
  }

  log.success(
    `${TOOL_LABELS[tool]}: ${result.registeredTypes}/${result.hookTypeCount} hook types registered ← ${result.settingsPath}`,
  );
  return true;
}

function diagnoseTools(tools: AiTool[], project: boolean): boolean {
  let allHealthy = true;

  for (const tool of tools) {
    const { path: settingsPath } = resolveSettingsPath(tool, project);
    const result =
      tool === AI_TOOLS.CODEX ? doctorCodex(settingsPath) : doctorJsonConfig(settingsPath, tool);
    if (!reportToolResult(result, tool)) {
      allHealthy = false;
    }
    // Registered is not the same as will fire: a project-local Codex layer is dropped entirely
    // until the developer trusts the project, so a clean report here would overstate the install.
    if (project && tool === AI_TOOLS.CODEX && !result.fatal) {
      log.warn(`  ${CODEX_TRUST_WARNING}`);
    }
  }

  return allHealthy;
}

function checkGhAuth(): void {
  try {
    execSync("gh auth status", { stdio: "pipe" });
    log.success("gh authenticated");
  } catch {
    log.warn("gh not authenticated — developer identity will fall back to hashed git email");
    log.info("  Run `gh auth login` to fix.");
  }
}

/** Reports the backend endpoint + token status. Returns false only on a hard problem (a
 *  rejected token), which fails the overall check; a missing token is a warning, not a failure. */
function checkBackend(): boolean {
  if (!hasBackend()) {
    log.info(
      "Backend endpoint: not set — pheebs is local-only; events are written to ~/.pheebs/logs/ and nothing is sent",
    );
  } else {
    log.info(`Backend endpoint: ${baseUrl()} (config)`);
  }

  const stored = readStoredToken();
  if (stored?.developer || stored?.id) {
    log.success(`Pheebs token: ${stored.developer ?? stored.id}`);
  } else if (stored) {
    log.warn(
      hasBackend()
        ? "Pheebs token: stored but unvalidated — re-run `pheebs config set token <token>` online"
        : "Pheebs token: stored but unvalidated — set an endpoint with `pheebs config set base-url <url>`",
    );
  } else if (hasBackend()) {
    log.warn("No Pheebs token set — telemetry is not sent. Run `pheebs config set token <token>`.");
  }

  if (existsSync(TRANSPORT_ERROR_PATH)) {
    log.error("Your token was rejected by the backend — re-run `pheebs config set token <token>`.");
    return false;
  }
  return true;
}

function reportStatus(): void {
  const logDir = resolveLogPath();
  const lines: string[] = [`Log directory: ${logDir}`];

  if (!existsSync(logDir)) {
    lines.push("No logs yet — no events have been captured.");
  } else {
    let files: string[] = [];
    try {
      files = readdirSync(logDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {}
    lines.push(`Log files: ${files.length}`);

    const last = getLastEvent(logDir, files);
    if (last) {
      lines.push(`Last event: ${last.event} at ${last.timestamp} (${last.file})`);
    } else {
      lines.push("Last event: none");
    }
  }

  note(lines.join("\n"), "Status");
}

/** Reports a newer published version. Advisory only — never fails the check, and stays quiet
 *  when the registry is unreachable, since being offline is not a problem with the install. */
function checkVersion(): void {
  const latest = getLatestVersion();
  if (latest && isNewer(latest, PHEEBS_VERSION)) {
    log.warn(
      `A newer pheebs is available: v${latest} (you have v${PHEEBS_VERSION}). Run \`pheebs update\`.`,
    );
  }
}

export async function runDoctor(options?: { project?: boolean; tool?: AiTool }): Promise<void> {
  const project = options?.project ?? true;
  const tool = options?.tool;
  const explicit = tool !== undefined;
  const tools: AiTool[] = tool !== undefined ? [tool] : detectInstalledTools();

  if (tools.length === 0) {
    intro("pheebs doctor");
    log.warn("No tools detected (Claude Code, Cursor, or Codex).");
    outro("✗ nothing to check");
    process.exit(1);
  }

  const heading = explicit
    ? `pheebs doctor — ${TOOL_LABELS[tools[0]]}`
    : `pheebs doctor — ${tools.map((t) => TOOL_LABELS[t]).join(", ")}`;

  intro(heading);

  const allHealthy = diagnoseTools(tools, project);

  checkGhAuth();
  const backendOk = checkBackend();
  checkVersion();
  reportStatus();

  if (!checkPathReachable()) {
    outro("✗ PATH not configured");
    process.exit(1);
  }

  if (!allHealthy || !backendOk) {
    outro("✗ problems found");
    process.exit(1);
  }

  outro("✓ healthy");
}
