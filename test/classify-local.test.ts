import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

const { canRunClaude, classifyLocally, LOCAL_CLASSIFIER_VERSION } = await import(
  "../src/classify-local.js"
);
const { CODEBOOK } = await import("../src/codebook.js");

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  received: string;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(stdout: string, code: number | null = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.received = "";
  child.kill = vi.fn();
  child.stdin.on("data", (chunk: Buffer) => {
    child.received += chunk.toString();
  });
  child.stdin.on("end", () => {
    child.stdout.end(stdout);
    child.stdout.on("end", () => child.emit("close", code));
  });
  return child;
}

function cliResult(structured: unknown): string {
  return JSON.stringify({ type: "result", is_error: false, structured_output: structured });
}

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SOMETHING_ELSE",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "PHEEBS_LOCAL_CLASSIFIER",
  "KEEP_ME",
];

beforeEach(() => {
  spawnMock.mockReset();
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("classifyLocally", () => {
  it("sends the prompt on stdin only and maps the structured output", async () => {
    const child = fakeChild(
      cliResult({ label: "repair", requests_verification: true, task_scope: "bounded" }),
    );
    spawnMock.mockReturnValue(child);

    expect(await classifyLocally("the build is broken")).toEqual({
      label: "repair",
      requests_verification: true,
      task_scope: "bounded",
      classifier_version: LOCAL_CLASSIFIER_VERSION,
    });
    expect(child.received).toBe("the build is broken");
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("claude");
    expect(args).not.toContain("the build is broken");
  });

  it("runs the child with hooks, settings, MCP and transcripts switched off on a pinned model", async () => {
    spawnMock.mockReturnValue(fakeChild(cliResult({ label: "task" })));
    await classifyLocally("x");
    const args = spawnMock.mock.calls[0][1] as string[];
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1];

    expect(flagValue("--model")).toBe("claude-haiku-5-5");
    expect(JSON.parse(flagValue("--settings"))).toEqual({ disableAllHooks: true });
    expect(flagValue("--setting-sources")).toBe("");
    expect(flagValue("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(args).not.toContain("--bare");
    // Without these two the CLI prints prose, so every prompt would record unclassified.
    expect(flagValue("--output-format")).toBe("json");
    expect(JSON.parse(flagValue("--json-schema")).properties.label.enum).toContain("repair");
    expect(flagValue("--system-prompt")).toBe(CODEBOOK);
    expect((spawnMock.mock.calls[0][2] as { cwd: string }).cwd).toBe(tmpdir());
    expect(LOCAL_CLASSIFIER_VERSION).toBe("claude-code:claude-haiku-5-5@cb3");
  });

  it("strips telemetry from the child's env and marks it as a classifier", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.test/otel";
    process.env.OTEL_SOMETHING_ELSE = "1";
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = "1";
    process.env.ANTHROPIC_API_KEY = "sk-declined";
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway";
    process.env.KEEP_ME = "yes";
    spawnMock.mockReturnValue(fakeChild(cliResult({ label: "task" })));
    await classifyLocally("x");

    const env = (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env).not.toHaveProperty("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(env).not.toHaveProperty("OTEL_SOMETHING_ELSE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENABLE_TELEMETRY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env.KEEP_ME).toBe("yes");
    expect(env.PHEEBS_LOCAL_CLASSIFIER).toBe("1");
  });

  it("omits fields the output does not carry with the right type or inside the codebook", async () => {
    spawnMock.mockReturnValue(
      fakeChild(cliResult({ label: "task", requests_verification: "yes", task_scope: "large" })),
    );
    expect(await classifyLocally("x")).toEqual({
      label: "task",
      classifier_version: LOCAL_CLASSIFIER_VERSION,
    });
  });

  it("resolves undefined on a label outside the codebook", async () => {
    spawnMock.mockReturnValue(fakeChild(cliResult({ label: "question" })));
    expect(await classifyLocally("x")).toBeUndefined();
  });

  it.each([
    ["a non-zero exit", fakeChild(cliResult({ label: "task" }), 1)],
    ["a killed child", fakeChild("", null)],
    ["output that is not JSON", fakeChild("Not logged in")],
    ["an error result with no structured output", fakeChild(JSON.stringify({ is_error: true }))],
  ])("resolves undefined on %s", async (_name, child) => {
    spawnMock.mockReturnValue(child);
    expect(await classifyLocally("x")).toBeUndefined();
  });

  it("resolves undefined when claude is not on the PATH", async () => {
    // Node does send close after a failed spawn; leaving it out proves error alone settles it.
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    });
    expect(await classifyLocally("x")).toBeUndefined();
  });

  it("kills a child that outlives the deadline and resolves undefined without waiting for close", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    const pending = classifyLocally("x");
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("reads the result out of the message list a verbose setting produces", async () => {
    const list = [
      { type: "system", subtype: "init" },
      JSON.parse(cliResult({ label: "approval", task_scope: "n/a" })),
    ];
    spawnMock.mockReturnValue(fakeChild(JSON.stringify(list)));
    expect(await classifyLocally("x")).toMatchObject({ label: "approval", task_scope: "n/a" });
  });

  it("reports whether claude starts", async () => {
    spawnMock.mockReturnValue(fakeChild("2.1.304 (Claude Code)"));
    expect(await canRunClaude()).toBe(true);
    spawnMock.mockReturnValue(fakeChild("", 127));
    expect(await canRunClaude()).toBe(false);
  });

  it("resolves undefined when spawn itself throws", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("EMFILE");
    });
    expect(await classifyLocally("x")).toBeUndefined();
  });
});
