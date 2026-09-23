import { describe, expect, it } from "vitest";
import {
  parseInsightsArgs,
  resolveRenderOptions,
  supportsBlockGlyphs,
} from "../src/commands/insights.js";

describe("supportsBlockGlyphs", () => {
  it("trusts a UTF-8 locale", () => {
    expect(supportsBlockGlyphs({ LANG: "en_US.UTF-8" }, "linux")).toBe(true);
    expect(supportsBlockGlyphs({}, "darwin")).toBe(true);
  });

  it("falls back on a non-UTF-8 locale", () => {
    expect(supportsBlockGlyphs({ LANG: "C" }, "linux")).toBe(false);
    expect(supportsBlockGlyphs({ LC_ALL: "en_US.ISO-8859-1" }, "linux")).toBe(false);
  });

  it("honours the locale precedence POSIX defines", () => {
    expect(supportsBlockGlyphs({ LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
    expect(supportsBlockGlyphs({ LC_ALL: "en_US.UTF-8", LANG: "C" }, "linux")).toBe(true);
  });

  it("falls back on Windows, where a legacy console cannot be told from a capable one", () => {
    expect(supportsBlockGlyphs({}, "win32")).toBe(false);
  });

  it("trusts the Windows terminals that do render block glyphs", () => {
    expect(supportsBlockGlyphs({ WT_SESSION: "1" }, "win32")).toBe(true);
    expect(supportsBlockGlyphs({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
  });
});

describe("resolveRenderOptions", () => {
  it("assumes 80 columns when stdout is not a terminal", () => {
    expect(resolveRenderOptions({}, "linux", undefined).width).toBe(80);
    expect(resolveRenderOptions({}, "linux", 0).width).toBe(80);
  });

  it("uses the terminal's own width when there is one", () => {
    expect(resolveRenderOptions({}, "linux", 120).width).toBe(120);
    expect(resolveRenderOptions({}, "linux", 45).width).toBe(45);
  });
});

describe("parseInsightsArgs", () => {
  it("defers the window to the backend when no flag is given", () => {
    expect(parseInsightsArgs([])).toEqual({ ok: true, json: false });
  });

  // Accepting only one spelling would silently report a window the developer did not ask for.
  it("accepts both spellings of --days", () => {
    expect(parseInsightsArgs(["--days", "7"])).toEqual({ ok: true, days: 7, json: false });
    expect(parseInsightsArgs(["--days=7"])).toEqual({ ok: true, days: 7, json: false });
  });

  it("reads --json alongside a window", () => {
    expect(parseInsightsArgs(["--json"])).toEqual({ ok: true, json: true });
    expect(parseInsightsArgs(["--days=30", "--json"])).toEqual({ ok: true, days: 30, json: true });
  });

  it("refuses a window the contract does not allow", () => {
    for (const args of [
      ["--days", "0"],
      ["--days", "366"],
      ["--days", "abc"],
      ["--days", "1.5"],
      ["--days", "-3"],
      ["--days"],
      ["--days="],
      ["--days=0"],
      ["--days=abc"],
      ["--days", "--json"],
    ]) {
      const parsed = parseInsightsArgs(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("whole number of days");
    }
  });

  it("takes the contract's bounds as inclusive", () => {
    expect(parseInsightsArgs(["--days=1"])).toEqual({ ok: true, days: 1, json: false });
    expect(parseInsightsArgs(["--days=365"])).toEqual({ ok: true, days: 365, json: false });
  });
});
