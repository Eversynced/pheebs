import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import {
  baseUrl,
  ensureConfig,
  hasBackend,
  isHttpUrl,
  readConfig,
  writeConfig,
} from "../backend-config.js";
import { stripBom } from "../bom.js";
import { getDeveloperHandle } from "../developer-id.js";
import { protectToken } from "../git-exclude.js";
import {
  AI_TOOLS,
  buildHooksConfig,
  getHookDefinitionsForTool,
  isPheebsEntry,
  TOOL_LABELS,
} from "../hooks/definitions.js";
import { recordInstall } from "../installs.js";
import { syncClaudeOtelEnv } from "../otel.js";
import { restrictToOwner } from "../pheebs-store.js";
import { setToken } from "../token.js";
import { resolveSettingsPath } from "./path.js";

type InitResult = {
  definitionCount: number;
  hookTypeCount: number;
  settingsPath: string;
  level: string;
  otel?: "wrote" | "removed";
};

function applyInitTo(settingsPath: string, level: string, otelEnabled: boolean): InitResult {
  const definitions = getHookDefinitionsForTool(AI_TOOLS.CLAUDE_CODE);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];

  mkdirSync(dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = stripBom(readFileSync(settingsPath, "utf-8"));
      settings = JSON.parse(raw);
    } catch {
      console.warn(`pheebs: existing ${settingsPath} is malformed, starting fresh`);
      settings = {};
    }
  }

  const existingHooks = (settings.hooks as Record<string, unknown[] | undefined>) ?? {};
  const pheebsHooks = buildHooksConfig();

  for (const key of hookKeys) {
    const existing = Array.isArray(existingHooks[key]) ? (existingHooks[key] as unknown[]) : [];
    const nonPheebs = existing.filter((entry) => !isPheebsEntry(entry));
    existingHooks[key] = [...nonPheebs, ...pheebsHooks[key]];
  }

  settings.hooks = existingHooks;

  const developerHandle = getDeveloperHandle();
  const otelWritten = syncClaudeOtelEnv(settings, otelEnabled, developerHandle);

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (otelWritten) restrictToOwner(settingsPath);

  return {
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    settingsPath,
    level,
    otel: otelWritten ? "wrote" : "removed",
  };
}

export function applyInit(project: boolean, otelEnabled: boolean): InitResult {
  const { path: settingsPath, level } = resolveSettingsPath(project);
  return applyInitTo(settingsPath, level, otelEnabled);
}

/** Why an OTel setup the developer asked for still wrote nothing. Both gates matter: the
 *  endpoint is where the export goes, the token is what authenticates it. */
function otelInactiveReason(): string {
  const missing = !hasBackend() ? "no backend endpoint is set" : "no token is set";
  return `OTel is enabled but ${missing}, so it stays inactive until that is configured.`;
}

/** A user-level install keeps firing alongside a project-local one, doubling every event, so
 *  both init paths have to spot it before writing a second copy. */
export function hasUserLevelInstall(): boolean {
  const { path: userPath } = resolveSettingsPath(false);
  if (!existsSync(userPath)) return false;

  let config: Record<string, unknown>;
  try {
    const raw = stripBom(readFileSync(userPath, "utf-8"));
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;

  return Object.values(hooks).some((entries) =>
    (Array.isArray(entries) ? entries : [entries]).some(isPheebsEntry),
  );
}

export async function runInit(options?: { project?: boolean; otel?: boolean }): Promise<void> {
  const otelEnabled = options?.otel ?? true;

  // Materialize config.json so settings are visible and hand-editable after a non-interactive init.
  ensureConfig();

  const project = options?.project ?? true;

  if (project && hasUserLevelInstall()) {
    const { path: userPath } = resolveSettingsPath(false);
    console.warn(
      `pheebs: hooks are also registered user-level in ${userPath}, so every event fires twice. Run \`pheebs uninstall\` (it clears every scope) and then init again.`,
    );
  }

  const result = applyInit(project, otelEnabled);
  recordInstall(AI_TOOLS.CLAUDE_CODE, result.settingsPath);

  console.log(
    `pheebs: wrote ${result.definitionCount} hook entries across ${result.hookTypeCount} hook types to ${result.settingsPath} (${result.level})`,
  );
  if (result.otel !== undefined) {
    console.log(`pheebs: ${result.otel} OTel config in ${result.settingsPath}`);
  }
  if (otelEnabled && result.otel === "removed") {
    console.warn(`pheebs: ${otelInactiveReason()}`);
  }

  if (result.otel === "wrote") {
    protectToken(result.settingsPath, (message) => console.warn(`pheebs: ${message}`));
  }

  const { runArtifactScan } = await import("../scanner.js");
  runArtifactScan(AI_TOOLS.CLAUDE_CODE);
}

export async function runInitInteractive(): Promise<void> {
  intro("pheebs init");

  const scope = await select<boolean>({
    message: "Where should hooks be registered?",
    options: [
      { value: true, label: "Project-local", hint: "this repo only" },
      { value: false, label: "User-level", hint: "applies everywhere" },
    ],
    initialValue: true,
  });
  if (isCancel(scope)) return cancel("Aborted, nothing was changed.");

  // No endpoint ships, so blank is the default answer and leaves the install local-only.
  const endpoint = await text({
    message: "Backend endpoint URL (leave blank to keep pheebs local-only)",
    initialValue: baseUrl(),
    validate: (value) => {
      if (value && !isHttpUrl(value)) return "Must be a valid http(s) URL.";
    },
  });
  if (isCancel(endpoint)) return cancel("Aborted, nothing was changed.");
  if (endpoint !== baseUrl()) {
    // A blank answer is an explicit choice of local-only, so it has to drop a previously
    // configured endpoint. Treating it as "no input" would silently keep sending.
    const cfg = readConfig() ?? {};
    if (endpoint) {
      cfg.baseUrl = endpoint.replace(/\/+$/, "");
    } else {
      delete cfg.baseUrl;
    }
    writeConfig(cfg);
  } else {
    ensureConfig();
  }

  // Token — provisions identity and authenticates OTel. Optional; can be set later.
  const token = await password({
    message: "Pheebs API token (leave blank to skip)",
    validate: (value) => {
      if (value && !/^pheebs_.+/.test(value)) return "Must be a Pheebs token (pheebs_…).";
    },
  });
  if (isCancel(token)) return cancel("Aborted, nothing was changed.");
  if (token) {
    const outcome = await setToken(token);
    if (outcome.status === "rejected") log.warn(`pheebs: ${outcome.message}`);
    else log.success(`pheebs: ${outcome.message}`);
  }

  const otelAnswer = await confirm({
    message: "Enable OpenTelemetry (metrics & traces, exported via the Pheebs backend)?",
    initialValue: true,
  });
  if (isCancel(otelAnswer)) return cancel("Aborted, nothing was changed.");
  const otelEnabled = otelAnswer;

  if (scope && hasUserLevelInstall()) {
    const remove = await confirm({
      message: "pheebs is also installed user-level, so every event fires twice. Remove it?",
      initialValue: true,
    });
    if (isCancel(remove)) return cancel("Aborted, nothing was changed.");
    if (remove) {
      const { removeFromJsonConfig } = await import("./uninstall.js");
      removeFromJsonConfig(resolveSettingsPath(false).path);
    }
  }

  const result = applyInit(scope, otelEnabled);
  recordInstall(AI_TOOLS.CLAUDE_CODE, result.settingsPath);
  log.success(
    `${TOOL_LABELS[AI_TOOLS.CLAUDE_CODE]}: ${result.definitionCount} hooks across ${result.hookTypeCount} types → ${result.settingsPath} (${result.level}, OTel ${result.otel})`,
  );

  if (otelEnabled && result.otel !== "wrote") {
    log.warn(otelInactiveReason());
  }
  if (result.otel === "wrote") {
    protectToken(result.settingsPath, (message) => log.warn(message));
  }

  outro("Done ✓");
}
