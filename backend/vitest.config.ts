import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    // Test files select their SQLite database through process.env at module
    // load time; running them concurrently makes that process-global setting
    // nondeterministic and can cross-contaminate integration state.
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
  },
});
