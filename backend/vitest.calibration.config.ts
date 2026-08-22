import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/development.test.ts",
      "tests/engine.test.ts",
      "tests/matchSimulator.test.ts",
      "tests/playerCareer.test.ts",
      "tests/playerGeneration.test.ts",
      "tests/rng.test.ts",
      "tests/calibration.energyInjury.test.ts",
    ],
    testNamePattern: /\[calibration\]/,
    environment: "node",
    testTimeout: 60000,
    fileParallelism: true,
    setupFiles: ["tests/setup.ts"],
  },
});
