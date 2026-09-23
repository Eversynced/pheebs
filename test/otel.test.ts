import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stored: undefined as undefined | { token: string; id?: string },
  backend: true,
}));
vi.mock("../src/token.js", () => ({ readStoredToken: () => h.stored }));
vi.mock("../src/backend-config.js", () => ({
  otelBaseUrl: () => "https://api.test/otel",
  hasBackend: () => h.backend,
}));

const { syncClaudeOtelEnv, syncCodexOtel } = await import("../src/otel.js");

type CodexOtel = {
  environment: string;
  exporter: { "otlp-http": { endpoint: string; headers: Record<string, string> } };
  trace_exporter: { "otlp-http": { endpoint: string } };
  metrics_exporter: { "otlp-http": { endpoint: string } };
};

beforeEach(() => {
  h.stored = undefined;
  h.backend = true;
});

describe("syncClaudeOtelEnv", () => {
  it("writes the OTel env pointed at the /otel proxy with a Bearer token", () => {
    h.stored = { token: "pheebs_secret", id: "tok-1" };
    const settings: Record<string, unknown> = {};
    syncClaudeOtelEnv(settings, true, "dev-abc");

    const env = settings.env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://api.test/otel");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Bearer pheebs_secret");
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe("cumulative");
    // service.instance.id = token id (matches events.developer), not the handle
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("service.instance.id=tok-1");
  });

  it("falls back to the developer handle when the token has no resolved id", () => {
    h.stored = { token: "pheebs_secret" };
    const settings: Record<string, unknown> = {};
    syncClaudeOtelEnv(settings, true, "dev-abc");
    expect((settings.env as Record<string, string>).OTEL_RESOURCE_ATTRIBUTES).toBe(
      "service.instance.id=dev-abc",
    );
  });

  it("writes nothing when enabled but no token is set", () => {
    h.stored = undefined;
    const settings: Record<string, unknown> = {};
    syncClaudeOtelEnv(settings, true, "dev-abc");
    expect(settings.env).toBeUndefined();
  });

  it("strips a previously written export when the backend is unset but the token remains", () => {
    // The dangerous case: clearing base-url must not leave the agent exporting to the old host.
    h.stored = { token: "pheebs_secret" };
    h.backend = false;
    const settings: Record<string, unknown> = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://old.test/otel",
      },
    };
    syncClaudeOtelEnv(settings, true, "dev-abc");
    expect(settings.env).toBeUndefined();
  });

  it("removes only pheebs-owned keys when disabled, keeping user env", () => {
    h.stored = { token: "pheebs_secret" };
    const settings: Record<string, unknown> = {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "x", MY_VAR: "keep" },
    };
    syncClaudeOtelEnv(settings, false);
    expect(settings.env).toEqual({ MY_VAR: "keep" });
  });

  it("drops the env block entirely when nothing is left", () => {
    const settings: Record<string, unknown> = { env: { OTEL_LOGS_EXPORTER: "otlp" } };
    syncClaudeOtelEnv(settings, false);
    expect(settings.env).toBeUndefined();
  });

  it("ships no Grafana endpoint or Basic credential", () => {
    h.stored = { token: "pheebs_secret", id: "tok-1" };
    const settings: Record<string, unknown> = {};
    syncClaudeOtelEnv(settings, true, "dev-abc");
    const blob = JSON.stringify(settings);
    expect(blob).not.toContain("grafana.net");
    expect(blob).not.toContain("Basic ");
  });
});

describe("syncCodexOtel", () => {
  it("writes otel tables pointed at the /otel proxy with a Bearer token", () => {
    h.stored = { token: "pheebs_secret", id: "tok-1" };
    const config: Record<string, unknown> = {};
    syncCodexOtel(config, true);

    const otel = config.otel as CodexOtel;
    expect(otel.environment).toBe("production");
    expect(otel.exporter["otlp-http"].endpoint).toBe("https://api.test/otel/v1/logs");
    expect(otel.trace_exporter["otlp-http"].endpoint).toBe("https://api.test/otel/v1/traces");
    expect(otel.metrics_exporter["otlp-http"].endpoint).toBe("https://api.test/otel/v1/metrics");
    expect(otel.exporter["otlp-http"].headers.Authorization).toBe("Bearer pheebs_secret");
    expect((config.analytics as Record<string, unknown>).enabled).toBe(true);
  });

  it("writes nothing when enabled but no token is set", () => {
    h.stored = undefined;
    const config: Record<string, unknown> = {};
    syncCodexOtel(config, true);
    expect(config.otel).toBeUndefined();
  });

  it("strips a previously written export when the backend is unset but the token remains", () => {
    h.stored = { token: "pheebs_secret" };
    h.backend = false;
    const config: Record<string, unknown> = {
      otel: { environment: "production" },
      analytics: { enabled: true },
    };
    syncCodexOtel(config, true);
    expect(config.otel).toBeUndefined();
  });

  it("removes otel and the analytics flag when disabled", () => {
    h.stored = { token: "pheebs_secret" };
    const config: Record<string, unknown> = {
      otel: { environment: "production" },
      analytics: { enabled: true },
    };
    syncCodexOtel(config, false);
    expect(config.otel).toBeUndefined();
    expect(config.analytics).toBeUndefined();
  });

  it("preserves unrelated analytics keys when disabling", () => {
    const config: Record<string, unknown> = {
      otel: {},
      analytics: { enabled: true, other: "keep" },
    };
    syncCodexOtel(config, false);
    expect(config.analytics).toEqual({ other: "keep" });
  });
});
