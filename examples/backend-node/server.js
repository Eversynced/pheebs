// A complete Pheebs backend in one file, with no dependencies. It implements the four required
// routes in ../../openapi.yaml so you can point a real client at something and watch events land,
// plus two optional ones: /ingest/batch, which the client's background sender uses, and
// /insights, whose sections all answer `enabled: false` because computing them needs data this
// server does not keep. The other optional route, /insights/team, is left
// unimplemented, which the contract expresses as a 404.
//
//   node examples/backend-node/server.js
//   pheebs config set base-url http://localhost:8787
//   pheebs config set token pheebs_local
//
// This is a teaching implementation: the token table is hardcoded and storage is a JSONL file,
// so do not deploy it. It is written defensively anyway, because the shapes here are the ones a
// reader lifts into a real backend — an unguarded lookup or an unhandled rejection copied into
// production is worse than no example at all.

import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
// Defaults outside the repo: this file holds real session metadata, and a bare relative path
// drops it in whatever directory the server was started from — one `git add -A` from committed.
const EVENTS_FILE = process.env.EVENTS_FILE ?? join(tmpdir(), "pheebs-events.jsonl");

// A prototype-less map. A plain object literal would resolve inherited keys, so a request with
// `Authorization: Bearer constructor` would authenticate — the single most copyable mistake in
// a file like this.
const TOKENS = new Map([
  [
    "pheebs_local",
    { id: "dev-local-1", developer: "local-dev", tenant: "local", prompt_collection: false },
  ],
  [
    "pheebs_local_consented",
    {
      id: "dev-local-2",
      developer: "local-dev-consented",
      tenant: "local",
      prompt_collection: true,
    },
  ],
]);

const REQUIRED_ENVELOPE_FIELDS = [
  "timestamp",
  "source",
  "event",
  "codebase",
  "ai_tool",
  "session_id",
  "version",
];

const MAX_BATCH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ids already stored, per identity. The client resends a batch it never saw acknowledged, so
// storing an id twice would count one event twice. Keyed by identity too, because the client picks
// the id: one token must not be able to claim another's ids, or probe whether they exist. Seeded
// from the file so a restart does not forget them.
const storedIds = new Set();
const idKey = (identityId, eventId) => `${identityId}\n${eventId}`;
try {
  for (const line of readFileSync(EVENTS_FILE, "utf8").split("\n")) {
    try {
      const row = JSON.parse(line);
      if (typeof row.event_id === "string") storedIds.add(idKey(row.developer, row.event_id));
    } catch {}
  }
} catch {}

function identityFor(token) {
  return typeof token === "string" ? TOKENS.get(token) : undefined;
}

function bearer(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body ?? {}));
}

// Values that arrived over the wire are quoted before they reach a terminal: raw ANSI escapes
// and newlines in a log line let a caller forge or overwrite the operator's console output.
function safe(value) {
  return JSON.stringify(String(value ?? ""));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8"); // else a multi-byte character split across chunks is corrupted
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        // Stop reading, don't just reject: without this the stream keeps filling `raw` after the
        // error, so the advertised cap bounds nothing. The caller answers 413 and then closes.
        req.removeAllListeners("data");
        req.pause();
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
      }
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        reject(new Error("invalid JSON"));
        return;
      }
      // `null`, a bare string, and an array all survive JSON.parse and then explode on property
      // access downstream.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(new Error("body must be a JSON object"));
        return;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

function ingest(req, res, body) {
  const identity = identityFor(bearer(req));
  if (!identity) return json(res, 401, { error: "unknown token" });

  const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => body[f] === undefined);
  if (missing.length > 0) {
    // The contract's 422: unprocessable envelope. Worth demonstrating rather than crashing.
    return json(res, 422, { error: "missing required fields", missing });
  }

  if (typeof body.event_id === "string" && storedIds.has(idKey(identity.id, body.event_id))) {
    return json(res, 202, { ok: true, duplicate: true });
  }

  // Identity is stamped here, from the token. The client strips `developer` before sending; if
  // it ever arrives anyway it is ignored, because trusting it would let any token claim any
  // identity.
  const { developer: _ignored, ...event } = body;
  const row = { ...event, developer: identity.id, received_at: new Date().toISOString() };

  try {
    appendFileSync(EVENTS_FILE, `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error(`ingest  write failed: ${safe(err.message)}`);
    return json(res, 500, { error: "could not store event" });
  }

  if (typeof row.event_id === "string") storedIds.add(idKey(identity.id, row.event_id));
  console.log(`ingest  ${safe(row.event)} ${safe(row.ai_tool)} ${safe(row.codebase)}`);
  return json(res, 202, { ok: true });
}

// Idempotent on event_id, because the client retries a batch it never saw acknowledged. Each
// envelope is judged on its own: a bad one is reported and the rest are still stored.
function ingestBatch(req, res, body) {
  const identity = identityFor(bearer(req));
  if (!identity) return json(res, 401, { error: "unknown token" });

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return json(res, 400, { error: "events must be a non-empty array" });
  }
  if (body.events.length > MAX_BATCH) {
    return json(res, 413, { error: `at most ${MAX_BATCH} events per batch` });
  }

  const receivedAt = new Date().toISOString();
  const rows = [];
  const inBatch = new Set();
  const rejected = [];
  let duplicates = 0;
  body.events.forEach((envelope, index) => {
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      rejected.push({ index, reason: "not_an_object" });
    } else if (REQUIRED_ENVELOPE_FIELDS.some((f) => envelope[f] === undefined)) {
      rejected.push({ index, reason: "missing_field" });
    } else if (typeof envelope.event_id !== "string" || !UUID.test(envelope.event_id)) {
      rejected.push({ index, reason: "invalid_event_id" });
    } else if (
      storedIds.has(idKey(identity.id, envelope.event_id)) ||
      inBatch.has(envelope.event_id)
    ) {
      duplicates += 1;
    } else {
      inBatch.add(envelope.event_id);
      const { developer: _ignored, ...event } = envelope;
      rows.push({ ...event, developer: identity.id, received_at: receivedAt });
    }
  });

  if (rows.length > 0) {
    try {
      appendFileSync(EVENTS_FILE, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
    } catch (err) {
      // Nothing was acknowledged, so the client retries the whole batch, and the ids it stored
      // before failing (none, for a single append) land as duplicates.
      console.error(`ingest  batch write failed: ${safe(err.message)}`);
      return json(res, 500, { error: "could not store events" });
    }
    for (const row of rows) storedIds.add(idKey(identity.id, row.event_id));
  }

  const dropped = Number(body.droppedSinceLastSend);
  console.log(
    `ingest  batch of ${body.events.length}: ${rows.length} stored, ${duplicates} duplicate, ` +
      `${rejected.length} rejected${dropped > 0 ? `, client dropped ${dropped}` : ""}`,
  );
  return json(res, 200, { accepted: rows.length, duplicates, rejected });
}

function validateToken(_req, res, body) {
  const identity = identityFor(body.token);
  if (!identity) {
    // A verdict, not a 5xx: the client reads 5xx as "backend unreachable" and keeps the token,
    // which is the opposite of a rejection. A 4xx works too — anything but 5xx.
    // Note the client does not read `allowed` on this route; omitting `id` is what rejects.
    return json(res, 200, { allowed: false, reason: "unknown" });
  }
  console.log(`validate ${safe(identity.developer)} consent=${identity.prompt_collection}`);
  return json(res, 200, { allowed: true, ...identity });
}

function classifyPrompt(req, res, body) {
  const identity = identityFor(bearer(req));
  if (!identity) return json(res, 401, { error: "unknown token" });

  // Consent is enforced again here. The client checks it too, but a client-side check is a
  // convenience, not a control — and the client's copy is cached, so this is the gate that can
  // actually revoke.
  if (!identity.prompt_collection) {
    console.log("classify refused — tenant has not consented to prompt collection");
    return json(res, 200, { allowed: false, reason: "no_consent" });
  }

  if (typeof body.prompt !== "string") {
    return json(res, 422, { error: "prompt must be a string" });
  }

  const label = fakeClassify(body.prompt);
  // The prompt is deliberately not logged or stored anywhere. A real backend puts a model call
  // here and holds that credential itself — the client ships none.
  console.log(`classify → ${safe(label)}`);

  return json(res, 200, {
    allowed: true,
    result: { label, requests_verification: /\b(test|verify)\b/i.test(body.prompt) },
  });
}

// Stands in for a model call. Keyword matching is not a classifier; it exists so the route
// returns a correctly shaped answer without needing an API key to try this out.
function fakeClassify(prompt) {
  const p = prompt.toLowerCase();
  if (/\b(fix|bug|error|broken|failing)\b/.test(p)) return "debug";
  if (/\b(explain|what|why|how does|understand)\b/.test(p)) return "understand";
  if (/\b(refactor|clean|rename|tidy)\b/.test(p)) return "refactor";
  if (/\b(test|spec|coverage)\b/.test(p)) return "test";
  if (/\b(plan|design|approach)\b/.test(p)) return "plan";
  return "implement";
}

// The optional route, and the shape worth copying even though this server computes nothing:
// sections are reported individually, and a section it cannot produce says so with a reason
// rather than a zero. A backend that answers `sections: {}` forever is still conformant.
function insights(req, res, url) {
  if (!identityFor(bearer(req))) return json(res, 401, { error: "unknown token" });

  // Report the window actually applied, not the one asked for, so the reader is never told a
  // number that was not used.
  // `Number(null)` and `Number("")` are both 0, so an absent parameter has to be caught before
  // the clamp, or "no window given" silently becomes the smallest legal one. An absurd but
  // readable number is out of range rather than unparseable, so `1e999` clamps like `99999` does.
  const raw = url.searchParams.get("days");
  const asked = raw ? Number(raw) : Number.NaN;
  const days = Number.isNaN(asked) ? 30 : Math.min(365, Math.max(1, Math.trunc(asked)));

  console.log(`insights days=${days} (nothing computed here)`);
  return json(res, 200, {
    days,
    sections: {
      repertoire: { enabled: false, reason: "not_implemented" },
      judgement_signals: { enabled: false, reason: "not_implemented" },
    },
  });
}

function otelProxy(req, res) {
  if (!identityFor(bearer(req))) return json(res, 401, { error: "unknown token" });
  // A real proxy forwards to an OTLP collector with the upstream credential swapped in. That
  // credential lives here precisely so it never ships to a developer machine. The client always
  // exports protobuf, so a real implementation must not assume JSON.
  console.log(`otel     ${safe(req.url)} (accepted, not forwarded)`);
  return json(res, 200, {});
}

const server = createServer((req, res) => {
  // Every handler runs inside this catch: one unhandled rejection would take the process down,
  // and a reader who copies the shape inherits a one-request denial of service.
  void handle(req, res).catch((err) => {
    console.error(`error   ${safe(err?.message)}`);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost"); // pathname without the query string

  // The insights routes are the only GETs in the contract; everything else is POST.
  if (url.pathname === "/insights" || url.pathname === "/insights/team") {
    req.resume(); // drain, or the socket is torn down instead of answered cleanly
    if (req.method !== "GET") return json(res, 405, { error: "GET only" }, { allow: "GET" });
    // 404 rather than 403: this server does not serve team views at all, and 403 would claim it
    // does and that this caller is not entitled to them.
    if (url.pathname === "/insights/team") {
      return json(res, 404, { error: "team views not implemented" });
    }
    return insights(req, res, url);
  }

  if (req.method !== "POST") {
    req.resume();
    return json(res, 405, { error: "POST only" }, { allow: "POST" });
  }

  if (url.pathname.startsWith("/otel/")) {
    req.resume(); // OTLP body is not parsed here
    return otelProxy(req, res);
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    // On the ingest routes an oversized body gets 413, which the batch sender answers by sending
    // less, and any other unusable body 400, which the client treats as final. An oversized body's
    // connection is closed rather than drained.
    const ingest = url.pathname === "/ingest" || url.pathname === "/ingest/batch";
    if (err.tooLarge) res.on("finish", () => req.destroy());
    const status = err.tooLarge && ingest ? 413 : ingest ? 400 : 422;
    return json(res, status, { error: String(err.message) }, err.tooLarge ? { connection: "close" } : {});
  }

  if (url.pathname === "/ingest") return ingest(req, res, body);
  if (url.pathname === "/ingest/batch") return ingestBatch(req, res, body);
  if (url.pathname === "/validate-token") return validateToken(req, res, body);
  if (url.pathname === "/classify-prompt") return classifyPrompt(req, res, body);

  return json(res, 404, { error: "no such route" });
}

// Loopback only. A teaching server with a hardcoded token table should never be reachable from
// another machine.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`pheebs reference backend on http://localhost:${PORT}`);
  console.log(`events → ${EVENTS_FILE}`);
  console.log("");
  console.log(`  pheebs config set base-url http://localhost:${PORT}`);
  console.log("  pheebs config set token pheebs_local");
  console.log("");
});
