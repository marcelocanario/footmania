/**
 * Generation / career calibration report.
 *
 * Runs the PRODUCTION generator (not a prototype) over many synthetic clubs per
 * division and prints the acceptance metrics the development plan targets:
 * a D1 automatic XI averaging about 80 OVR, weakest starter about 73, strongest
 * about 87, with ordered division means and adjacent-division overlap.
 *
 *   npx tsx scripts/generation-calibration.ts [clubsPerDivision] [totalDivisions]
 */
import { generateSeniorPlayer, generateYouthPlayer, seniorRosterTemplate, divisionMean, seniorPeakMean, academyPedigree, academyPeakMean } from "../src/game/playerGeneration";
import { generateCareerProfile, densityMean, expectedActivePlayerLifetimeFromAcademyEntry, seniorSurvivalWeights, expectedActiveSeniorSeasons } from "../src/game/careerCurves";
import { ACADEMY_POSITION_WEIGHTS } from "../src/game/playerGeneration";
import { createRng } from "../src/game/rng";
import { retirementBaselinePerClub, targetActivePopulation, targetFreeAgentPool } from "../src/game/population";
import { projectDivisionQuality } from "../src/game/generationProjection";
import type { Player, Position } from "../src/game/types";
import { gameConfig } from "../src/config";

const clubsPerDivision = Number(process.argv[2] ?? 500);
const totalDivisions = Number(process.argv[3] ?? 5);
const squadSize = gameConfig.playerGenerationRules.initialSeniorSquadSize;

const XI_SHAPE = [1, 2, 2, 4, 2];

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}
function fmt(n: number, digits = 1): string {
  return n.toFixed(digits).padStart(6);
}

function buildSquad(clubId: number, division: number): Player[] {
  const template = seniorRosterTemplate(squadSize);
  return template.map((position, slot) =>
    generateSeniorPlayer({
      id: clubId * 1000 + slot,
      clubId,
      country: "BRA",
      position,
      isYouth: false,
      currentDivision: division,
      highestDivisionReached: division,
      totalDivisions,
      seasonId: 1,
      generationType: "initial-senior",
      seed: 991,
      slot,
    }),
  );
}

function startingXi(squad: Player[]): Player[] {
  const xi: Player[] = [];
  for (let position = 0; position < XI_SHAPE.length; position++) {
    xi.push(
      ...squad
        .filter((p) => p.position === position)
        .sort((a, b) => b.overall - a.overall)
        .slice(0, XI_SHAPE[position]),
    );
  }
  return xi;
}

console.log("=== configuration ===");
console.log(`topDivisionMeanOverall      ${gameConfig.playerGeneration.topDivisionMeanOverall}`);
console.log(`seniorPeakOverallOffset     ${gameConfig.playerGeneration.seniorPeakOverallOffset}`);
console.log(`playerQualitySpreadOverall  ${gameConfig.playerGeneration.playerQualitySpreadOverall}`);
console.log(`academyQualitySpreadOverall ${gameConfig.playerGeneration.academyQualitySpreadOverall}`);
console.log(`maximumCareerGrowthOverall  ${gameConfig.playerCareer.maximumCareerGrowthOverall}`);
console.log(`maximumCareerDeclineOverall ${gameConfig.playerCareer.maximumCareerDeclineOverall}`);
console.log(`E[growthPotential]          ${densityMean(gameConfig.playerCareer.growthPotentialDistribution).toFixed(3)}`);
console.log(`E[growthSpeed]              ${densityMean(gameConfig.playerCareer.growthSpeedDistribution).toFixed(3)}`);
console.log(`E[declinePotential]         ${densityMean(gameConfig.playerCareer.declinePotentialDistribution).toFixed(3)}`);
console.log(`E[declineSpeed]             ${densityMean(gameConfig.playerCareer.declineSpeedDistribution).toFixed(3)}`);

console.log("\n=== senior generation by division ===");
console.log("  D   popMean  target |  xiMean  weakest strongest |   p10    p50    p90    p99 | meanAge");
const divisionSamples: number[][] = [];
for (let division = 1; division <= totalDivisions; division++) {
  const all: number[] = [];
  const ages: number[] = [];
  const xiMeans: number[] = [];
  const weakest: number[] = [];
  const strongest: number[] = [];
  for (let club = 0; club < clubsPerDivision; club++) {
    const squad = buildSquad(division * 100000 + club, division);
    for (const p of squad) {
      all.push(p.overall);
      ages.push(p.age);
    }
    const xi = startingXi(squad).map((p) => p.overall).sort((a, b) => a - b);
    if (xi.length === 0) continue;
    xiMeans.push(mean(xi));
    weakest.push(xi[0]);
    strongest.push(xi[xi.length - 1]);
  }
  const sorted = [...all].sort((a, b) => a - b);
  divisionSamples.push(sorted);
  console.log(
    `  ${division}  ${fmt(mean(all))}  ${fmt(divisionMean(division, totalDivisions))} | ` +
    `${fmt(mean(xiMeans))}  ${fmt(mean(weakest))}    ${fmt(mean(strongest))} | ` +
    `${fmt(quantile(sorted, 0.1), 0)} ${fmt(quantile(sorted, 0.5), 0)} ${fmt(quantile(sorted, 0.9), 0)} ${fmt(quantile(sorted, 0.99), 0)} | ${fmt(mean(ages))}`,
  );
}

console.log("\n=== adjacent-division overlap (share of lower-division players above the upper division's p25) ===");
for (let division = 1; division < totalDivisions; division++) {
  const upper = divisionSamples[division - 1];
  const lower = divisionSamples[division];
  const threshold = quantile(upper, 0.25);
  const share = lower.filter((v) => v >= threshold).length / Math.max(1, lower.length);
  console.log(`  D${division + 1} above D${division} p25 (${threshold}):  ${(share * 100).toFixed(1)}%`);
}

console.log("\n=== senior age buckets (D1, mean OVR per bucket) ===");
{
  const byAge = new Map<number, number[]>();
  for (let club = 0; club < clubsPerDivision; club++) {
    for (const p of buildSquad(900000 + club, 1)) {
      if (!byAge.has(p.age)) byAge.set(p.age, []);
      byAge.get(p.age)!.push(p.overall);
    }
  }
  const ages = [...byAge.keys()].sort((a, b) => a - b);
  for (const age of ages) {
    const values = byAge.get(age)!;
    if (values.length < 20) continue;
    console.log(`  age ${String(age).padStart(2)}  n=${String(values.length).padStart(5)}  mean ${fmt(mean(values))}`);
  }
}

console.log("\n=== D1 academy by age (pedigree 1.0) ===");
console.log(" age    mean     p50     p90     p99     max");
for (let age = gameConfig.playerGenerationRules.academyMinAge; age <= gameConfig.playerGenerationRules.academyMaxAge; age++) {
  const values: number[] = [];
  for (let i = 0; i < clubsPerDivision * 4; i++) {
    const p = generateYouthPlayer({
      id: i,
      clubId: 7,
      country: "BRA",
      position: (i % 5) as Position,
      age,
      isYouth: true,
      currentDivision: 1,
      highestDivisionReached: 1,
      totalDivisions,
      seasonId: 1,
      generationType: "initial-academy",
      seed: 4242 + age,
      slot: i,
    });
    values.push(p.overall);
  }
  const sorted = values.sort((a, b) => a - b);
  console.log(`  ${age}  ${fmt(mean(sorted))}  ${fmt(quantile(sorted, 0.5), 0)}  ${fmt(quantile(sorted, 0.9), 0)}  ${fmt(quantile(sorted, 0.99), 0)}  ${fmt(sorted[sorted.length - 1], 0)}`);
}

console.log("\n=== career profile distribution (50k draws) ===");
{
  const rng = createRng(20260825);
  const gp: number[] = [];
  const gs: number[] = [];
  const pa: number[] = [];
  const dp: number[] = [];
  const ds: number[] = [];
  for (let i = 0; i < 50000; i++) {
    const profile = generateCareerProfile(rng);
    gp.push(profile.growthPotential);
    gs.push(profile.growthSpeed);
    pa.push(profile.peakAge);
    dp.push(profile.declinePotential);
    ds.push(profile.declineSpeed);
  }
  const report = (label: string, values: number[], expected: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    console.log(`  ${label.padEnd(18)} mean ${mean(values).toFixed(3)}  (expected ${expected.toFixed(3)})  min ${sorted[0].toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}`);
  };
  report("growthPotential", gp, densityMean(gameConfig.playerCareer.growthPotentialDistribution));
  report("growthSpeed", gs, densityMean(gameConfig.playerCareer.growthSpeedDistribution));
  report("declinePotential", dp, densityMean(gameConfig.playerCareer.declinePotentialDistribution));
  report("declineSpeed", ds, densityMean(gameConfig.playerCareer.declineSpeedDistribution));
  const sortedPeak = [...pa].sort((a, b) => a - b);
  const peakMean = mean(pa);
  const peakSd = Math.sqrt(mean(pa.map((v) => (v - peakMean) ** 2)));
  console.log(`  peakAge            mean ${peakMean.toFixed(2)} (config ${gameConfig.playerCareer.peakAgeDistribution.mean})  sd ${peakSd.toFixed(2)} (config ${gameConfig.playerCareer.peakAgeDistribution.stdDev})  min ${sortedPeak[0]}  max ${sortedPeak[sortedPeak.length - 1]}`);
}

console.log("\n=== active-career survival ===");
for (let position = 0 as Position; position < 5; position = (position + 1) as Position) {
  const weights = seniorSurvivalWeights(position);
  const ages = [...weights.keys()];
  console.log(`  position ${position}: entry ${ages[0]}  last ${ages[ages.length - 1]}  expected seasons ${expectedActiveSeniorSeasons(position).toFixed(2)}`);
}
console.log(`  lifetime from academy entry: ${expectedActivePlayerLifetimeFromAcademyEntry(ACADEMY_POSITION_WEIGHTS).toFixed(2)} seasons`);
console.log(`  retirement baseline per club: ${retirementBaselinePerClub().toFixed(3)} recruits/season`);
console.log(`  target free-agent pool (10 clubs): ${targetFreeAgentPool(10).toFixed(2)}`);
console.log(`  target active population (10 clubs): ${targetActivePopulation(10).toFixed(2)}`);

console.log("\n=== economy projection (derived, D1) ===");
{
  const projection = projectDivisionQuality(1, 1);
  console.log(`  full-squad mean       ${projection.fullSquadMean.toFixed(2)}`);
  console.log(`  starting XI mean      ${projection.startingXiMean.toFixed(2)}`);
  console.log(`  weakest starter mean  ${projection.weakestStarterMean.toFixed(2)}`);
  console.log(`  strongest starter     ${projection.strongestStarterMean.toFixed(2)}`);
  console.log(`  p90 (meaningful)      ${projection.percentile(0.9)}`);
  console.log(`  p99 (elite)           ${projection.percentile(0.99)}`);
}

console.log("\n=== anchors ===");
for (let division = 1; division <= totalDivisions; division++) {
  const pedigree = academyPedigree(division, division, totalDivisions);
  console.log(
    `  D${division}: divisionMean ${divisionMean(division, totalDivisions).toFixed(2)}  seniorPeakMean ${seniorPeakMean(division, totalDivisions).toFixed(2)}` +
    `  pedigree ${pedigree.toFixed(3)}  academyPeakMean ${academyPeakMean(pedigree).toFixed(2)}`,
  );
}
