import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./pheebs-store.js";

// No endpoint ships. Pheebs runs local-only until a developer points it at a backend with
// `pheebs config set base-url` / `pheebs init`, so an install that is never configured
// cannot send anything anywhere. The empty string is the "no backend" value throughout;
// `hasBackend()` is the check, never a truthiness test on a route helper.
export const DEFAULT_BASE_URL = "";

const CONFIG_PATH = join(homedir(), ".pheebs", "config.json");

// Persistent client settings (~/.pheebs/config.json). The token is NOT here — it is a secret
// kept in ~/.pheebs/.token (0600). Managed via `pheebs config`.
export interface BackendConfig {
  baseUrl?: string;
  autoUpdate?: boolean;
  classify?: boolean;
}

export function readConfig(): BackendConfig | undefined {
  return readJsonFile<BackendConfig>(CONFIG_PATH);
}

export function writeConfig(config: BackendConfig): void {
  writeJsonFile(CONFIG_PATH, config);
}

export function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * The backend base URL: stored config → no backend (the empty string). A pure read — it runs on
 * the per-event hot path, so it never writes. A configured value that is not a valid http(s) URL
 * is ignored, leaving the install local-only rather than crashing the fetch. Trailing slashes trimmed.
 */
export function baseUrl(): string {
  const configured = readConfig()?.baseUrl;
  const raw = configured && isHttpUrl(configured) ? configured : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** With no endpoint the route helpers below yield bare paths like "/ingest", which fetch rejects. */
export function hasBackend(): boolean {
  return baseUrl() !== "";
}

/**
 * The once-a-day background self-update, off unless explicitly enabled. It installs in a
 * detached, silent child process, so it is opt-in rather than something a developer discovers
 * has been running. `pheebs doctor` reports when a newer version exists instead.
 */
export function autoUpdateEnabled(): boolean {
  return readConfig()?.autoUpdate === true;
}

/** Prompt classification is on unless explicitly disabled in config. */
export function classifyEnabled(): boolean {
  return readConfig()?.classify !== false;
}

/**
 * Materialize config.json when it is absent, so settings are visible and hand-editable.
 * Written empty rather than with a `baseUrl` key: no endpoint ships, and an explicit
 * `"baseUrl": ""` would read as a configured value rather than an unset one.
 * Best-effort — it runs on the session-start hook path, so a write failure must never throw.
 */
export function ensureConfig(): void {
  if (readConfig()) return;
  try {
    writeConfig({});
  } catch {}
}

export const ingestUrl = (): string => `${baseUrl()}/ingest`;
export const validateUrl = (): string => `${baseUrl()}/validate-token`;
export const otelBaseUrl = (): string => `${baseUrl()}/otel`;
export const classifyPromptUrl = (): string => `${baseUrl()}/classify-prompt`;
export const insightsUrl = (): string => `${baseUrl()}/insights`;
