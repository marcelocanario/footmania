import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/integration.test.ts",
      "tests/live.test.ts",
      "tests/namePoolService.test.ts",
      "tests/persistence.test.ts",
      "tests/worldCache.test.ts",
      "tests/playerSeasonHistoryTrend.test.ts",
      "tests/scheduler.test.ts",
      "tests/worker.test.ts",
      "tests/seasonArchive.test.ts",
      "tests/adminFeatures.integration.test.ts",
      "tests/teamProfile.integration.test.ts",
      "tests/settings.integration.test.ts",
      "tests/familiarity.integration.test.ts",
      "tests/worldControls.integration.test.ts",
      "tests/authGoogle.integration.test.ts",
      "tests/accountDeletion.integration.test.ts",
      "tests/lineupApi.integration.test.ts",
    ],
    environment: "node",
    testTimeout: 90000,
    // All suites share one Postgres "test" schema (see tests/testDbUrl.ts);
    // concurrent file execution can cross-contaminate integration state.
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts", "tests/integration-setup.ts"],
    testNamePattern: /^(?!.*\[calibration\])/,
  },
});

