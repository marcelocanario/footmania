/**
 * Generation / career calibration report.
 *
 * Runs the PRODUCTION generator (not a prototype) over many synthetic clubs per
 * division and prints the acceptance metrics the development plan targets:
 * initial-senior squads assembled through the actual batch/blueprint-pairing
 * path, division-relative band coverage, automatic-XI metrics, economy
 * guardrails against the pre-pairing baseline, plus the marginal raw-Z and
 * career-profile distributions. Adjacent divisions overlap substantially by
 * design.
 *
 *   npx tsx scripts/generation-calibration.ts [clubsPerDivision] [totalDivisions]
 */
import {
  generateInitialSeniorPlayers,
  generateInitialAcademyPlayers,
  generateYouthPlayer,
  seniorRosterTemplate,
  divisionMean,
  seniorPeakMean,
  initialClubQualityTargets,
  academyPedigree,
  academyPeakMean,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import { generateCareerProfile, densityMean, expectedActivePlayerLifetimeFromAcademyEntry, seniorSurvivalWeights, expectedActiveSeniorSeasons, activityModifiersFor, reconstructCurrentTarget } from "../src/game/careerCurves";
import { ACADEMY_POSITION_WEIGHTS } from "../src/game/playerGeneration";
import { createRng } from "../src/game/rng";
import { retirementBaselinePerClub, targetActivePopulation, targetFreeAgentPool } from "../src/game/population";
import { initialClubPlayerValueTarget, projectDivisionQuality } from "../src/game/generationProjection";
import type { Player, Position } from "../src/game/types";
import { gameConfig } from "../src/config";

const clubsPerDivision = Number(process.argv[2] ?? 500);
const totalDivisions = Number(process.argv[3] ?? 5);
const squadSize = gameConfig.playerGenerationRules.initialSeniorSquadSize;
const initialActivity = gameConfig.playerGeneration.initialSeniorHistoricalActivity;

const XI_SHAPE = [1, 2, 2, 4, 2];

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function std(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}
function fmt(n: number, digits = 1): string {
  return n.toFixed(digits).padStart(6);
}
function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + "%";
}

/**
 * Build one initial senior squad through the actual production batch path
 * (`generateInitialSeniorPlayers`): contexts in slot order, deterministic
 * per-player RNG streams, squad-level quality pairing, and initial-senior
 * historical activity.
 */
function buildSquad(clubId: number, division: number): Player[] {
  const template = seniorRosterTemplate(squadSize);
  const contexts: GeneratePlayerContext[] = template.map((position, slot) => ({
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
  }));
  return generateInitialSeniorPlayers(contexts);
}

function buildInitialAcademy(clubId: number, division: number): Player[] {
  const size = gameConfig.playerGenerationRules.initialAcademySize;
  const minimumAge = gameConfig.playerGenerationRules.academyMinAge;
  const ageCount = gameConfig.playerGenerationRules.academyMaxAge - minimumAge + 1;
  return generateInitialAcademyPlayers(Array.from({ length: size }, (_, slot) => ({
    id: clubId * 1000 + squadSize + slot,
    clubId,
    country: "BRA",
    position: (slot % 5) as Position,
    age: minimumAge + (slot % ageCount),
    isYouth: true,
    currentDivision: division,
    highestDivisionReached: division,
    totalDivisions,
    seasonId: 1,
    generationType: "initial-academy" as const,
    seed: 991,
    slot,
  })));
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
console.log(`initialSeniorActivity       ${initialActivity}`);
console.log(`target mean offset (overall)${gameConfig.playerGeneration.initialClubTargetMeanOffsetOverall}`);
console.log(`target band half width      ${gameConfig.playerGeneration.initialClubTargetBandHalfWidthOverall}`);
console.log(`D1 club player value target $${(gameConfig.playerGeneration.initialClubPlayerValueTargetTopDivision / 1_000_000).toFixed(2)}M`);
console.log(`E[growthPotential]          ${densityMean(gameConfig.playerCareer.growthPotentialDistribution).toFixed(3)}`);
console.log(`E[growthSpeed]              ${densityMean(gameConfig.playerCareer.growthSpeedDistribution).toFixed(3)}`);
console.log(`E[declinePotential]         ${densityMean(gameConfig.playerCareer.declinePotentialDistribution).toFixed(3)}`);
console.log(`E[declineSpeed]             ${densityMean(gameConfig.playerCareer.declineSpeedDistribution).toFixed(3)}`);

console.log("\n=== initial senior squads by division (paired batch path) ===");
console.log("  D   popMean  target |  xiMean  weakest strongest |   p10    p50    p90    p99 | meanAge |  inBand  avgOut |  sq29+30");
const divisionSamples: number[][] = [];
const divisionRawZ: number[][] = [];
const divisionStageOffsets: number[][] = [];
for (let division = 1; division <= totalDivisions; division++) {
  const all: number[] = [];
  const ages: number[] = [];
  const xiMeans: number[] = [];
  const weakest: number[] = [];
  const strongest: number[] = [];
  const rawZs: number[] = [];
  const stageOffsets: number[] = [];
  const targets = initialClubQualityTargets(division, totalDivisions);
  let inBand = 0;
  let totalPlayers = 0;
  let squadsWith29Plus = 0;
  for (let club = 0; club < clubsPerDivision; club++) {
    const squad = buildSquad(division * 100000 + club, division);
    let squadInBand = 0;
    for (const p of squad) {
      all.push(p.overall);
      ages.push(p.age);
      rawZs.push(p.rawZ ?? 0);
      if (p.overall >= targets.lower && p.overall <= targets.upper) squadInBand++;
      totalPlayers++;
    }
    inBand += squadInBand;
    if (squadInBand >= squadSize - 1) squadsWith29Plus++;
    const xi = startingXi(squad).map((p) => p.overall).sort((a, b) => a - b);
    if (xi.length === 0) continue;
    xiMeans.push(mean(xi));
    weakest.push(xi[0]);
    strongest.push(xi[xi.length - 1]);
    // Correlation inputs: assigned raw Z vs OVR-equivalent stage offset.
    const activity = activityModifiersFor(initialActivity);
    for (const p of squad) {
      const offset = reconstructCurrentTarget(
        p.careerProfile, 0, p.age, activity.growth, activity.decline,
      ).current;
      stageOffsets.push(offset);
    }
  }
  const sorted = [...all].sort((a, b) => a - b);
  divisionSamples.push(sorted);
  divisionRawZ.push(rawZs);
  divisionStageOffsets.push(stageOffsets);
  const rawZMean = mean(rawZs);
  const rawZSd = std(rawZs);
  const corr = (() => {
    const n = Math.min(rawZs.length, stageOffsets.length);
    if (n < 2) return 0;
    const mz = mean(rawZs);
    const mo = mean(stageOffsets);
    let num = 0;
    let denZ = 0;
    let denO = 0;
    for (let i = 0; i < n; i++) {
      num += (rawZs[i] - mz) * (stageOffsets[i] - mo);
      denZ += (rawZs[i] - mz) ** 2;
      denO += (stageOffsets[i] - mo) ** 2;
    }
    return denZ * denO > 0 ? num / Math.sqrt(denZ * denO) : 0;
  })();
  console.log(
    `  ${division}  ${fmt(mean(all))}  ${fmt(divisionMean(division, totalDivisions))} | ` +
    `${fmt(mean(xiMeans))}  ${fmt(mean(weakest))}    ${fmt(mean(strongest))} | ` +
    `${fmt(quantile(sorted, 0.1), 0)} ${fmt(quantile(sorted, 0.5), 0)} ${fmt(quantile(sorted, 0.9), 0)} ${fmt(quantile(sorted, 0.99), 0)} | ${fmt(mean(ages))} | ` +
    `${pct(inBand / Math.max(1, totalPlayers))}  ${fmt((totalPlayers - inBand) / Math.max(1, clubsPerDivision))} | ${pct(squadsWith29Plus / clubsPerDivision)}  corr ${corr.toFixed(3)}  zMean ${rawZMean.toFixed(3)}  zSd ${rawZSd.toFixed(3)}`,
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

console.log("\n=== independent D1 youth generator by age (periodic-intake authority, pedigree 1.0) ===");
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

console.log("\n=== initial-senior economy (D1, paired batch path) ===");
{
  const seniorValues: number[] = [];
  const seniorPayroll: number[] = [];
  const clubValues: number[] = [];
  for (let club = 0; club < clubsPerDivision; club++) {
    const squad = buildSquad(700000 + club, 1);
    let value = 0;
    let payroll = 0;
    for (const p of squad) {
      value += p.value;
      payroll += p.salary;
    }
    seniorValues.push(value);
    seniorPayroll.push(payroll);
    // Diagnostic: total initial club value through both conditioned cohort paths.
    const academy = buildInitialAcademy(700000 + club, 1);
    clubValues.push(value + academy.reduce((sum, p) => sum + p.value, 0));
  }
  const mVal = mean(seniorValues);
  const mPay = mean(seniorPayroll);
  const mClub = mean(clubValues);
  // Historical pre-conditioning baselines remain visible for comparison; the
  // configured target below is the new acceptance authority.
  const baselineValue = 30_500_000;
  const baselinePayroll = 5_700_000;
  const baselineClub = 45_300_000;
  console.log(`  mean senior total value   $${(mVal / 1_000_000).toFixed(2)}M  (baseline ~$30.5M, delta ${(((mVal - baselineValue) / baselineValue) * 100).toFixed(2)}%)`);
  console.log(`  mean senior payroll       $${(mPay / 1_000_000).toFixed(2)}M  (baseline ~$5.7M, delta ${(((mPay - baselinePayroll) / baselinePayroll) * 100).toFixed(2)}%)`);
  console.log(`  mean full initial club    $${(mClub / 1_000_000).toFixed(2)}M  (baseline ~$45.3M, delta ${(((mClub - baselineClub) / baselineClub) * 100).toFixed(2)}%)`);
  const target = initialClubPlayerValueTarget(1);
  console.log(`  configured D1 target      $${(target / 1_000_000).toFixed(2)}M  (miss ${(((mClub - target) / target) * 100).toFixed(2)}%)`);
}

console.log("\n=== conditioned initial academy cohorts by division ===");
console.log("  D  currentMean currentMin currentMax | peakMean peakMin peakMax | clubValue targetValue");
for (let division = 1; division <= totalDivisions; division++) {
  const current: number[] = [];
  const peaks: number[] = [];
  const clubValues: number[] = [];
  const pedigree = academyPedigree(division, division, totalDivisions);
  const peakAnchor = academyPeakMean(pedigree);
  for (let club = 0; club < clubsPerDivision; club++) {
    const academy = buildInitialAcademy(800000 + division * 100000 + club, division);
    current.push(...academy.map((player) => player.overall));
    peaks.push(...academy.map((player) => peakAnchor + gameConfig.playerGeneration.academyQualitySpreadOverall * (player.rawZ ?? 0)));
    clubValues.push(academy.reduce((sum, player) => sum + player.value, 0));
  }
  console.log(
    `  ${division}  ${fmt(mean(current))} ${fmt(Math.min(...current), 0)} ${fmt(Math.max(...current), 0)} | ` +
    `${fmt(mean(peaks))} ${fmt(Math.min(...peaks), 0)} ${fmt(Math.max(...peaks), 0)} | ` +
    `$${(mean(clubValues) / 1_000_000).toFixed(2)}M $${(initialClubPlayerValueTarget(division) / 1_000_000).toFixed(2)}M`,
  );
}

console.log("\n=== initial club value targets by division (budget-decayed) ===");
for (let division = 1; division <= totalDivisions; division++) {
  console.log(`  D${division}: $${(initialClubPlayerValueTarget(division) / 1_000_000).toFixed(2)}M`);
}

console.log("\n=== anchors ===");
for (let division = 1; division <= totalDivisions; division++) {
  const pedigree = academyPedigree(division, division, totalDivisions);
  console.log(
    `  D${division}: divisionMean ${divisionMean(division, totalDivisions).toFixed(2)}  seniorPeakMean ${seniorPeakMean(division, totalDivisions).toFixed(2)}` +
    `  pedigree ${pedigree.toFixed(3)}  academyPeakMean ${academyPeakMean(pedigree).toFixed(2)}`,
  );
}
