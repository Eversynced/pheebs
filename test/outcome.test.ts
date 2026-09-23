import { describe, expect, it } from "vitest";
import { classifyCodexOutcome } from "../src/hooks/outcome.js";

describe("classifyCodexOutcome", () => {
  it("treats a zero exit code as passed", () => {
    expect(classifyCodexOutcome({ exit_code: 0 })).toBe("passed");
    expect(classifyCodexOutcome({ exitCode: 0 })).toBe("passed");
  });

  it("treats a non-zero exit code as failed", () => {
    expect(classifyCodexOutcome({ exit_code: 1 })).toBe("failed");
    expect(classifyCodexOutcome({ exitCode: 127 })).toBe("failed");
  });

  it("reads the MCP isError flag", () => {
    expect(classifyCodexOutcome({ isError: true })).toBe("failed");
    expect(classifyCodexOutcome({ isError: false })).toBe("passed");
  });

  it("reads a generic success flag", () => {
    expect(classifyCodexOutcome({ success: false })).toBe("failed");
    expect(classifyCodexOutcome({ success: true })).toBe("passed");
  });

  it("prefers an explicit exit code over other flags", () => {
    expect(classifyCodexOutcome({ exit_code: 1, isError: false })).toBe("failed");
  });

  it("returns undefined when there is no recognizable signal", () => {
    expect(classifyCodexOutcome({})).toBeUndefined();
    expect(classifyCodexOutcome({ stdout: "irrelevant" })).toBeUndefined();
    expect(classifyCodexOutcome(undefined)).toBeUndefined();
    expect(classifyCodexOutcome(null)).toBeUndefined();
    expect(classifyCodexOutcome("nope")).toBeUndefined();
    expect(classifyCodexOutcome(42)).toBeUndefined();
  });

  it("does not treat a non-numeric exit_code as a signal", () => {
    expect(classifyCodexOutcome({ exit_code: "0" })).toBeUndefined();
  });
});
