import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autoUpdateEnabled } from "./backend-config.js";

// Throttle state mirrors developer-id's cache: a single-line Unix-timestamp file
// under ~/.pheebs, checked against a 24h TTL. Keeps `pheebs update` to at most
// once per day across sessions.
const CHECK_PATH = join(homedir(), ".pheebs", ".auto-update-check");
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

// True when no check has run within the TTL. Absent or malformed state counts as
// due; only an unexpected read failure returns false, so a broken filesystem
// never turns into a spawn-every-session loop.
function isDue(): boolean {
  try {
    if (!existsSync(CHECK_PATH)) {
      return true;
    }
    const ts = Number(readFileSync(CHECK_PATH, "utf-8").trim());
    if (!Number.isFinite(ts)) {
      return true;
    }
    return Date.now() - ts > CHECK_TTL_MS;
  } catch {
    return false;
  }
}

function markChecked(): void {
  try {
    mkdirSync(dirname(CHECK_PATH), { recursive: true });
    writeFileSync(CHECK_PATH, String(Date.now()));
  } catch {}
}

// Run `pheebs update` in the background, at most once per day. Called from the
// session_started hook.
//
// The throttle is stamped BEFORE spawning so concurrent sessions starting the
// same day never launch parallel `npm install -g` runs. The child is detached +
// unref'd with no inherited stdio, so a slow update never blocks or slows the
// session and the hook process exits immediately. Everything is fail-silent: a
// failed or offline update leaves the current version in place and surfaces
// nothing. Re-invokes the running CLI (`<node> <cli.js> update`) so it works
// regardless of whether `pheebs` is on PATH in the hook environment.
export function maybeAutoUpdate(): void {
  // Opt-out for developers who manage the version themselves (`pheebs config set auto-update off`).
  if (!autoUpdateEnabled()) {
    return;
  }

  const cliEntry = process.argv[1];
  if (!cliEntry || !isDue()) {
    return;
  }

  markChecked();

  try {
    const child = spawn(process.execPath, [cliEntry, "update"], {
      detached: true,
      stdio: "ignore",
    });
    // A spawn that fails asynchronously must not crash the hook process.
    child.on("error", () => {});
    child.unref();
  } catch {}
}
