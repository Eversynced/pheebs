import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./pheebs-store.js";
import { getStoredTokenId } from "./token.js";

// Keyed by session rather than machine-wide: `git config` answers per repo, and a session stays
// in one, so a session never picks up another repo's email.
const SESSION_CACHE_PATH = join(homedir(), ".pheebs", ".developer-handles.json");

// Enough for every session a developer plausibly has open at once.
const MAX_CACHED_SESSIONS = 32;

function hashedGitEmail(): string {
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      stdio: ["pipe", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (email) {
      const hash = createHash("sha256").update(email).digest("hex").substring(0, 6);
      return `dev-${hash}`;
    }
  } catch {}

  return "unknown";
}

// The token id first, because it is the identity the backend stamps on ingest, so local logs
// line up with stored rows. A hashed git email keeps a local-only install, which has no token,
// on a stable label without recording the address. That label is spawned once per session,
// not on every tool call.
export function getDeveloperHandle(sessionId?: string): string {
  const tokenId = getStoredTokenId();
  if (tokenId) return tokenId;
  if (!sessionId) return hashedGitEmail();

  const cache = readJsonFile<Record<string, unknown>>(SESSION_CACHE_PATH) ?? {};
  const cached = cache[sessionId];
  if (typeof cached === "string") return cached;

  const handle = hashedGitEmail();
  if (handle === "unknown") return handle;
  try {
    const kept = Object.entries(cache)
      .filter(([id]) => id !== sessionId)
      .slice(-(MAX_CACHED_SESSIONS - 1));
    writeJsonFile(SESSION_CACHE_PATH, Object.fromEntries([...kept, [sessionId, handle]]));
  } catch {}
  return handle;
}
