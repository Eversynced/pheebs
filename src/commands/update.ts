import { execFileSync } from "node:child_process";
import { intro, log, outro, spinner } from "@clack/prompts";
import { PHEEBS_VERSION } from "../version.js";

const PACKAGE = "pheebs";

// A registry resolves through whatever `.npmrc` names, so its answer is untrusted input. It is
// validated against this before it is used, and every call goes through execFileSync so no shell
// ever parses it — an unvalidated value reaching a shell would be arbitrary code execution.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// A registry that accepts the connection and never answers would otherwise hang the (detached,
// silent) update child indefinitely.
const VIEW_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 120_000;

function run(args: string[], timeout: number): string {
  return execFileSync("npm", args, {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout,
    killSignal: "SIGKILL",
  });
}

/** The registry's `latest`, or null when it is unreachable or answers with anything but a version. */
export function getLatestVersion(): string | null {
  try {
    const out = run(["view", PACKAGE, "version"], VIEW_TIMEOUT_MS).trim();
    return SEMVER.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * True only when `latest` is strictly ahead of `current`. Equality is not enough to decide: a
 * locally built or rolled-back version can be AHEAD of the registry, and installing on any
 * difference would downgrade it — once a day, forever, once the background check is enabled.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map(Number);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  // Same release: a prerelease is behind the release it precedes, never ahead.
  return latest.includes("-") === false && current.includes("-");
}

export async function runUpdate(): Promise<void> {
  intro("pheebs update");

  const current = PHEEBS_VERSION;
  log.info(`Current version: ${current}`);

  const s = spinner();
  s.start("Checking for updates…");

  const latest = getLatestVersion();
  if (!latest) {
    s.stop("Failed to check for updates");
    log.error("Could not reach the npm registry.");
    outro("✗ update failed");
    process.exit(1);
  }

  if (!isNewer(latest, current)) {
    s.stop("Already up to date");
    log.success(`v${current} is current (registry has v${latest}).`);
    outro("✓ nothing to do");
    return;
  }

  s.stop(`New version available: v${latest}`);

  const installSpinner = spinner();
  installSpinner.start(`Installing v${latest}…`);

  try {
    run(["install", "-g", `${PACKAGE}@${latest}`], INSTALL_TIMEOUT_MS);
    installSpinner.stop(`Installed v${latest}`);
  } catch {
    installSpinner.stop("Install failed");
    log.error(`Could not install ${PACKAGE}@${latest} from npm.`);
    log.info(`Try manually:\n  npm install -g ${PACKAGE}@latest`);
    outro("✗ update failed");
    process.exit(1);
  }

  outro(`✓ updated to v${latest}`);
}
