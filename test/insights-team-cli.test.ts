import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_OFF, WINDOW_28, WINDOW_90, WITH_REPERTOIRE } from "./fixtures/team-insights.js";

// The built CLI against a stub backend over a real socket, so the request it makes is observed
// rather than assumed. The stub is in-process, which is why the CLI is spawned asynchronously.

const run = promisify(execFile);
const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
const TOKEN = "pheebs_secret_value_1234";

let server: Server;
let baseUrl: string;
const homes: string[] = [];

type Reply = { status: number; body: string };
let reply: Reply;
let requests: { url: string; auth: string | undefined; method: string }[];

function ok(payload: unknown): Reply {
  return { status: 200, body: JSON.stringify(payload) };
}

function home(token: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), "pheebs-team-home-"));
  homes.push(dir);
  mkdirSync(join(dir, ".pheebs"), { recursive: true });
  writeFileSync(join(dir, ".pheebs", "config.json"), JSON.stringify({ baseUrl }));
  if (token) writeFileSync(join(dir, ".pheebs", ".token"), JSON.stringify(token));
  return dir;
}

type Result = { stdout: string; stderr: string; status: number };

async function cli(dir: string, ...args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args], {
      encoding: "utf-8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    });
    return { stdout, stderr, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.code ?? 1 };
  }
}

let manager: string;
let engineer: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      auth: req.headers.authorization,
      method: req.method ?? "",
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  manager = home({ token: TOKEN, id: "tok-1", developer: "michael", role: "manager" });
  engineer = home({ token: TOKEN, id: "tok-2", developer: "jim", role: "engineer" });
});

afterAll(() => {
  server?.close();
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  reply = ok(WINDOW_90);
});

describe("pheebs insights --team: the request", () => {
  it("GETs /insights/team with the stored token as a bearer credential", async () => {
    await cli(manager, "insights", "--team");
    expect(requests).toEqual([{ url: "/insights/team", auth: `Bearer ${TOKEN}`, method: "GET" }]);
  });

  it("passes the window through in either spelling and leaves it off by default", async () => {
    await cli(manager, "insights", "--team", "--days", "28");
    await cli(manager, "insights", "--days=7", "--team");
    expect(requests.map((r) => r.url)).toEqual(["/insights/team?days=28", "/insights/team?days=7"]);
  });

  it("refuses a bad window without calling out", async () => {
    const { status, stderr } = await cli(manager, "insights", "--team", "--days", "0");
    expect(status).toBe(1);
    expect(stderr).toContain("--days takes a whole number");
    expect(requests).toEqual([]);
  });

  it("still asks the backend when the cached role says engineer, because the backend decides", async () => {
    reply = { status: 403, body: '{"error":"Forbidden"}' };
    await cli(engineer, "insights", "--team");
    expect(requests).toHaveLength(1);
  });

  it("leaves plain `insights` on /insights", async () => {
    reply = ok({ days: 30, sections: {} });
    await cli(manager, "insights");
    expect(requests[0].url).toBe("/insights");
  });
});

describe("pheebs insights --team: output", () => {
  it("prints the raw payload byte-for-byte with --json", async () => {
    reply = ok(WINDOW_90);
    const { stdout, status } = await cli(manager, "insights", "--team", "--json");
    expect(status).toBe(0);
    expect(stdout.trimEnd()).toBe(reply.body);
    expect(requests.map((r) => r.url)).toEqual(["/insights/team"]);
  });

  it("renders the 90-day payload", async () => {
    const { stdout, status } = await cli(manager, "insights", "--team");
    expect(status).toBe(0);
    expect(stdout).toContain("Your team, last 90 days");
    expect(stdout).toContain("Eversynced (tenant, 2 engineers)");
    expect(stdout).toContain("Repertoire: this backend does not produce it");
    expect(stdout).toMatch(/gustavo\s+50%/);
    expect(stdout).toContain("API list-price equivalent, estimated upper bound");
  });

  it("renders the 28-day payload with the views that are off", async () => {
    reply = ok(WINDOW_28);
    const { stdout } = await cli(manager, "insights", "--team");
    expect(stdout).toContain("Median movement: not enough sessions yet to say anything");
    expect(stdout).toContain("Wholesale watch: not enough sessions yet to say anything");
  });

  it("renders an enabled repertoire", async () => {
    reply = ok(WITH_REPERTOIRE);
    const { stdout } = await cli(manager, "insights", "--team");
    expect(stdout).toContain("Adoption funnel");
    expect(stdout).toContain("Insufficient data");
    expect(stdout).toContain("Practice heatmap");
    expect(stdout).toContain("Team stats");
    expect(stdout).toMatch(/Slack\s+2 \/ 5\s+reads, writes/);
  });

  it("renders each disabled view with its reason and no zeros", async () => {
    reply = ok(ALL_OFF);
    const { stdout } = await cli(manager, "insights", "--team");
    expect(stdout).toContain("Adoption funnel: not enough sessions yet to say anything");
    expect(stdout).toContain("Judgement signals: off for your tenant");
    expect(stdout).not.toMatch(/\b0\b/);
  });

  it("ignores a section, a view and a key it does not know", async () => {
    reply = ok({
      ...WINDOW_90,
      future_top_level: { a: 1 },
      sections: {
        ...WINDOW_90.sections,
        retention: { enabled: true, rows: [1, 2] },
        judgement_signals: { ...WINDOW_90.sections.judgement_signals, new_view: { enabled: true } },
      },
    });
    const { stdout, status } = await cli(manager, "insights", "--team");
    expect(status).toBe(0);
    expect(stdout).toContain("Signals by engineer");
    expect(stdout).not.toMatch(/retention|new_view|future/);
  });
});

describe("pheebs insights --team: refusals", () => {
  async function fail(status: number, body = '{"error":"x"}') {
    reply = { status, body };
    const result = await cli(manager, "insights", "--team");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    return result.stderr;
  }

  it("says plainly that a 403 is a role matter and who can fix it", async () => {
    const stderr = await fail(403, '{"error":"Forbidden"}');
    expect(stderr).toContain("not a manager's");
    expect(stderr).toContain("Ask an admin for a manager token");
    expect(stderr).not.toContain("config set token");
  });

  it("reports a 401 as a rejected token", async () => {
    expect(await fail(401, '{"error":"Unauthorized"}')).toContain("token was rejected");
  });

  it("reports a 404 as a route this backend does not serve", async () => {
    expect(await fail(404)).toContain("This backend does not serve /insights/team.");
  });

  it("reports the status for a 500 without leaking the body", async () => {
    const stderr = await fail(500, "relation dev_tokens does not exist");
    expect(stderr).toContain("The backend answered 500.");
    expect(stderr).not.toContain("dev_tokens");
  });

  it("names a missing token rather than calling out", async () => {
    const { status, stderr } = await cli(home(null), "insights", "--team");
    expect(status).toBe(1);
    expect(stderr).toContain("config set token");
    expect(requests).toEqual([]);
  });
});

describe("--help and the cached role", () => {
  it("mentions --team to a manager only", async () => {
    expect((await cli(manager, "--help")).stdout).toContain("--team");
    expect((await cli(engineer, "--help")).stdout).not.toContain("--team");
    expect((await cli(home({ token: TOKEN }), "--help")).stdout).not.toContain("--team");
    expect((await cli(home(null), "--help")).stdout).not.toContain("--team");
  });

  it("does not touch the backend to decide", async () => {
    await cli(manager, "--help");
    expect(requests).toEqual([]);
  });
});
