import type { Position } from "./types";
import { gameConfig } from "../config";
import { NATURAL_POSITION_ORDER, POSITION_GROUPS } from "./positions";
import { allocateSeededCounts } from "./allocation";
/**
 * Low-level generation MODEL: the division-quality anchors and canonical roster
 * weights, with no dependency on the economy, the RNG, or squad orchestration.
 *
 * These live apart from `playerGeneration.ts` because the player-value economy
 * needs the same Division 1 quality authorities that generation uses, and
 * `playerGeneration.ts` imports the economy. Splitting the pure model out keeps
 * one implementation of each formula without a circular import;
 * `playerGeneration.ts` re-exports everything here so existing callers are
 * unaffected.
 */

// ---------------------------------------------------------------------------
// Fixed statistical constants — not designer-facing knobs.
// ---------------------------------------------------------------------------

export const PLAYER_Z_MIN = -3.0;
export const PLAYER_Z_MAX = 3.0;
export const DIVISION_CURVE_K = 0.5;

/** Authoritative engine OVR bounds (the engine's global 1..100 scale). */
export const OVR_MIN = 1;
export const OVR_MAX = 100;

/** Full OVR range. */
export function overallRange(): number {
  return OVR_MAX - OVR_MIN;
}

// ---------------------------------------------------------------------------
// Division quality anchors (spec §8–§11)
// ---------------------------------------------------------------------------

/** Senior within-division quality standard deviation, directly in OVR points. */
export function qualitySigma(): number {
  return gameConfig.playerGeneration.playerQualitySpreadOverall;
}

/** Academy quality standard deviation: wider, to preserve rare wonderkids. */
export function academyQualitySigma(): number {
  return gameConfig.playerGeneration.academyQualitySpreadOverall;
}

/** Designer-controlled top-division senior mean (spec §8). */
export function topDivisionMean(): number {
  return gameConfig.playerGeneration.topDivisionMeanOverall;
}

/** Bottom-division senior mean: top mean minus the configured OVR span. */
export function bottomDivisionMean(): number {
  return topDivisionMean() - gameConfig.playerGeneration.divisionOverallSpan;
}

/**
 * Canonical division-strength function S(D) (spec §10). D = 1 is the strongest
 * division and D = N the weakest. S is clamped into [0, 1].
 */
export function divisionStrength(division: number, totalDivisions: number): number {
  if (totalDivisions <= 1) return 1;
  const d = Math.max(1, Math.min(totalDivisions, Math.round(division)));
  const numerator = Math.log(1 + DIVISION_CURVE_K * (d - 1));
  const denominator = Math.log(1 + DIVISION_CURVE_K * (totalDivisions - 1));
  if (denominator <= 0) return 1;
  const s = 1 - numerator / denominator;
  return Math.max(0, Math.min(1, s));
}

/** Division mean μ(D) = μ_bottom + divisionOverallSpan·S(D) (spec §11). */
export function divisionMean(division: number, totalDivisions: number): number {
  return bottomDivisionMean() + gameConfig.playerGeneration.divisionOverallSpan * divisionStrength(division, totalDivisions);
}

// ---------------------------------------------------------------------------
// Academy pedigree (spec §22–§24)
// ---------------------------------------------------------------------------

/**
 * Academy pedigree from current and highest-ever division strength, using the
 * configurable weights normalized here so designers can retune either side
 * without also rescaling the pedigree.
 *
 * Highest-ever division is an intended permanent ratchet: once a club has
 * reached D1, the historical component keeps using D1 strength forever.
 */
export function academyPedigree(currentDivision: number, highestDivisionReached: number, totalDivisions: number): number {
  const { academyCurrentDivisionWeight, academyHighestEverDivisionWeight } = gameConfig.playerGeneration;
  const weightSum = academyCurrentDivisionWeight + academyHighestEverDivisionWeight;
  if (weightSum <= 0) return 0;
  const sCurrent = divisionStrength(currentDivision, totalDivisions);
  const sHistory = divisionStrength(highestDivisionReached, totalDivisions);
  const pedigree = (academyCurrentDivisionWeight * sCurrent + academyHighestEverDivisionWeight * sHistory) / weightSum;
  return Math.max(0, Math.min(1, pedigree));
}

// ---------------------------------------------------------------------------
// Career peak anchors (§5.2 / §5.3)
// ---------------------------------------------------------------------------

/**
 * Mean personal career PEAK for a senior generated in division D. The peak sits
 * a configured offset above the division's all-age population mean, because a
 * standing population is a mix of pre-peak, peak and post-peak players whose
 * average lands back on the division mean.
 */
export function seniorPeakMean(division: number, totalDivisions: number): number {
  return divisionMean(division, totalDivisions) + gameConfig.playerGeneration.seniorPeakOverallOffset;
}

/**
 * Mean personal career PEAK for an academy recruit. Pedigree shifts the career
 * anchor rather than handing out immediate current-OVR — a strong academy
 * produces better prospects, not ready-made first-team stars.
 *
 * With the pedigree boost set equal to the division span, a stable D1 academy
 * has the same normal peak anchor as D1 seniors.
 */
export function academyPeakMean(pedigree: number): number {
  const { seniorPeakOverallOffset, academyPedigreeOverallBoost } = gameConfig.playerGeneration;
  return bottomDivisionMean() + seniorPeakOverallOffset + academyPedigreeOverallBoost * pedigree;
}

// ---------------------------------------------------------------------------
// Roster slot allocation (spec §17, largest-remainder method)
// ---------------------------------------------------------------------------

/** Deterministic largest-remainder allocation of `total` slots across weights. */
export function allocateSlots(weights: readonly number[], total: number): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / weightSum) * total);
  const allocated = exact.map((x) => Math.floor(x));
  let remaining = total - allocated.reduce((a, b) => a + b, 0);
  const fractions = exact.map((x, i) => x - allocated[i]);
  const order = fractions.map((f, i) => i).sort((a, b) => fractions[b] - fractions[a]);
  for (let i = 0; i < remaining; i++) {
    allocated[order[i % order.length]] += 1;
  }
  return allocated;
}

/**
 * Canonical senior weights: GK 10% / FB 14% / CB 18% / MF 32% / FW 26%.
 *
 * Also the position mix the player-value model averages retirement risk over,
 * so market value carries the real age risk of the population (including the
 * goalkeeper retirement grace) without ever becoming position-dependent.
 */
export function seniorPositionWeights(): number[] {
  const { seniorGroups } = gameConfig.playerGeneration.positionMix;
  return POSITION_GROUPS.map((group) => seniorGroups[group]);
}

/**
 * Academy cohort position weights. Lives here beside the senior weights so the
 * population model can use them without importing squad orchestration.
 */
export function academyPositionWeights(): number[] {
  const { academyGroups } = gameConfig.playerGeneration.positionMix;
  return POSITION_GROUPS.map((group) => academyGroups[group]);
}

/**
 * Build the senior roster position template using the canonical broad weights
 * via the largest-remainder method, then split each broad group into the nine
 * natural positions (§11.3). Broad groups map to natural positions; the
 * within-group split uses the configured positionMix.
 */
// Deterministic seed for seniorRosterTemplate within-group splits.
// seniorRosterTemplate is used outside a world context (calibration scripts,
// projection), so there is no world seed. Use a stable synthetic key derived
// from the only deterministic input — the requested `total` — plus the group
// identity. This preserves §11.2 unbiased rounding (the projection never
// claims a fixed 2/2/4 for FW 8) while keeping the projection deterministic.
//
function seniorRosterWithinSeed(total: number, group: string): string {
  return `seniorRosterTemplate|${total}|split|${group}`;
}

export function seniorRosterTemplate(total: number): Position[] {
  const { seniorGroups, withinGroup } = gameConfig.playerGeneration.positionMix;
  const counts = allocateSlots(POSITION_GROUPS.map((g) => seniorGroups[g]), total);
  const roster: Position[] = [];
  for (let i = 0; i < POSITION_GROUPS.length; i++) {
    const group = POSITION_GROUPS[i];
    // §11.3: within-group splits use seeded systematic rounding, not
    // largest-remainder.
    const seeded = allocateSeededCounts(counts[i], withinGroup[group], seniorRosterWithinSeed(total, group));
    // Canonical natural-position display order (§11.3 step 3).
    for (const role of NATURAL_POSITION_ORDER) {
      for (let k = 0; k < (seeded[role] ?? 0); k++) roster.push(role);
    }
  }
  return roster;
}

// ---------------------------------------------------------------------------
// Initial-club cohort quality targets (§ plans/initial-senior-roster-generation.md)
// ---------------------------------------------------------------------------

/**
 * Division-relative conditioning targets shared by initial senior current OVR
 * and initial-academy personal peaks. Division 1 is only one instance of the
 * existing pyramid quality curve; no division-specific table is introduced.
 */
export function initialClubQualityTargets(
  division: number,
  totalDivisions: number,
): {
  mean: number;
  lower: number;
  upper: number;
} {
  const mean =
    divisionMean(division, totalDivisions) + gameConfig.playerGeneration.initialClubTargetMeanOffsetOverall;
  const half = gameConfig.playerGeneration.initialClubTargetBandHalfWidthOverall;
  return {
    mean,
    lower: Math.max(OVR_MIN, mean - half),
    upper: Math.min(OVR_MAX, mean + half),
  };
}
