import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemExe } from "./windows.js";

// Shared persistence for the small owner-private files under ~/.pheebs (the token and
// the endpoint config). Both need the same JSON-read and 0600-write behavior, so it lives
// in one place rather than being hand-rolled per file.

/** Read and JSON-parse a file; undefined if it is missing, empty, or malformed. */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    // trim() also drops a leading UTF-8 byte order mark, so no stripBom is needed here.
    const raw = readFileSync(path, "utf-8").trim();
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

// A SID rather than a user name: on a domain-joined machine a bare name can resolve to a local
// account of the same name, and stripping inheritance after granting that one would lock the
// developer out of their own settings file.
function currentUserSid(): string | undefined {
  const out = execFileSync(systemExe("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return out.match(/S-1-\d+(?:-\d+)+/)?.[0];
}

/**
 * Narrow an existing file to owner-only. For the agent config files pheebs writes the Bearer
 * token into: those belong to the agent, not to pheebs, so they are written in the agent's
 * own format and only their permissions are ours to tighten. Best-effort, and never widens.
 */
export function restrictToOwner(path: string): void {
  try {
    if (process.platform === "win32") {
      // Windows ignores POSIX mode bits, so a file would keep whatever its folder grants, and a
      // repo under a shared folder can grant other users. Drop the inherited entries and leave
      // the current user as the only one with access.
      const sid = currentUserSid();
      if (!sid) return;
      execFileSync(systemExe("icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:F`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      chmodSync(path, 0o600);
    }
  } catch {}
}

/** Write JSON with owner-only (0600) perms, creating the parent dir. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // mode is ignored when the file already exists, and on Windows always, so enforce it explicitly.
  restrictToOwner(path);
}
