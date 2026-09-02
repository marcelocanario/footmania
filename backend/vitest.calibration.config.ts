import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/development.test.ts",
      "tests/engine.test.ts",
      "tests/matchSimulator.test.ts",
      "tests/playerCareer.test.ts",
      "tests/playerGeneration.test.ts",
      "tests/population.test.ts",
      "tests/contractEconomy.test.ts",
      "tests/rng.test.ts",
      "tests/calibration.energyInjury.test.ts",
    ],
    testNamePattern: /\[calibration\]/,
    environment: "node",
    testTimeout: 60000,
    // This suite runs only locally, enforced by .githooks/pre-push before any
    // push to main — never in CI. Local machines are not CPU-starved like the
    // 2-vCPU GitHub runners, so it keeps the parallel default.
    fileParallelism: true,
    setupFiles: ["tests/setup.ts"],
  },
});
