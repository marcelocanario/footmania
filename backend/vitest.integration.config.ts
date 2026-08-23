import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/integration.test.ts",
      "tests/live.test.ts",
      "tests/namePoolService.test.ts",
      "tests/persistence.test.ts",
      "tests/scheduler.test.ts",
      "tests/worker.test.ts",
      "tests/seasonArchive.test.ts",
      "tests/adminFeatures.integration.test.ts",
    ],
    environment: "node",
    testTimeout: 90000,
    // These files select their SQLite database through process.env at module
    // load time; concurrent file execution can cross-contaminate integration state.
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    testNamePattern: /^(?!.*\[calibration\])/,
  },
});

