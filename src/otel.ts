// OpenTelemetry config injected by `pheebs init` for tools with native OTel support
// (Claude Code, Codex). The client holds no observability credential: telemetry is exported
// to the backend's /otel proxy, authenticated with the pheebs token, and the proxy swaps in
// the real upstream credential. OTel is therefore configured only when both a backend and a
// token are set — without an endpoint there is nowhere to export to, and without a token
// there is nothing to authenticate the export with. Both gates also REMOVE previously written
// config, so clearing either one stops the agent exporting rather than leaving it pointed at
// a stale host.

import { hasBackend, otelBaseUrl } from "./backend-config.js";
import { readStoredToken } from "./token.js";

// Static env keys pheebs owns in Claude Code's settings.env. The endpoint and auth header
// are dynamic (per install) and handled separately.
const CLAUDE_OTEL_BASE: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative",
};

// Every key pheebs manages, so removal is exact and never touches env the user set.
const PHEEBS_OTEL_KEYS = [
  ...Object.keys(CLAUDE_OTEL_BASE),
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
];

/**
 * Mutates a Claude Code settings object's `env` block. When enabled AND both a backend and a
 * token are set, merges the pheebs OTel vars (pointing the exporter at the /otel proxy with a Bearer token);
 * otherwise removes exactly the keys pheebs manages, dropping `env` if it ends up empty.
 */
export function syncClaudeOtelEnv(
  settings: Record<string, unknown>,
  enabled: boolean,
  developerHandle?: string,
): void {
  const env = (settings.env as Record<string, string> | undefined) ?? {};
  const stored = readStoredToken();

  if (enabled && hasBackend() && stored?.token) {
    Object.assign(env, CLAUDE_OTEL_BASE, {
      OTEL_EXPORTER_OTLP_ENDPOINT: otelBaseUrl(),
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${stored.token}`,
    });
    // Identity in the observability backend lines up with events.developer (the token id)
    // when resolved, falling back to the local handle.
    const serviceId = stored.id ?? developerHandle;
    if (serviceId) {
      env.OTEL_RESOURCE_ATTRIBUTES = `service.instance.id=${serviceId}`;
    }
    settings.env = env;
    return;
  }

  for (const key of PHEEBS_OTEL_KEYS) {
    delete env[key];
  }

  if (Object.keys(env).length === 0) {
    delete settings.env;
  } else {
    settings.env = env;
  }
}

/**
 * Mutates a Codex config object's `[otel]` table. When enabled AND both a backend and a token
 * are set, writes the pheebs-owned otel config (exporting to the /otel proxy with a Bearer token); otherwise
 * removes it.
 *
 * Codex supports three OTel exporters: `exporter` (logs), `trace_exporter` (traces), and
 * `metrics_exporter` (metrics, default: statsig). It also gates `metrics_exporter` behind
 * `[analytics] enabled`, which defaults to false under the app-server, so without that flag the
 * configured OTLP metrics endpoint is silently dropped — enable it so metrics actually flow.
 */
export function syncCodexOtel(config: Record<string, unknown>, enabled: boolean): void {
  const stored = readStoredToken();

  if (!enabled || !hasBackend() || !stored?.token) {
    delete config.otel;
    const analytics = config.analytics as Record<string, unknown> | undefined;
    if (analytics) {
      delete analytics.enabled;
      if (Object.keys(analytics).length === 0) {
        delete config.analytics;
      }
    }
    return;
  }

  const base = otelBaseUrl();
  const otlpConfig = {
    protocol: "binary",
    headers: { Authorization: `Bearer ${stored.token}` },
  };

  config.otel = {
    environment: "production",
    log_user_prompt: false,
    exporter: { "otlp-http": { ...otlpConfig, endpoint: `${base}/v1/logs` } },
    trace_exporter: { "otlp-http": { ...otlpConfig, endpoint: `${base}/v1/traces` } },
    metrics_exporter: { "otlp-http": { ...otlpConfig, endpoint: `${base}/v1/metrics` } },
  };

  const analytics = (config.analytics as Record<string, unknown> | undefined) ?? {};
  analytics.enabled = true;
  config.analytics = analytics;
}
