import { describe, expect, it } from "vitest";
import { canonicalModel } from "../src/repertoire.js";

describe("canonicalModel", () => {
  it.each([
    ["claude-opus-5[1m]", "claude-opus-5"],
    ["claude-sonnet-5-20260101", "claude-sonnet-5"],
    ["cursor-grok-4.5-high", "grok-4.5"],
    ["grok-4.7", "grok-4.7"],
    ["grok-4.7-high", "grok-4.7"],
    ["grok-4.7-mxfp8-high", "grok-4.7"],
    ["cursor-grok-4.6-high-fast", "grok-4.6"],
    ["cursor-grok-4.6-xhigh", "grok-4.6"],
    ["cursor-grok-4.6-low", "grok-4.6"],
    ["gpt-5-codex-medium", "gpt-5-codex"],
  ])("merges %s into %s", (spelling, model) => {
    expect(canonicalModel(spelling)).toBe(model);
  });

  it.each([
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-fable-5-2",
    "gpt-5-codex",
  ])("leaves %s unchanged", (id) => {
    expect(canonicalModel(id)).toBe(id);
  });

  it.each([
    "default",
    "Default",
    "DEFAULT",
    "unknown",
    " unknown ",
    "",
  ])("reads %j as no model", (name) => {
    expect(canonicalModel(name)).toBeUndefined();
  });

  it("does not merge a name by guesswork", () => {
    expect(canonicalModel("grok-4.7-turbo")).toBe("grok-4.7-turbo");
    expect(canonicalModel("higher-model")).toBe("higher-model");
  });
});
