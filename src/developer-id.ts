import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_PATH = join(homedir(), ".pheebs", ".developer-handle");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(): string | undefined {
  try {
    if (!existsSync(CACHE_PATH)) return undefined;
    const raw = readFileSync(CACHE_PATH, "utf-8").trim();
    const newline = raw.indexOf("\n");
    if (newline === -1) return undefined;
    const ts = Number(raw.slice(0, newline));
    if (Date.now() - ts > CACHE_TTL_MS) return undefined;
    const handle = raw.slice(newline + 1);
    return handle || undefined;
  } catch {
    return undefined;
  }
}

function writeCache(handle: string): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, `${Date.now()}\n${handle}`);
  } catch {}
}

function resolve(): string {
  try {
    const handle = execSync("gh api /user --jq .login", { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
    if (handle) return handle;
  } catch {}

  try {
    const email = execSync("git config user.email", { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
    if (email) {
      const hash = createHash("sha256").update(email).digest("hex").substring(0, 6);
      return `dev-${hash}`;
    }
  } catch {}

  return "unknown";
}

export function getDeveloperHandle(): string {
  const cached = readCache();
  if (cached) return cached;

  const handle = resolve();
  if (handle !== "unknown") writeCache(handle);
  return handle;
}
