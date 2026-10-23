import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENTS } from "../src/hooks/types.js";

const spec = readFileSync(join(import.meta.dirname, "..", "openapi.yaml"), "utf-8");

// The repo carries no YAML parser, so the envelope's `event` enum is read as the list of items
// under its `enum:` key. A self-hoster validating against this list rejects whatever is missing.
function envelopeEventEnum(): string[] {
  const block = spec.match(/\n {8}event:\n {10}type: string\n {10}enum:\n((?: {12}- \S+\n)+)/);
  if (!block) throw new Error("EventEnvelope.event enum not found");
  return block[1]
    .trim()
    .split("\n")
    .map((line) => line.trim().slice(2));
}

describe("openapi.yaml", () => {
  it("lists every event the client emits, and nothing else", () => {
    expect(envelopeEventEnum().sort()).toEqual(Object.values(EVENTS).sort());
  });

  it("carries the version that introduced the batch route", () => {
    expect(spec).toContain('\n  version: "1.4.0"\n');
  });

  it("documents the batch route and the id it deduplicates on", () => {
    expect(spec).toContain("\n  /ingest/batch:\n");
    expect(spec).toContain("\n        event_id:\n");
  });
});
