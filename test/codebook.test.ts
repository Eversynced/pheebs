import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODEBOOK,
  CODEBOOK_VERSION,
  SUBAGENT_CODEBOOK,
  SUBAGENT_CODEBOOK_VERSION,
  SUBAGENT_LABELS,
} from "../src/codebook.js";

const PINNED: Record<string, string> = {
  cb3: "f7e9bdc463426e6b4b23cd7bfc2f101a28a0aeaab62e488e9cd1659f5f634013",
};

const SUBAGENT_PINNED: Record<string, string> = {
  sb1: "f7904bec24f66a13f01fa0e624d75a72b91ff4e1fbbbe144ac90e61f5f7f6470",
};

describe("codebook", () => {
  it("matches the hash pinned for its version", () => {
    const hash = createHash("sha256").update(CODEBOOK).digest("hex");
    expect(PINNED[CODEBOOK_VERSION]).toBe(hash);
  });

  it("keeps the subagent codebook apart from the developer one and pins its hash", () => {
    const hash = createHash("sha256").update(SUBAGENT_CODEBOOK).digest("hex");
    expect(SUBAGENT_PINNED[SUBAGENT_CODEBOOK_VERSION]).toBe(hash);
    expect(SUBAGENT_CODEBOOK).not.toBe(CODEBOOK);
  });

  it("separates a review from a build, which the developer codebook folds into task", () => {
    expect(SUBAGENT_LABELS).toEqual(expect.arrayContaining(["review", "build"]));
    expect(SUBAGENT_LABELS).not.toContain("task");
  });
});
