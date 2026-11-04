import { describe, expect, it } from "vitest";
import { classifyIntent, classifyShellCommand, classifyVcsAction } from "../src/hooks/intent.js";

describe("classifyShellCommand", () => {
  it("classifies test runners", () => {
    expect(classifyShellCommand("pytest tests/")).toBe("test_run");
    expect(classifyShellCommand("go test ./...")).toBe("test_run");
    expect(classifyShellCommand("npm run test")).toBe("test_run");
    expect(classifyShellCommand("vitest")).toBe("test_run");
  });

  it("classifies build commands", () => {
    expect(classifyShellCommand("make build")).toBe("build");
    expect(classifyShellCommand("npm run build")).toBe("build");
    expect(classifyShellCommand("cargo build --release")).toBe("build");
  });

  it("classifies type-check commands", () => {
    expect(classifyShellCommand("tsc --noEmit")).toBe("typecheck");
    expect(classifyShellCommand("mypy src/")).toBe("typecheck");
    expect(classifyShellCommand("pyright")).toBe("typecheck");
    expect(classifyShellCommand("cargo check")).toBe("typecheck");
  });

  it("classifies lint commands", () => {
    expect(classifyShellCommand("eslint . --fix")).toBe("lint");
    expect(classifyShellCommand("ruff check src")).toBe("lint");
    expect(classifyShellCommand("flake8")).toBe("lint");
    expect(classifyShellCommand("cargo clippy -- -D warnings")).toBe("lint");
    expect(classifyShellCommand("golangci-lint run")).toBe("lint");
    expect(classifyShellCommand("rubocop -a")).toBe("lint");
  });

  it("distinguishes cargo subcommands across the verification family", () => {
    expect(classifyShellCommand("cargo test")).toBe("test_run");
    expect(classifyShellCommand("cargo build --release")).toBe("build");
    expect(classifyShellCommand("cargo check")).toBe("typecheck");
    expect(classifyShellCommand("cargo clippy")).toBe("lint");
  });

  it("classifies version control commands", () => {
    expect(classifyShellCommand("git status")).toBe("vcs");
    expect(classifyShellCommand("gh pr create")).toBe("vcs");
  });

  it("strips leading env assignments and sudo", () => {
    expect(classifyShellCommand("CI=1 pytest")).toBe("test_run");
    expect(classifyShellCommand("FOO=bar BAZ=qux npm run build")).toBe("build");
    expect(classifyShellCommand("sudo make install")).toBe("build");
  });

  it("matches on token boundaries", () => {
    expect(classifyShellCommand("github-cli login")).toBe("other");
    expect(classifyShellCommand("makefile-lint")).toBe("other");
  });

  it("falls back to other for unmatched and compound commands", () => {
    expect(classifyShellCommand("ls -la")).toBe("other");
    expect(classifyShellCommand("npm install")).toBe("other");
    expect(classifyShellCommand("cd src && ls")).toBe("other");
  });

  it("classifies commands carrying flags and arguments", () => {
    expect(classifyShellCommand('pytest tests/unit -v --maxfail=1 -k "not slow"')).toBe("test_run");
    expect(classifyShellCommand("go test ./... -run TestParse -count=1")).toBe("test_run");
    expect(classifyShellCommand("cargo build --release --target wasm32-unknown-unknown")).toBe(
      "build",
    );
    expect(classifyShellCommand("git push origin HEAD:refs/for/main")).toBe("vcs");
  });

  it("strips stacked env assignments, sudo, and package runners together", () => {
    expect(classifyShellCommand("CI=1 NODE_ENV=test npm run test")).toBe("test_run");
    expect(classifyShellCommand("FOO=bar BAZ=qux sudo pytest")).toBe("test_run");
    expect(classifyShellCommand("npx vitest run")).toBe("test_run");
    expect(classifyShellCommand("npx jest --coverage")).toBe("test_run");
    expect(classifyShellCommand("bunx tsc --noEmit")).toBe("typecheck");
  });

  it("strips language runners so test suites under them resolve", () => {
    expect(classifyShellCommand("python -m pytest")).toBe("test_run");
    expect(classifyShellCommand("python3 -m pytest tests/")).toBe("test_run");
    expect(classifyShellCommand("uv run pytest")).toBe("test_run");
    expect(classifyShellCommand("poetry run pytest -k smoke")).toBe("test_run");
    // Non-test invocations behind the same runners stay `other`.
    expect(classifyShellCommand("uv run python app.py")).toBe("other");
    expect(classifyShellCommand("python script.py")).toBe("other");
  });

  it("matches package-script names with separators and run variants", () => {
    expect(classifyShellCommand("npm run test:unit")).toBe("test_run");
    expect(classifyShellCommand("npm run build:prod")).toBe("build");
    expect(classifyShellCommand("pnpm run build")).toBe("build");
    expect(classifyShellCommand("yarn run test")).toBe("test_run");
    expect(classifyShellCommand("make test")).toBe("test_run");
  });

  it("classifies by the leading token only (no shell parsing)", () => {
    // First token wins; commands behind cd/&& or an absolute path stay `other`.
    expect(classifyShellCommand("./node_modules/.bin/jest")).toBe("other");
    expect(classifyShellCommand("/usr/bin/python -m pytest")).toBe("other");
    expect(classifyShellCommand("docker build -t img .")).toBe("other");
  });
});

describe("classifyIntent", () => {
  it("maps read and edit tool names", () => {
    expect(classifyIntent("Read")).toBe("read");
    expect(classifyIntent("Grep")).toBe("read");
    expect(classifyIntent("Edit")).toBe("edit");
    expect(classifyIntent("Write")).toBe("edit");
  });

  it("classifies shell tools by their command", () => {
    expect(classifyIntent("Bash", "pytest")).toBe("test_run");
    expect(classifyIntent("Shell", "git push")).toBe("vcs");
    expect(classifyIntent("PowerShell", "npm test")).toBe("test_run");
    expect(classifyIntent("Bash")).toBe("other");
  });

  it("returns other for unknown tools and missing names", () => {
    expect(classifyIntent("WebFetch")).toBe("other");
    expect(classifyIntent(undefined)).toBe("other");
  });
});

describe("classifyVcsAction", () => {
  it("classifies the write actions that close work", () => {
    expect(classifyVcsAction("git commit -m 'fix'")).toBe("commit");
    expect(classifyVcsAction("git push origin HEAD")).toBe("push");
    expect(classifyVcsAction("gh pr create --fill")).toBe("pr_create");
  });

  it("treats read-only and non-closing VCS as other", () => {
    expect(classifyVcsAction("git status")).toBe("other");
    expect(classifyVcsAction("git log --oneline")).toBe("other");
    expect(classifyVcsAction("git diff HEAD~1")).toBe("other");
    expect(classifyVcsAction("git add -A")).toBe("other");
    expect(classifyVcsAction("gh pr view 42")).toBe("other");
  });

  it("picks the strongest action across a chained command", () => {
    expect(classifyVcsAction("git add -A && git commit -m 'wip'")).toBe("commit");
    expect(classifyVcsAction("git commit -m 'x' && git push")).toBe("push");
    expect(classifyVcsAction("git commit -am 'x' && git push && gh pr create --fill")).toBe(
      "pr_create",
    );
  });

  it("strips leading wrappers before matching", () => {
    expect(classifyVcsAction("sudo git push")).toBe("push");
    expect(classifyVcsAction("GIT_EDITOR=true git commit")).toBe("commit");
  });

  it("matches on token boundaries", () => {
    // A word that merely starts with `push`/`commit` is not the git subcommand.
    expect(classifyVcsAction("git pushd")).toBe("other");
    expect(classifyVcsAction("git stash")).toBe("other");
  });
});

describe("classifyShellCommand on chained commands", () => {
  // Agents run checks from another directory or after an inline edit, in one command line.
  it("finds a check after a cd", () => {
    expect(classifyShellCommand("cd /repo && npm test")).toBe("test_run");
    expect(classifyShellCommand("cd src && go test ./...")).toBe("test_run");
    expect(classifyShellCommand("cd app; npx tsc --noEmit")).toBe("typecheck");
  });

  it("finds a check after an inline edit", () => {
    expect(classifyShellCommand("sed -i 's/a/b/' f.ts && npx vitest run")).toBe("test_run");
    expect(classifyShellCommand("git stash && npm test && git stash pop")).toBe("test_run");
  });

  it("finds a check inside a subshell", () => {
    expect(classifyShellCommand("(npx tsc --noEmit)")).toBe("typecheck");
  });

  it("keeps a chain with no check on its other tags", () => {
    expect(classifyShellCommand("cd repo && git commit -m x")).toBe("vcs");
    expect(classifyShellCommand("cat f.txt | grep x")).toBe("other");
  });
});

describe("classifyShellCommand on added tools", () => {
  it("classifies script-runner checks", () => {
    expect(classifyShellCommand("npm run lint")).toBe("lint");
    expect(classifyShellCommand("pnpm run lint")).toBe("lint");
    expect(classifyShellCommand("yarn lint")).toBe("lint");
    expect(classifyShellCommand("npm run typecheck")).toBe("typecheck");
    expect(classifyShellCommand("bun test")).toBe("test_run");
  });

  it("classifies biome and uvx-run tools", () => {
    expect(classifyShellCommand("npx biome check .")).toBe("lint");
    expect(classifyShellCommand("biome ci")).toBe("lint");
    expect(classifyShellCommand("uvx ruff check")).toBe("lint");
  });

  it("classifies Swift, Xcode, .NET and Terraform checks", () => {
    expect(classifyShellCommand("swift test")).toBe("test_run");
    expect(classifyShellCommand("swift build")).toBe("build");
    expect(classifyShellCommand("xcodebuild -scheme App test")).toBe("build");
    expect(classifyShellCommand("dotnet test")).toBe("test_run");
    expect(classifyShellCommand("terraform validate")).toBe("typecheck");
    expect(classifyShellCommand("tflint")).toBe("lint");
  });
});

describe("classifyShellCommand ignores separators inside quoted text", () => {
  // A commit message or an inline script is text the command carries, not a command it runs.
  it("keeps a commit whose message reads like a command", () => {
    expect(classifyShellCommand('git commit -m "fix: make lint pass; npm test later"')).toBe("vcs");
    expect(
      classifyShellCommand(
        "git commit -F - <<'EOF'\nfix(intent): split chains\n\nmake the tagger see each segment\nEOF",
      ),
    ).toBe("vcs");
  });

  it("does not read an inline script as a check", () => {
    expect(classifyShellCommand("node -e 'run(); tsc()'")).toBe("other");
    expect(classifyShellCommand('python3 -c "import x; pytest"')).toBe("other");
  });

  it("still finds a check outside the quoted text", () => {
    expect(classifyShellCommand('git commit -m "wip; make it work" && npm test')).toBe("test_run");
  });
});

describe("classifyVcsAction ignores separators inside quoted text", () => {
  it("does not read a push out of a commit message", () => {
    expect(classifyVcsAction('git commit -m "wip && git push"')).toBe("commit");
    expect(classifyVcsAction("git commit -F - <<'EOF'\nnote\ngit push\nEOF")).toBe("commit");
  });
});

describe("classification time on adversarial commands", () => {
  const MAX_MS = 1000;
  const inputs: Record<string, string> = {
    "unterminated double quote full of escaped quotes": `"${'a\\"'.repeat(50_000)}`,
    "unterminated heredoc openers": `${"cat <<EOF\n".repeat(5_000)}x`,
    "plain newlines": "\n".repeat(200_000),
    "stray apostrophes": "'".repeat(220_000),
  };

  for (const [name, command] of Object.entries(inputs)) {
    it(`finishes quickly on ${name}`, () => {
      const start = performance.now();
      classifyShellCommand(command);
      classifyVcsAction(command);
      expect(performance.now() - start).toBeLessThan(MAX_MS);
    });
  }
});
