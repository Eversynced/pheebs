import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CODEBOOK, CODEBOOK_VERSION } from "../src/codebook.js";

const PINNED: Record<string, string> = {
  cb3: "f7e9bdc463426e6b4b23cd7bfc2f101a28a0aeaab62e488e9cd1659f5f634013",
};

describe("codebook", () => {
  it("matches the hash pinned for its version", () => {
    const hash = createHash("sha256").update(CODEBOOK).digest("hex");
    expect(PINNED[CODEBOOK_VERSION]).toBe(hash);
  });
});
