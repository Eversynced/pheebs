// Printed after a global install. Pheebs no longer auto-configures anything — nothing is
// written without an explicit `pheebs init`. Uses CJS (.cjs) in a "type": "module" package.

function isGlobal() {
  return process.env.npm_config_global === "true" || process.env.npm_config_location === "global";
}

if (isGlobal()) {
  console.log("pheebs installed. Run `pheebs init` to configure hooks and set your token.");
}
