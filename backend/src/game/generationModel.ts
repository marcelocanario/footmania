import type { Position } from "./types";
import { gameConfig } from "../config";

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
export const SENIOR_POSITION_WEIGHTS = [0.1, 0.14, 0.18, 0.32, 0.26] as const;

/**
 * Academy cohort position weights. Lives here beside the senior weights so the
 * population model can use them without importing squad orchestration.
 */
export const ACADEMY_POSITION_WEIGHTS = [0.1, 0.28, 0.26, 0.22, 0.14] as const;

const POSITION_GROUPS: readonly Position[] = [0, 1, 2, 3, 4];

/**
 * Build the senior roster position template using the canonical weights via the
 * largest-remainder method. Broad groups map to base positions 0..4 (GK, FB,
 * CB, MF, FW), matching the existing subposition assignment inside each group.
 */
export function seniorRosterTemplate(total: number): Position[] {
  const counts = allocateSlots(SENIOR_POSITION_WEIGHTS, total);
  if (counts.length !== POSITION_GROUPS.length) {
    throw new Error("Senior position weights must cover every position group");
  }
  const roster: Position[] = [];
  for (let i = 0; i < counts.length; i++) {
    for (let j = 0; j < counts[i]; j++) roster.push(POSITION_GROUPS[i]);
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
