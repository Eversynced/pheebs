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

  it("documents the subagent model fields an Agent call carries", () => {
    expect(spec).toContain("\n        subagent_model:\n");
    expect(spec).toContain("\n        requested_model:\n");
  });

  it("carries the version that introduced session_token_usage", () => {
    expect(spec).toContain('\n  version: "1.10.0"\n');
  });

  it("documents the fields a session_token_usage event carries", () => {
    for (const field of ["reasoning_tokens", "from_subagent", "usage_source"]) {
      expect(spec).toContain(`\n        ${field}:\n`);
    }
    expect(spec).toContain("\n            - session_token_usage\n");
    expect(spec).toContain("\n          const: transcript\n");
    expect(
      readFileSync(join(import.meta.dirname, "..", "docs", "backend-contract.md"), "utf-8"),
    ).toContain("Contract 1.10.0");
  });

  it("says input_tokens leaves out cache reads and cache writes, and how the total is formed", () => {
    const total = "input_tokens + cache_read_tokens + cache_write_tokens";
    const doc = readFileSync(
      join(import.meta.dirname, "..", "docs", "backend-contract.md"),
      "utf-8",
    );
    expect(spec).toContain(total);
    expect(doc).toContain(total);
  });

  it("documents command_sequence beside the fields a chain changes", () => {
    expect(spec).toContain("\n        command_sequence:\n");
  });

  it("documents the batch route and the id it deduplicates on", () => {
    expect(spec).toContain("\n  /ingest/batch:\n");
    expect(spec).toContain("\n        event_id:\n");
  });
});
