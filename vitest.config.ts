import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Heavy fs tests (e.g. queuing 500 events) run past the 5s default on Windows runners.
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/git-env.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
