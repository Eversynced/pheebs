import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excludeFromGit } from "../src/git-exclude.js";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function excludeFile(): string {
  return readFileSync(join(repo, ".git", "info", "exclude"), "utf-8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pheebs-exclude-"));
  git("init", "-q");
  mkdirSync(join(repo, ".codex"), { recursive: true });
  writeFileSync(join(repo, ".codex", "config.toml"), "");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("excludeFromGit", () => {
  it("excludes a path git would otherwise commit", () => {
    const target = join(repo, ".codex", "config.toml");

    expect(excludeFromGit(target)).toBe("excluded");
    expect(excludeFile()).toContain("/.codex/config.toml");

    // the point of the exercise: git no longer offers to commit it
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
    expect(status).not.toContain(".codex");
  });

  it("is idempotent: a second init does not duplicate the entry", () => {
    const target = join(repo, ".codex", "config.toml");

    excludeFromGit(target);
    expect(excludeFromGit(target)).toBe("ignored");

    const entries = excludeFile()
      .split("\n")
      .filter((l) => l.trim() === "/.codex/config.toml");
    expect(entries).toHaveLength(1);
  });

  it("reports a path .gitignore already covers as ignored, writing nothing", () => {
    writeFileSync(join(repo, ".gitignore"), ".codex/\n");
    const target = join(repo, ".codex", "config.toml");

    expect(excludeFromGit(target)).toBe("ignored");
    expect(excludeFile()).not.toContain(".codex");
  });

  it("refuses to claim protection for a file git already tracks", () => {
    // No ignore rule undoes tracking, and check-ignore stays silent about it, so the naive
    // answer here is a false all-clear on a file that is committed with every `git add -A`.
    const target = join(repo, ".codex", "config.toml");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tracked");

    expect(excludeFromGit(target)).toBe("tracked");

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
    expect(status).not.toContain("?? .codex");
  });

  it("writes where git actually reads from inside a linked worktree", () => {
    // `--absolute-git-dir` points at .git/worktrees/<name>, but info/exclude is only read
    // from the common dir, so an entry written there would never apply.
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty");
    const linked = join(repo, "..", `${basename(repo)}-linked`);
    git("worktree", "add", "-q", linked);
    mkdirSync(join(linked, ".codex"), { recursive: true });
    writeFileSync(join(linked, ".codex", "config.toml"), "");

    expect(excludeFromGit(join(linked, ".codex", "config.toml"))).toBe("excluded");

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: linked,
      encoding: "utf-8",
    });
    expect(status).not.toContain(".codex");
    rmSync(linked, { recursive: true, force: true });
  });

  it("escapes glob characters instead of hiding an unrelated file", () => {
    // An unescaped `/pkg[beta]/...` misses the token file and matches `pkgb/...` instead,
    // so the token stays committable while a file pheebs never touched vanishes.
    for (const dir of ["pkg[beta]", "pkgb"]) {
      mkdirSync(join(repo, dir, ".codex"), { recursive: true });
      writeFileSync(join(repo, dir, ".codex", "config.toml"), "");
    }

    expect(excludeFromGit(join(repo, "pkg[beta]", ".codex", "config.toml"))).toBe("excluded");

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
    expect(status).toContain("pkgb/");
  });

  it("reports no-repo outside a repo, rather than throwing", () => {
    const loose = mkdtempSync(join(tmpdir(), "pheebs-norepo-"));
    // A tmpdir can sit inside someone's repo on a dev machine, so accept ignored too; the
    // point is that it neither throws nor claims the token is exposed.
    expect(["no-repo", "ignored"]).toContain(excludeFromGit(join(loose, "config.toml")));
    rmSync(loose, { recursive: true, force: true });
  });
});
