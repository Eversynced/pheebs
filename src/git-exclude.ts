import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Keep a token-bearing config file out of git.
 *
 * A project-scoped install writes the Bearer token into the repo (`.claude/settings.local.json`,
 * `.codex/config.toml`). Nothing in a fresh repo ignores the Codex path, so a `git add -A`
 * commits the token, and on a public repo that is a leak with no way back.
 *
 * `.git/info/exclude` rather than `.gitignore`: ignoring a file is the developer's decision
 * about their own repo, and an entry there is local and uncommitted, so pheebs is not editing
 * a tracked file to protect itself.
 *
 * Every answer this module gives is checked against git rather than inferred, because the
 * caller turns it into a promise to the developer ("it is not committed"). A wrong yes is
 * worse than a no: it is the sentence that stops them looking.
 */

const HEADER = "# added by pheebs: this file carries your pheebs token";

/** `excluded` and `ignored` mean git will not commit the file. The rest all mean it might. */
export type ExcludeOutcome = "excluded" | "ignored" | "tracked" | "no-repo" | "unprotected";

type GitResult = { ok: true; stdout: string } | { ok: false; missing: boolean };

/** `missing` separates "git is not installed" from "git answered no", because the first
 *  cannot be read as an all-clear and the second can. */
function git(cwd: string, ...args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, missing: (err as { code?: string }).code === "ENOENT" };
  }
}

/** True when git already ignores the path by some rule the developer or a tool already set. */
function alreadyIgnored(path: string): boolean {
  return git(dirname(path), "check-ignore", "-q", "--", path).ok;
}

/** An ignore rule has no effect on a tracked file, and `check-ignore` will not say so: it
 *  skips tracked paths, so silence there is not an all-clear. */
function isTracked(path: string): boolean {
  return git(dirname(path), "ls-files", "--error-unmatch", "--", path).ok;
}

/** gitignore treats these as glob syntax, so a repo directory named `pkg[beta]` yields a
 *  pattern that misses the token file and quietly matches an unrelated `pkgb/` instead. */
function escapePattern(value: string): string {
  return value.replace(/[\\*?[\]]/g, (char) => `\\${char}`);
}

/**
 * Add `path` to the repo's `.git/info/exclude`.
 *
 * `excluded`: an entry was added and git confirms the file is now ignored.
 * `ignored`: some rule already covered it, so nothing was written.
 * `tracked`: git tracks the file, which no ignore rule can undo.
 * `no-repo`: there is no repository, so there is nothing to be committed into.
 * `unprotected`: there is a repository but the file is still committable.
 */
export function excludeFromGit(path: string): ExcludeOutcome {
  if (alreadyIgnored(path)) return "ignored";
  if (isTracked(path)) return "tracked";

  const cwd = dirname(path);

  // The common dir, not `--absolute-git-dir`: in a linked worktree the latter points at
  // `.git/worktrees/<name>`, and git reads `info/exclude` only from the common dir, so an
  // entry written there is never applied.
  const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  // Ask git for the path rather than deriving it: `--show-toplevel` is realpath'd, so
  // subtracting it from an un-resolved path mismatches through a symlinked checkout.
  const prefix = git(cwd, "rev-parse", "--show-prefix");

  if (!commonDir.ok || !prefix.ok) {
    // git answering "not a repository" means nothing can commit the file. git not being
    // installed means we cannot tell, which must not be reported as safe.
    const gitMissing = (!commonDir.ok && commonDir.missing) || (!prefix.ok && prefix.missing);
    return gitMissing ? "unprotected" : "no-repo";
  }

  const pattern = `/${escapePattern(`${prefix.stdout}${basename(path)}`)}`;
  const excludePath = `${commonDir.stdout}/info/exclude`;

  try {
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    if (!existing.split("\n").some((line) => line.trim() === pattern)) {
      const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
      mkdirSync(`${commonDir.stdout}/info`, { recursive: true });
      appendFileSync(excludePath, `${separator}${HEADER}\n${pattern}\n`);
    }
  } catch {
    return "unprotected";
  }

  // Confirm with git rather than trusting the write: the pattern is the caller's evidence
  // for telling the developer the token is safe.
  return alreadyIgnored(path) ? "excluded" : "unprotected";
}

/**
 * Act on that outcome: keep the file out of git where possible, and say so where not.
 * Silent only for `ignored` and `no-repo`, the two answers that mean git will not commit it.
 * Shared, because a token written by the OTel resync is exactly as committable as one written
 * by `init`, and the developer should hear the same thing.
 */
export function protectToken(settingsPath: string, warn: (message: string) => void): void {
  const carries = `${settingsPath} carries your pheebs token`;

  switch (excludeFromGit(settingsPath)) {
    case "excluded":
      warn(`${carries}. Added it to .git/info/exclude so it is not committed.`);
      break;
    case "tracked":
      warn(
        `${carries} and git already tracks that file, which no ignore rule undoes. Run \`git rm --cached ${settingsPath}\` to stop committing it.`,
      );
      break;
    case "unprotected":
      warn(`${carries} and git does not ignore it. Add it to .gitignore before committing.`);
      break;
  }
}
