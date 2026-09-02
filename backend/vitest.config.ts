import { defineConfig } from "vitest/config";

// GitHub Actions sets CI=true. On CPU-constrained shared runners the default
// worker-threads pool lets parallel CPU-bound workers starve the main
// process, tripping the worker RPC ack timeout ("[vitest-worker]: Timeout
// calling 'onTaskUpdate'"). Serialize (forked pool, one worker at a time)
// only there; local runs keep the faster parallel default. Scheduling only —
// no test, assertion, or sample size changes.
const ci = Boolean(process.env.CI);

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
      "tests/worldCache.test.ts",
      "tests/playerSeasonHistoryTrend.test.ts",
      "tests/scheduler.test.ts",
      "tests/divisionHistoryBackfill.test.ts",
      "tests/worker.test.ts",
      "tests/seasonArchive.test.ts",
      "tests/worldControls.integration.test.ts",
      "tests/authGoogle.integration.test.ts",
      "tests/accountDeletion.integration.test.ts",
      "tests/lineupApi.integration.test.ts",
    ],
    environment: "node",
    testTimeout: 60000,
    // Serialize on CI runners only (see the note at the top of this file).
    fileParallelism: !ci,
    ...(ci && { pool: "forks", maxWorkers: 1 }),
    setupFiles: ["tests/setup.ts"],
    testNamePattern: /^(?!.*\[calibration\])/,
  },
});

