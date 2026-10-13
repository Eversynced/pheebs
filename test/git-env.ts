import { execFileSync } from "node:child_process";

// A git hook runs with GIT_DIR (and in a worktree, more of git's repo variables) pointing at the
// repo being pushed. Every git call a test makes would inherit them and init, commit and write
// excludes in that repo instead of the test's temp dir, so they are dropped before any test runs.
const repoVars = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf-8" });
for (const name of repoVars.split("\n")) {
  if (name) delete process.env[name];
}
