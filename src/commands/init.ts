import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  baseUrl,
  ensureConfig,
  hasBackend,
  isHttpUrl,
  readConfig,
  writeConfig,
} from "../backend-config.js";
import { getDeveloperHandle } from "../developer-id.js";
import {
  AI_TOOLS,
  type AiTool,
  buildHooksConfig,
  CODEX_TRUST_WARNING,
  getHookDefinitionsForTool,
  isPheebsEntry,
  TOOL_LABELS,
} from "../hooks/definitions.js";
import { syncClaudeOtelEnv, syncCodexOtel } from "../otel.js";
import { readStoredToken, setToken } from "../token.js";
import { detectInstalledTools } from "./detect.js";
import { resolveSettingsPath } from "./path.js";

type InitResult = {
  definitionCount: number;
  hookTypeCount: number;
  settingsPath: string;
  level: string;
  otel?: "wrote" | "removed";
};

function initCursor(settingsPath: string, level: string): InitResult {
  const definitions = getHookDefinitionsForTool(AI_TOOLS.CURSOR);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];

  mkdirSync(dirname(settingsPath), { recursive: true });

  let config: Record<string, unknown> = { version: 1, hooks: {} };

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      config = JSON.parse(raw);
    } catch {
      console.warn(`pheebs: existing ${settingsPath} is malformed, starting fresh`);
      config = { version: 1, hooks: {} };
    }
  }

  const existingHooks = (config.hooks as Record<string, unknown[] | undefined>) ?? {};
  const pheebsHooks = buildHooksConfig(AI_TOOLS.CURSOR);

  for (const key of hookKeys) {
    const existing = Array.isArray(existingHooks[key]) ? (existingHooks[key] as unknown[]) : [];
    const nonPheebs = existing.filter((entry) => !isPheebsEntry(entry));
    existingHooks[key] = [...nonPheebs, ...pheebsHooks[key]];
  }

  config.version = 1;
  config.hooks = existingHooks;

  writeFileSync(settingsPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    settingsPath,
    level,
  };
}

function initCodex(settingsPath: string, level: string, otelEnabled: boolean): InitResult {
  const definitions = getHookDefinitionsForTool(AI_TOOLS.CODEX);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];

  mkdirSync(dirname(settingsPath), { recursive: true });

  let config: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      config = parseToml(raw) as Record<string, unknown>;
    } catch {
      console.warn(`pheebs: existing ${settingsPath} is malformed, starting fresh`);
      config = {};
    }
  }

  const existingHooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
  const pheebsHooks = buildHooksConfig(AI_TOOLS.CODEX);

  for (const key of hookKeys) {
    const existing = Array.isArray(existingHooks[key]) ? (existingHooks[key] as unknown[]) : [];
    const nonPheebs = existing.filter((entry) => !isPheebsEntry(entry));
    existingHooks[key] = [...nonPheebs, ...pheebsHooks[key]];
  }

  config.hooks = existingHooks;

  syncCodexOtel(config, otelEnabled);

  writeFileSync(settingsPath, `${stringifyToml(config)}\n`);

  return {
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    settingsPath,
    level,
    otel: otelEnabled ? "wrote" : "removed",
  };
}

function initClaudeCode(settingsPath: string, level: string, otelEnabled: boolean): InitResult {
  const definitions = getHookDefinitionsForTool(AI_TOOLS.CLAUDE_CODE);
  const hookKeys = [...new Set(definitions.map((d) => d.hookKey))];

  mkdirSync(dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      console.warn(`pheebs: existing ${settingsPath} is malformed, starting fresh`);
      settings = {};
    }
  }

  const existingHooks = (settings.hooks as Record<string, unknown[] | undefined>) ?? {};
  const pheebsHooks = buildHooksConfig(AI_TOOLS.CLAUDE_CODE);

  for (const key of hookKeys) {
    const existing = Array.isArray(existingHooks[key]) ? (existingHooks[key] as unknown[]) : [];
    const nonPheebs = existing.filter((entry) => !isPheebsEntry(entry));
    existingHooks[key] = [...nonPheebs, ...pheebsHooks[key]];
  }

  settings.hooks = existingHooks;

  const developerHandle = getDeveloperHandle();
  syncClaudeOtelEnv(settings, otelEnabled, developerHandle);

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    definitionCount: definitions.length,
    hookTypeCount: hookKeys.length,
    settingsPath,
    level,
    otel: otelEnabled ? "wrote" : "removed",
  };
}

export function applyInit(tool: AiTool, project: boolean, otelEnabled: boolean): InitResult {
  const { path: settingsPath, level } = resolveSettingsPath(tool, project);

  if (tool === AI_TOOLS.CODEX) {
    return initCodex(settingsPath, level, otelEnabled);
  } else if (tool === AI_TOOLS.CURSOR) {
    return initCursor(settingsPath, level);
  } else {
    return initClaudeCode(settingsPath, level, otelEnabled);
  }
}

/** A user-level install keeps firing alongside a project-local one, doubling every event, so
 *  both init paths have to spot it before writing a second copy. */
export function hasUserLevelInstall(tool: AiTool): boolean {
  const { path: userPath } = resolveSettingsPath(tool, false);
  if (!existsSync(userPath)) return false;

  let config: Record<string, unknown>;
  try {
    const raw = readFileSync(userPath, "utf-8");
    config = (tool === AI_TOOLS.CODEX ? parseToml(raw) : JSON.parse(raw)) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }

  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;

  return Object.values(hooks).some((entries) =>
    (Array.isArray(entries) ? entries : [entries]).some(isPheebsEntry),
  );
}

export async function runInit(options?: {
  project?: boolean;
  tool?: AiTool;
  otel?: boolean;
}): Promise<void> {
  const tool: AiTool = options?.tool ?? AI_TOOLS.CLAUDE_CODE;
  const otelEnabled = options?.otel ?? true;

  // Materialize config.json so settings are visible and hand-editable after a non-interactive init.
  ensureConfig();

  const project = options?.project ?? true;

  if (project && hasUserLevelInstall(tool)) {
    const { path: userPath } = resolveSettingsPath(tool, false);
    console.warn(
      `pheebs: hooks are also registered user-level in ${userPath}, so every event fires twice. Run \`pheebs uninstall\` (it clears both scopes) and then init again.`,
    );
  }

  const result = applyInit(tool, project, otelEnabled);

  console.log(
    `pheebs: wrote ${result.definitionCount} hook entries across ${result.hookTypeCount} hook types to ${result.settingsPath} (${result.level})`,
  );
  if (result.otel !== undefined) {
    console.log(`pheebs: ${result.otel} OTel config in ${result.settingsPath}`);
  }

  if (project && tool === AI_TOOLS.CODEX) {
    console.warn(`pheebs: ${CODEX_TRUST_WARNING}`);
  }

  const { runArtifactScan } = await import("../scanner.js");
  runArtifactScan(tool);
}

export async function runInitInteractive(): Promise<void> {
  intro("pheebs init");

  const installed = detectInstalledTools();
  const initialValues = installed.length > 0 ? installed : [AI_TOOLS.CLAUDE_CODE];
  const hint = (tool: AiTool) => (installed.includes(tool) ? "detected" : undefined);

  const tools = await multiselect<AiTool>({
    message: "Which agents do you want to configure?",
    options: [
      {
        value: AI_TOOLS.CLAUDE_CODE,
        label: TOOL_LABELS[AI_TOOLS.CLAUDE_CODE],
        hint: hint(AI_TOOLS.CLAUDE_CODE),
      },
      { value: AI_TOOLS.CURSOR, label: TOOL_LABELS[AI_TOOLS.CURSOR], hint: hint(AI_TOOLS.CURSOR) },
      { value: AI_TOOLS.CODEX, label: TOOL_LABELS[AI_TOOLS.CODEX], hint: hint(AI_TOOLS.CODEX) },
    ],
    initialValues,
    required: true,
  });
  if (isCancel(tools)) return cancel("Aborted — nothing was changed.");

  const scope = await select<boolean>({
    message: "Where should hooks be registered?",
    options: [
      { value: true, label: "Project-local", hint: "this repo only" },
      { value: false, label: "User-level", hint: "applies everywhere" },
    ],
    initialValue: true,
  });
  if (isCancel(scope)) return cancel("Aborted — nothing was changed.");

  // No endpoint ships, so blank is the default answer and leaves the install local-only.
  const endpoint = await text({
    message: "Backend endpoint URL (leave blank to keep pheebs local-only)",
    initialValue: baseUrl(),
    validate: (value) => {
      if (value && !isHttpUrl(value)) return "Must be a valid http(s) URL.";
    },
  });
  if (isCancel(endpoint)) return cancel("Aborted — nothing was changed.");
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
  if (isCancel(token)) return cancel("Aborted — nothing was changed.");
  if (token) {
    const outcome = await setToken(token);
    if (outcome.status === "rejected") log.warn(`pheebs: ${outcome.message}`);
    else log.success(`pheebs: ${outcome.message}`);
  }

  let otelEnabled = true;
  const otelEligible = tools.includes(AI_TOOLS.CLAUDE_CODE) || tools.includes(AI_TOOLS.CODEX);
  if (otelEligible) {
    const answer = await confirm({
      message: "Enable OpenTelemetry (metrics & traces, exported via the Pheebs backend)?",
      initialValue: true,
    });
    if (isCancel(answer)) return cancel("Aborted — nothing was changed.");
    otelEnabled = answer;
  }

  if (scope) {
    const alsoUserLevel = tools.filter(hasUserLevelInstall);
    if (alsoUserLevel.length > 0) {
      const labels = alsoUserLevel.map((t) => TOOL_LABELS[t]).join(", ");
      const remove = await confirm({
        message: `pheebs is also installed user-level (${labels}), so every event fires twice. Remove it?`,
        initialValue: true,
      });
      if (isCancel(remove)) return cancel("Aborted — nothing was changed.");
      if (remove) {
        const { removeFromJsonConfig, removeFromTomlConfig } = await import("./uninstall.js");
        for (const tool of alsoUserLevel) {
          const { path: userPath } = resolveSettingsPath(tool, false);
          if (tool === AI_TOOLS.CODEX) removeFromTomlConfig(userPath);
          else removeFromJsonConfig(userPath, tool);
        }
      }
    }
  }

  for (const tool of tools) {
    const result = applyInit(tool, scope, otelEnabled);
    let otelNote = "";
    if (tool === AI_TOOLS.CURSOR) otelNote = ", OTel n/a";
    else if (result.otel !== undefined) otelNote = `, OTel ${result.otel}`;
    log.success(
      `${TOOL_LABELS[tool]}: ${result.definitionCount} hooks across ${result.hookTypeCount} types → ${result.settingsPath} (${result.level}${otelNote})`,
    );
  }

  const hasToken = readStoredToken() !== undefined;
  // OTel needs both: the endpoint is where the export goes, the token is what authenticates it.
  if (otelEnabled && otelEligible && !(hasToken && hasBackend())) {
    const missing = !hasBackend() ? "no backend endpoint is set" : "no token is set";
    log.warn(`OTel is enabled but ${missing} — it stays inactive until that is configured.`);
  }
  // A project-scoped OTel config embeds the token in a repo-local file.
  if (scope && otelEnabled && hasToken) {
    log.warn(
      "Project-local OTel config embeds your token — ensure that settings file is gitignored.",
    );
  }

  if (scope && tools.includes(AI_TOOLS.CODEX)) {
    log.warn(CODEX_TRUST_WARNING);
  }

  outro("Done ✓");
}
