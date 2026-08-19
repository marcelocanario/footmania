/**
 * Parameter sweep harness (transfer-market-overhaul Phase 11).
 *
 * Runs the Monte Carlo simulation one-at-a-time across a set of tunable
 * parameters, printing the aggregate metrics for each configuration so they
 * can be compared and tuned.
 *
 * Run: npx tsx scripts/sweep.ts [seeds] [periods]
 */
import { runSim, printMetrics, type AggregateMetrics } from "./simulate";

interface SweepDef {
  /** Human-readable parameter name. */
  name: string;
  /** Config path (dot-separated) that applyOverrides mutates. */
  path: string;
  /** Values to try (each run mutates the in-memory MARKET_CONFIG). */
  values: unknown[];
  /** True when the values are arrays (multiplier ranges) vs scalars. */
  isArray?: boolean;
}

// Deep-clone the default config snapshot for each run so overrides don't leak.
const BASE_OVERRIDES: Record<string, unknown> = {};

function snapshotConfig(): void {
  // The harness re-applies overrides to the singleton MARKET_CONFIG; each run
  // must first reset to defaults. We approximate a reset by re-importing via
  // the module cache is complex, so instead the sweep only ever sets the exact
  // paths it tests and we copy fresh defaults per value by reading from a
  // pristine source below.
}

const sweeps: SweepDef[] = [
  {
    name: "aiSelling.listThreshold",
    path: "aiSelling.listThreshold",
    values: [15, 20, 25, 30, 40],
  },
  {
    name: "aiSelling.poorWageEfficiencySalaryToValueRatio",
    path: "aiSelling.poorWageEfficiencySalaryToValueRatio",
    values: [0.1, 0.2, 0.3],
  },
  {
    name: "aiSelling.ageingSellAge",
    path: "aiSelling.ageingSellAge",
    values: [28, 30, 32],
  },
  {
    name: "aiSelling.marketOpportunityMaxActiveListings",
    path: "aiSelling.marketOpportunityMaxActiveListings",
    values: [0, 1, 2],
  },
  {
    name: "aiSelling.marketOpportunityMinNeedyClubs",
    path: "aiSelling.marketOpportunityMinNeedyClubs",
    values: [1, 2, 3],
  },
  {
    name: "aiSelling.sellScore.surplusAtPosition",
    path: "aiSelling.sellScore.surplusAtPosition",
    values: [20, 30, 40],
  },
  {
    name: "aiSelling.sellScore.backupRarelyNeeded",
    path: "aiSelling.sellScore.backupRarelyNeeded",
    values: [15, 25, 35],
  },
  {
    name: "aiSelling.sellScore.marketOpportunity",
    path: "aiSelling.sellScore.marketOpportunity",
    values: [5, 10, 15],
  },
  {
    name: "aiSelling.sellScore.financialPressure",
    path: "aiSelling.sellScore.financialPressure",
    values: [20, 30, 40],
  },
  {
    name: "aiSelling.sellScore.primaryStarterPenalty",
    path: "aiSelling.sellScore.primaryStarterPenalty",
    values: [-20, -30, -40],
  },
  {
    name: "aiSelling.sellScore.onlyAdequatePlayerPenalty",
    path: "aiSelling.sellScore.onlyAdequatePlayerPenalty",
    values: [-30, -40, -50],
  },
  {
    name: "aiSelling.sellScore.positionThinPenalty",
    path: "aiSelling.sellScore.positionThinPenalty",
    values: [-20, -30, -40],
  },
  {
    name: "aiSelling.maxListingsPerClub",
    path: "aiSelling.maxListingsPerClub",
    values: [1, 2, 3],
  },
  {
    name: "aiBuying.adequateOverallFloor",
    path: "aiBuying.adequateOverallFloor",
    values: [55, 60, 65],
  },
  {
    name: "aiBuying.starterBelowDesiredOffset",
    path: "aiBuying.starterBelowDesiredOffset",
    values: [5, 10, 15],
  },
  {
    name: "aiBuying.alreadyStrongSurplus",
    path: "aiBuying.alreadyStrongSurplus",
    values: [1, 2, 3],
  },
  {
    name: "aiBuying.upgradeGainFloor",
    path: "aiBuying.upgradeGainFloor",
    values: [1.0, 1.02, 1.05],
  },
  {
    name: "aiBuying.ageingBuyAge",
    path: "aiBuying.ageingBuyAge",
    values: [28, 30, 32],
  },
  {
    name: "aiBuying.needScore.noViableStarter",
    path: "aiBuying.needScore.noViableStarter",
    values: [40, 50, 60],
  },
  {
    name: "aiBuying.needScore.belowRequiredDepth",
    path: "aiBuying.needScore.belowRequiredDepth",
    values: [30, 40, 50],
  },
  {
    name: "aiBuying.needScore.alreadyStrong",
    path: "aiBuying.needScore.alreadyStrong",
    values: [-30, -40, -50],
  },
  {
    name: "aiBuying.needMultiplierRange",
    path: "aiBuying.needMultiplierRange",
    values: [
      [0.9, 1.25],
      [0.95, 1.3],
      [1.0, 1.4],
    ],
    isArray: true,
  },
  {
    name: "aiBuying.upgradeMultiplierRange",
    path: "aiBuying.upgradeMultiplierRange",
    values: [
      [0.9, 1.15],
      [0.95, 1.2],
      [1.0, 1.3],
    ],
    isArray: true,
  },
  {
    name: "aiBuying.maxListingsPerRun",
    path: "aiBuying.maxListingsPerRun",
    values: [3, 5, 8, 12],
  },
  {
    name: "aiBuying.desiredDepthPerPosition",
    path: "aiBuying.desiredDepthPerPosition",
    values: [
      [2, 3, 3, 3, 3],
      [2, 2, 2, 2, 2],
      [3, 4, 4, 5, 4],
    ],
    isArray: true,
  },
  {
    name: "recentTrade.fadeOverGames",
    path: "recentTrade.fadeOverGames",
    values: [0, 3, 6, 10, 20],
  },
  {
    name: "auctionOpeningRange.minValueRatio",
    path: "auctionOpeningRange.minValueRatio",
    values: [0.4, 0.5, 0.6, 0.75],
  },
  {
    name: "auctionOpeningRange.maxValueRatio",
    path: "auctionOpeningRange.maxValueRatio",
    values: [0.9, 1.0, 1.1, 1.25],
  },
  {
    name: "transferAuction.durationHours",
    path: "transferAuction.durationHours",
    values: [12, 24, 48],
  },
  {
    name: "freeAgents.startMultiplier (relistMultipliers[0])",
    path: "freeAgents.relistMultipliers",
    values: [
      [0.1, 0.075, 0.05, 0.025],
      [0.15, 0.1, 0.075, 0.05],
      [0.2, 0.15, 0.1, 0.05],
    ],
    isArray: true,
  },
  {
    name: "loans.exposureMinutes",
    path: "loans.exposureMinutes",
    values: [5, 30, 60],
  },
];

const seeds = Number(process.argv[2] ?? 6);
const periods = Number(process.argv[3] ?? 32);

// Baseline run with the CURRENT config (no overrides).
console.log("\n########## BASELINE (current config) ##########");
printMetrics(`BASELINE ${seeds}×${periods}`, runSim(seeds, periods));
void BASE_OVERRIDES;

// Each sweep: for each value, run and print. To avoid cross-contamination the
// sweep re-imports simulate in a fresh process is impractical; instead we
// record the baseline snapshot of every path we mutate and restore it after
// each value run.
import { MARKET_CONFIG } from "../src/config";

type Deep = Record<string, unknown>;
function getDeep(root: Deep, path: string): unknown {
  let o: Deep = root;
  for (const part of path.split(".")) {
    o = o[part] as Deep;
  }
  return o;
}
function setDeep(root: Deep, path: string, value: unknown): void {
  const parts = path.split(".");
  let o: Deep = root;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] as Deep;
  o[parts[parts.length - 1]] = value;
}

for (const sweep of sweeps) {
  const original = getDeep(MARKET_CONFIG as unknown as Deep, sweep.path);
  console.log(`\n########## SWEEP: ${sweep.name} ##########`);
  for (const value of sweep.values) {
    setDeep(MARKET_CONFIG as unknown as Deep, sweep.path, value);
    const label = `${sweep.name} = ${JSON.stringify(value)}`;
    const m: AggregateMetrics = runSim(seeds, periods, {});
    printMetrics(label, m);
  }
  // Restore the original value so later sweeps start from the real default.
  setDeep(MARKET_CONFIG as unknown as Deep, sweep.path, original);
}
