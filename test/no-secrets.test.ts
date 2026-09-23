import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The public client must ship no backend secret or hardcoded backend host: only the
// per-developer token (entered at runtime) and the endpoint config. This guards against a
// regression that re-introduces the Supabase anon key, the Grafana OTLP credential, or the
// backend host that used to ship as a default.
const FORBIDDEN = [/supabase\.co/, /sb_publishable/, /glc_/, /grafana\.net/, /workers\.dev/];

// `dist/` is what npm actually publishes, and tsc does not remove output for source files that
// were deleted — a stale artifact once carried the Supabase URL and key long after the source
// was gone. Scanning src/ alone would not have caught it.
const ROOTS = ["src", "dist"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|cjs|mjs|map)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no shipped secrets", () => {
  it.each(ROOTS)("%s contains no backend credential or hardcoded backend host", (root) => {
    if (!existsSync(root)) {
      return; // dist/ is absent until a build runs; CI builds before packing
    }
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const content = readFileSync(file, "utf-8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content)) offenders.push(`${file} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("publishes no build artifact whose source has been deleted", () => {
    if (!existsSync("dist")) {
      return;
    }
    const orphans = sourceFiles("dist")
      .filter((f) => f.endsWith(".js"))
      .filter((f) => !existsSync(`${f.replace(/^dist\//, "src/").replace(/\.js$/, "")}.ts`));
    expect(orphans).toEqual([]);
  });
});
