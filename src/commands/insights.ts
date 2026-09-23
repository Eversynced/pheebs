import { fetchInsights } from "../insights.js";
import { escapeControlChars, normalize } from "../insights-normalize.js";
import { type RenderOptions, renderInsights } from "../insights-render.js";

type Env = Record<string, string | undefined>;

const MIN_DAYS = 1;
const MAX_DAYS = 365;

// Windows outside Windows Terminal and VS Code is the case that matters: a legacy console prints
// replacement characters instead of block glyphs and cannot be told apart from a capable one.
export function supportsBlockGlyphs(env: Env, platform: string): boolean {
  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode") return true;
  if (platform === "win32") return false;

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !locale || /UTF-?8/i.test(locale);
}

export function resolveRenderOptions(
  env: Env,
  platform: string,
  columns: number | undefined,
): RenderOptions {
  // No columns means the output is not a terminal (piped, redirected, a CI log), and 80 is the
  // width that is safe to assume rather than a width to stretch to.
  return {
    width: columns && columns > 0 ? columns : 80,
    ascii: !supportsBlockGlyphs(env, platform),
  };
}

export type InsightsArgs =
  | { ok: true; days?: number; json: boolean }
  | { ok: false; error: string };

// Both `--days 7` and `--days=7` are accepted: silently ignoring one form would report a window
// the developer did not ask for.
export function parseInsightsArgs(args: string[]): InsightsArgs {
  let days: number | undefined;
  let json = false;

  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--days" || arg.startsWith("--days=")) {
      const raw = arg.startsWith("--days=") ? arg.slice("--days=".length) : args[++at];
      const parsed = Number(raw);
      if (!raw || !Number.isInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
        return {
          ok: false,
          error: `--days takes a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`,
        };
      }
      days = parsed;
      continue;
    }
    // A mistyped flag that runs anyway reports a window the developer did not ask for, so it is
    // rejected the way `config` rejects an unknown key.
    return { ok: false, error: `unknown option "${arg}". Run \`pheebs --help\` for the list.` };
  }

  return { ok: true, days, json };
}

export async function runInsights(args: string[]): Promise<void> {
  const parsed = parseInsightsArgs(args);
  if (!parsed.ok) {
    console.error(`pheebs: ${parsed.error}`);
    process.exit(1);
  }

  const result = await fetchInsights(parsed.days);
  if (!result.ok) {
    console.error(`pheebs: ${result.error}`);
    process.exit(1);
  }

  if (parsed.json) {
    // The body verbatim except that control characters inside its strings are escaped. A C1
    // control is legal raw inside a JSON string, and printing one hands a hostile backend the
    // terminal the render path denies it; escaping leaves the parsed value and key order intact.
    process.stdout.write(escapeControlChars(result.body));
    if (!result.body.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  const opts = resolveRenderOptions(process.env, process.platform, process.stdout.columns);
  console.log(renderInsights(normalize(result.payload), opts).join("\n"));
}
