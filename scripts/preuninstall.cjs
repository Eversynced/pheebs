// Auto-run `pheebs uninstall` before global uninstalls so hooks are cleaned up.
// Uses CJS (.cjs) to avoid ESM issues in a "type": "module" package.

const { execSync } = require("child_process");
const { join } = require("path");

function isGlobal() {
  return (
    process.env.npm_config_global === "true" ||
    process.env.npm_config_location === "global"
  );
}

if (!isGlobal()) {
  process.exit(0);
}

const cliPath = join(__dirname, "..", "dist", "cli.js");

try {
  execSync(`node "${cliPath}" uninstall`, { stdio: "inherit" });
} catch {
  console.warn("pheebs: auto-uninstall failed — hooks may remain in your settings");
}
