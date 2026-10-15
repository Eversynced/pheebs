import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getStoredTokenId } from "./token.js";

// The token id first, because it is the identity the backend stamps on ingest, so local logs
// line up with stored rows. A hashed git email keeps a local-only install, which has no token,
// on a stable label without recording the address. Nothing is cached: the token is a file read,
// and `git config` answers per repo, so a machine-wide cache could stamp another repo's email.
export function getDeveloperHandle(): string {
  const tokenId = getStoredTokenId();
  if (typeof tokenId === "string" && tokenId) return tokenId;

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
