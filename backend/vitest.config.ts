import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/integration.test.ts",
      "tests/adminFeatures.integration.test.ts",
      "tests/teamProfile.integration.test.ts",
      "tests/settings.integration.test.ts",
      "tests/familiarity.integration.test.ts",
      "tests/live.test.ts",
      "tests/namePoolService.test.ts",
      "tests/persistence.test.ts",
      "tests/scheduler.test.ts",
      "tests/worker.test.ts",
      "tests/seasonArchive.test.ts",
    ],
    environment: "node",
    testTimeout: 60000,
    fileParallelism: true,
    setupFiles: ["tests/setup.ts"],
    testNamePattern: /^(?!.*\[calibration\])/,
  },
});

