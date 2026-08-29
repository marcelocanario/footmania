/**
 * Calibration sweep for the D1 acceptance targets.
 *
 * `seniorPeakOverallOffset` is not a free knob: `topDivisionMeanOverall` is
 * DEFINED as the mean of the complete generated D1 senior population, so the
 * offset must be exactly the amount the standing age mix gives back. This script
 * solves for that offset at each candidate spread, then reports the resulting
 * automatic-XI metrics so the spread and top-division mean can be chosen against
 * the 80 / 73 / 87 targets.
 *
 *   npx tsx scripts/generation-sweep.ts [clubsPerCandidate]
 */
import { generateSeniorPlayer, seniorRosterTemplate } from "../src/game/playerGeneration";
import type { Player } from "../src/game/types";
import type { NaturalPosition } from "../src/game/positions";
import { gameConfig } from "../src/config";

const clubs = Number(process.argv[2] ?? 250);
// §13.4/§13.5 reporting shape: the fixed 4-3-3 natural-position XI.
const XI_SHAPE: [NaturalPosition, number][] = [
  ["GK", 1], ["LB", 1], ["RB", 1], ["CB", 2], ["DM", 1], ["AM", 2], ["LW", 1], ["RW", 1], ["ST", 1],
];

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function measure(seed: number): { pop: number; xi: number; weakest: number; strongest: number } {
  const squadSize = gameConfig.playerGenerationRules.initialSeniorSquadSize;
  const template = seniorRosterTemplate(squadSize);
  const all: number[] = [];
  const xiMeans: number[] = [];
  const weakest: number[] = [];
  const strongest: number[] = [];
  for (let club = 0; club < clubs; club++) {
    const squad: Player[] = template.map((position, slot) =>
      generateSeniorPlayer({
        id: club * 1000 + slot,
        clubId: club,
        country: "BRA",
        position,
        isYouth: false,
        currentDivision: 1,
        highestDivisionReached: 1,
        totalDivisions: 5,
        seasonId: 1,
        generationType: "initial-senior",
        seed,
        slot,
      }),
    );
    for (const p of squad) all.push(p.overall);
    const xi: number[] = [];
    for (const [position, count] of XI_SHAPE) {
      xi.push(...squad.filter((p) => p.position === position).sort((a, b) => b.overall - a.overall).slice(0, count).map((p) => p.overall));
    }
    xi.sort((a, b) => a - b);
    if (xi.length === 0) continue;
    xiMeans.push(mean(xi));
    weakest.push(xi[0]);
    strongest.push(xi[xi.length - 1]);
  }
  return { pop: mean(all), xi: mean(xiMeans), weakest: mean(weakest), strongest: mean(strongest) };
}

/** Solve the offset that makes the generated population mean equal the configured mean. */
function solveOffset(seed: number): number {
  let offset = gameConfig.playerGeneration.seniorPeakOverallOffset;
  for (let iteration = 0; iteration < 8; iteration++) {
    gameConfig.playerGeneration.seniorPeakOverallOffset = offset;
    const { pop } = measure(seed);
    const error = gameConfig.playerGeneration.topDivisionMeanOverall - pop;
    if (Math.abs(error) < 0.05) break;
    offset += error;
  }
  return Math.round(offset * 100) / 100;
}

console.log("  topMean  sigma | offset |  popMean    xiMean  weakest strongest");
for (const topMean of [73, 74, 75]) {
  for (const sigma of [5, 5.5, 6, 6.5]) {
    gameConfig.playerGeneration.topDivisionMeanOverall = topMean;
    gameConfig.playerGeneration.playerQualitySpreadOverall = sigma;
    const offset = solveOffset(4242);
    gameConfig.playerGeneration.seniorPeakOverallOffset = offset;
    const r = measure(9191);
    console.log(
      `  ${String(topMean).padStart(7)}  ${String(sigma).padStart(5)} | ${offset.toFixed(2).padStart(6)} | ` +
      `${r.pop.toFixed(2).padStart(8)}  ${r.xi.toFixed(2).padStart(8)}  ${r.weakest.toFixed(2).padStart(7)}  ${r.strongest.toFixed(2).padStart(9)}`,
    );
  }
}
