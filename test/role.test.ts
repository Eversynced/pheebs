import { describe, expect, it } from "vitest";
import { classifyRole } from "../src/hooks/role.js";

describe("classifyRole", () => {
  it("maps the code-reviewer agent to review", () => {
    expect(classifyRole("code-reviewer")).toBe("review");
  });

  it("maps generation/execution agents to generate", () => {
    expect(classifyRole("general-purpose")).toBe("generate");
    expect(classifyRole("Explore")).toBe("generate");
    expect(classifyRole("explorer")).toBe("generate");
    expect(classifyRole("Plan")).toBe("generate");
    expect(classifyRole("claude-code-guide")).toBe("generate");
  });

  it("is case-insensitive", () => {
    expect(classifyRole("Code-Reviewer")).toBe("review");
    expect(classifyRole("GENERAL-PURPOSE")).toBe("generate");
  });

  it("defaults unknown agents to generate, including unlisted reviewer-like names", () => {
    expect(classifyRole("test-writer")).toBe("generate");
    expect(classifyRole("custom-agent")).toBe("generate");
    // Table-only: custom reviewer agents are NOT inferred from the name; they
    // must be added to AGENT_ROLES explicitly.
    expect(classifyRole("security-review")).toBe("generate");
    expect(classifyRole("pr-critic")).toBe("generate");
    // No false positives from substring matches on generation agents.
    expect(classifyRole("review-summarizer")).toBe("generate");
    expect(classifyRole("pr-critic-responder")).toBe("generate");
  });
});
