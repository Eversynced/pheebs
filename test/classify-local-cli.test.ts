import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODEBOOK } from "../src/codebook.js";
import { runHookRows } from "./hook-runner.js";

// A stand-in `claude` that records how it was started and answers like `claude -p` does, so these
// run the real spawn, pipes and env of the built CLI. POSIX only: Windows cannot spawn a script
// without a shell, the same limit a real npm `claude.cmd` hits there.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const stripped = Object.keys(process.env).filter(
  (k) => k.startsWith("OTEL_") || k === "ANTHROPIC_API_KEY" || k === "CLAUDE_CODE_ENABLE_TELEMETRY",
);
fs.appendFileSync(
  process.env.FAKE_CLAUDE_CALLS,
  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stripped,
    guard: process.env.PHEEBS_LOCAL_CLASSIFIER }) + "\\n",
);
if (process.env.FAKE_CLAUDE_MODE === "exit-early") process.exit(0);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", structured_output: {
      label: input ? "repair" : "unclassified", requests_verification: false, task_scope: "bounded" } }));
  }, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
});
`;

const PROMPT = "the login page throws a 500 on an empty password";

describe.skipIf(process.platform === "win32")("classify local through the built CLI", () => {
  let dir: string;
  let calls: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pheebs-fake-claude-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "claude"), FAKE_CLAUDE);
    chmodSync(join(dir, "bin", "claude"), 0o755);
    calls = join(dir, "calls.jsonl");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], prompt: string, extraEnv: NodeJS.ProcessEnv = {}) {
    rmSync(calls, { force: true });
    const [row] = runHookRows(args, { session_id: "s1", prompt }, undefined, {
      path: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      extraEnv: {
        FAKE_CLAUDE_CALLS: calls,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        ANTHROPIC_API_KEY: "sk-declined",
        ...extraEnv,
      },
      setupHome: (home) => {
        mkdirSync(join(home, ".pheebs"));
        writeFileSync(
          join(home, ".pheebs", "config.json"),
          JSON.stringify({ classify: false, classifyLocally: true }),
        );
      },
    }).filter((r) => r.event === "prompt_submitted");
    const recorded = existsSync(calls)
      ? readFileSync(calls, "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
    return { row, recorded };
  }

  it("labels a Claude Code prompt through an isolated child that keeps the text off the event", () => {
    const { row, recorded } = run(["hook", "prompt_submitted"], PROMPT);
    expect(row).toMatchObject({
      prompt_intent: "repair",
      task_scope: "bounded",
      classifier_version: "claude-code:claude-haiku-5-5@cb3",
    });
    expect(JSON.stringify(row)).not.toContain("login page");

    const [{ argv, cwd, stripped, guard }] = recorded;
    const flagValue = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(flagValue("--system-prompt")).toBe(CODEBOOK);
    expect(flagValue("--output-format")).toBe("json");
    expect(flagValue("--setting-sources")).toBe("");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain(PROMPT);
    expect(realpathSync(cwd)).toBe(realpathSync(tmpdir()));
    expect(stripped).toEqual([]);
    expect(guard).toBe("1");
  });

  it("stamps the prompt when it was submitted, not when classification finished", () => {
    const before = Date.now();
    const { row } = run(["hook", "prompt_submitted"], PROMPT, { FAKE_CLAUDE_DELAY_MS: "2000" });
    expect(row.prompt_intent).toBe("repair");
    expect(Date.parse(String(row.timestamp)) - before).toBeLessThan(1500);
  });

  it("never starts claude for a Cursor prompt", () => {
    const { row, recorded } = run(["hook-cursor", "prompt_submitted"], PROMPT);
    expect(row.prompt_intent).toBe("unclassified");
    expect(recorded).toEqual([]);
  });

  it("survives a child that exits without reading a large prompt", () => {
    const { row } = run(["hook", "prompt_submitted"], "x".repeat(4 * 1024 * 1024), {
      FAKE_CLAUDE_MODE: "exit-early",
      // Debug echoes the payload to stderr, which would overflow the runner's buffer at this size.
      PHEEBS_DEBUG: "",
    });
    expect(row.prompt_intent).toBe("unclassified");
  });
});
