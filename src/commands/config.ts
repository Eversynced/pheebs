import {
  autoUpdateEnabled,
  type BackendConfig,
  baseUrl,
  classifyEnabled,
  hasBackend,
  isHttpUrl,
  readConfig,
  writeConfig,
} from "../backend-config.js";
import { resyncOtelConfigs } from "../otel-resync.js";
import { clearStoredToken, readStoredToken, setToken, tokenLast4 } from "../token.js";

const USAGE = `pheebs config <command>

Commands:
  list                 Show all settings and where each comes from
  get <key>            Print one setting's value
  set <key> <value>    Change a setting
  unset <key>          Reset a setting to its default (clears the token)

Keys:
  base-url             Backend endpoint URL
  auto-update          Background self-update: on | off
  classify             Send prompts to the intent classifier: on | off
  token                Your Pheebs API token (validated on set)`;

export async function runConfig(args: string[]): Promise<void> {
  switch (args[0]) {
    case "list":
      return runList();
    case "get":
      return runGet(args[1]);
    case "set":
      return runSet(args[1], args[2]);
    case "unset":
      return runUnset(args[1]);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

function parseBool(value: string): boolean | undefined {
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  return undefined;
}

function source(present: boolean): string {
  return present ? "config" : "default";
}

function baseUrlSummary(): string {
  return hasBackend() ? baseUrl() : "not set (local-only)";
}

function tokenSummary(): string {
  const stored = readStoredToken();
  if (!stored) return "not set";
  const who = stored.developer ?? stored.id ?? "set";
  return `${who} (…${tokenLast4(stored.token)})`;
}

function runList(): void {
  const cfg = readConfig() ?? {};
  console.log(`base-url     ${baseUrlSummary()}  (${source(cfg.baseUrl !== undefined)})`);
  console.log(
    `auto-update  ${autoUpdateEnabled() ? "on" : "off"}  (${source(cfg.autoUpdate !== undefined)})`,
  );
  console.log(
    `classify     ${classifyEnabled() ? "on" : "off"}  (${source(cfg.classify !== undefined)})`,
  );
  console.log(`token        ${tokenSummary()}`);
}

function runGet(key: string | undefined): void {
  switch (key) {
    case "base-url":
      // `get` stays machine-readable for scripts; the prose summary belongs to `list`.
      console.log(baseUrl());
      return;
    case "auto-update":
      console.log(autoUpdateEnabled() ? "on" : "off");
      return;
    case "classify":
      console.log(classifyEnabled() ? "on" : "off");
      return;
    case "token":
      console.log(tokenSummary());
      return;
    default:
      console.error(`pheebs: unknown key "${key ?? ""}". Run \`pheebs config\` for the list.`);
      process.exit(1);
  }
}

function updateConfig(patch: Partial<BackendConfig>): void {
  writeConfig({ ...(readConfig() ?? {}), ...patch });
}

async function runSet(key: string | undefined, value: string | undefined): Promise<void> {
  if (value === undefined) {
    console.error(`Usage: pheebs config set ${key ?? "<key>"} <value>`);
    process.exit(1);
  }

  if (key === "token") {
    if (!/^pheebs_.+/.test(value)) {
      console.error("pheebs: that does not look like a Pheebs token (expected pheebs_<value>).");
      process.exit(1);
    }
    const outcome = await setToken(value);
    if (outcome.status === "rejected") {
      console.error(`pheebs: ${outcome.message}`);
      process.exit(1);
    }
    console.log(`pheebs: ${outcome.message}`);
    return;
  }

  if (key === "base-url") {
    if (!isHttpUrl(value)) {
      console.error("pheebs: base-url must be a valid http(s) URL.");
      process.exit(1);
    }
    const trimmed = value.replace(/\/+$/, "");
    updateConfig({ baseUrl: trimmed });
    // The agent's own OTel exporter points at the old host until it is rewritten.
    resyncOtelConfigs();
    console.log(`pheebs: base-url set to ${trimmed}`);
    return;
  }

  if (key === "auto-update" || key === "classify") {
    const on = parseBool(value);
    if (on === undefined) {
      console.error(`pheebs: ${key} must be "on" or "off".`);
      process.exit(1);
    }
    updateConfig(key === "auto-update" ? { autoUpdate: on } : { classify: on });
    console.log(`pheebs: ${key} set to ${on ? "on" : "off"}`);
    return;
  }

  console.error(`pheebs: unknown key "${key ?? ""}". Run \`pheebs config\` for the list.`);
  process.exit(1);
}

function unsetConfigKey(field: keyof BackendConfig): void {
  const cfg = readConfig();
  if (!cfg) return; // nothing stored yet — defaults already apply; don't create an empty file
  delete cfg[field];
  writeConfig(cfg);
}

function runUnset(key: string | undefined): void {
  switch (key) {
    case "token": {
      const removed = clearStoredToken();
      console.log(removed ? "pheebs: token cleared." : "pheebs: no token was set.");
      return;
    }
    case "base-url":
      unsetConfigKey("baseUrl");
      // Without this the agent keeps exporting telemetry to the endpoint just removed.
      resyncOtelConfigs();
      break;
    case "auto-update":
      unsetConfigKey("autoUpdate");
      break;
    case "classify":
      unsetConfigKey("classify");
      break;
    default:
      console.error(`pheebs: unknown key "${key ?? ""}". Run \`pheebs config\` for the list.`);
      process.exit(1);
  }
  console.log(`pheebs: ${key} reset to default.`);
}
