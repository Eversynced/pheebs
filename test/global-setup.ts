import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The CLI tests exercise the built dist/cli.js, so the build has to happen once, here, before
// any worker starts. Building inside a test file instead would race: `npm run build` wipes
// dist/ first, and a parallel worker spawning dist/cli.js at that moment gets ENOENT.
export default function setup(): void {
  execFileSync("npm", ["run", "build"], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
  });
}
