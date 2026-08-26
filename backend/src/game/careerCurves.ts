import type { PlayerCareerProfile, Position, RngState } from "./types";
import { nextDouble, truncatedNormal } from "./rng";
import { DEVELOPMENT } from "./constants";
import { gameConfig } from "../config";

/**
 * Career-shaped growth/decline authority.
 *
 * Every quality-over-time question in the game resolves here: initial
 * generation reconstructs where a player already is on his own curve, live
 * development advances him along the same curve, and intake planning /
 * analytics reuse the same survival model. There is no second potential
 * ceiling, growth tier, or development-rate multiplier anywhere.
 *
 * A player's career is described by exactly five hidden values:
 *   growthPotential   0..1  total growth magnitude
 *   growthSpeed       0..1  how front-loaded that growth is before the peak
 *   peakAge           int   exact age growth ends and decline begins
 *   declinePotential  0..1  total decline magnitude
 *   declineSpeed      0..1  how front-loaded that decline is after the peak
 */

/** A monotonic cumulative curve as `[x, y]` control points. */
export type CurvePoints = readonly (readonly [number, number])[];
/** A piecewise-linear probability density over [0, 1] as `[x, density]` points. */
export type DensityPoints = readonly (readonly [number, number])[];

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

// ---------------------------------------------------------------------------
// Piecewise-linear helpers
// ---------------------------------------------------------------------------

/** Evaluate a piecewise-linear cumulative curve, clamped outside its domain. */
export function evaluateCurve(points: CurvePoints, x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x >= x0 && x <= x1) {
      const span = x1 - x0;
      return span <= 0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / span;
    }
  }
  return last[1];
}

/**
 * Interpolate between the slow and fast cumulative boundary curves. `speed`
 * changes timing and steepness only: both boundaries terminate at one, so the
 * total magnitude is untouched.
 */
export function interpolateCurves(slow: CurvePoints, fast: CurvePoints, x: number, speed: number): number {
  const s = clamp(speed, 0, 1);
  const lo = evaluateCurve(slow, x);
  const hi = evaluateCurve(fast, x);
  return lo + (hi - lo) * s;
}

/** Total probability mass of a piecewise-linear density. */
export function densityMass(points: DensityPoints): number {
  let mass = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, d0] = points[i];
    const [x1, d1] = points[i + 1];
    mass += ((d0 + d1) / 2) * (x1 - x0);
  }
  return mass;
}

/** Mean of a piecewise-linear density (used by calibration and projections). */
export function densityMean(points: DensityPoints): number {
  const mass = densityMass(points);
  if (mass <= 0) return 0.5;
  let moment = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, d0] = points[i];
    const [x1, d1] = points[i + 1];
    const w = x1 - x0;
    if (w <= 0) continue;
    // ∫ x·(d0 + (d1-d0)·t/w) dx with x = x0 + t
    moment += w * (x0 * (d0 + d1) / 2 + w * (d0 / 6 + d1 / 3));
  }
  return moment / mass;
}

/**
 * Inverse-CDF sample from a piecewise-linear density over [0, 1]. Exact within
 * each segment (the segment CDF is quadratic), so the realized distribution
 * matches the configured density rather than approximating it.
 */
export function sampleDensity(rng: RngState, points: DensityPoints): number {
  const mass = densityMass(points);
  if (mass <= 0) return 0.5;
  let target = nextDouble(rng) * mass;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, d0] = points[i];
    const [x1, d1] = points[i + 1];
    const w = x1 - x0;
    if (w <= 0) continue;
    const segmentMass = ((d0 + d1) / 2) * w;
    if (target > segmentMass) {
      target -= segmentMass;
      continue;
    }
    const slope = (d1 - d0) / w;
    if (Math.abs(slope) < 1e-12) {
      return clamp(x0 + (d0 > 0 ? target / d0 : w * 0.5), x0, x1);
    }
    // Solve (slope/2)·t² + d0·t − target = 0 for t in [0, w].
    const disc = Math.max(0, d0 * d0 + 2 * slope * target);
    const t = (-d0 + Math.sqrt(disc)) / slope;
    return clamp(x0 + t, x0, x1);
  }
  return points[points.length - 1][0];
}

// ---------------------------------------------------------------------------
// Career profile
// ---------------------------------------------------------------------------

/** Draw the five hidden career-profile attributes. */
export function generateCareerProfile(rng: RngState): PlayerCareerProfile {
  const cfg = gameConfig.playerCareer;
  const growthPotential = sampleDensity(rng, cfg.growthPotentialDistribution);
  const growthSpeed = sampleDensity(rng, cfg.growthSpeedDistribution);
  const peak = cfg.peakAgeDistribution;
  const peakAge = Math.round(clamp(truncatedNormal(rng, peak.mean, peak.stdDev, peak.min, peak.max), peak.min, peak.max));
  const declinePotential = sampleDensity(rng, cfg.declinePotentialDistribution);
  const declineSpeed = sampleDensity(rng, cfg.declineSpeedDistribution);
  return { growthPotential, growthSpeed, peakAge, declinePotential, declineSpeed };
}

/**
 * The PUBLIC career profile: the population average of every configured career
 * distribution, with no reference to any individual player.
 *
 * Market value has to price age without leaking scouting information, so it
 * projects every player along this one neutral curve instead of his own hidden
 * profile. Two players with the same visible OVR and age are therefore always
 * worth the same, however differently their real careers will unfold.
 *
 * Every value is derived from the configured distribution — `densityMean` for
 * the four 0-to-1 attributes and the configured mean for the peak age — so
 * retuning generation moves the valuation curve with it rather than leaving a
 * stale literal behind.
 */
export function neutralCareerProfile(): PlayerCareerProfile {
  const cfg = gameConfig.playerCareer;
  return {
    growthPotential: densityMean(cfg.growthPotentialDistribution),
    growthSpeed: densityMean(cfg.growthSpeedDistribution),
    peakAge: Math.round(cfg.peakAgeDistribution.mean),
    declinePotential: densityMean(cfg.declinePotentialDistribution),
    declineSpeed: densityMean(cfg.declineSpeedDistribution),
  };
}

// ---------------------------------------------------------------------------
// Activity modifiers
// ---------------------------------------------------------------------------

/** Lower activity realizes less growth; it never accelerates a player's curve. */
export function calculateGrowthActivityModifier(activity: number): number {
  const inactive = DEVELOPMENT.activity.inactiveGrowthMultiplier;
  return inactive + (1 - inactive) * clamp(activity, 0, 1);
}

/** Higher activity slows decline, so the modifier shrinks as activity rises. */
export function calculateDeclineActivityModifier(activity: number): number {
  return 1 + (DEVELOPMENT.activity.inactiveDeclineMultiplier - 1) * (1 - clamp(activity, 0, 1));
}

/** Historical activity a generated player is assumed to have had. */
export function generationActivityModifiers(): { growth: number; decline: number } {
  const activity = gameConfig.playerCareer.generationHistoricalActivity;
  return { growth: calculateGrowthActivityModifier(activity), decline: calculateDeclineActivityModifier(activity) };
}

/** Total OVR-equivalent growth this player can ever realize. */
export function careerGrowthBudget(profile: PlayerCareerProfile): number {
  return gameConfig.playerCareer.maximumCareerGrowthOverall * clamp(profile.growthPotential, 0, 1);
}

/** Total OVR-equivalent decline this player can ever suffer. */
export function careerDeclineBudget(profile: PlayerCareerProfile): number {
  return gameConfig.playerCareer.maximumCareerDeclineOverall * clamp(profile.declinePotential, 0, 1);
}

/** Fraction of the career from academy entry to the personal peak, in [0, 1]. */
export function normalizedAgeProgress(entryAge: number, age: number, peakAge: number): number {
  const span = peakAge - entryAge;
  if (span <= 0) return 1;
  return clamp((age - entryAge) / span, 0, 1);
}

/** Cumulative share of the growth budget realized by `age` at full activity. */
export function cumulativeGrowthFraction(profile: PlayerCareerProfile, age: number): number {
  const cfg = gameConfig.playerCareer;
  const entryAge = gameConfig.playerGenerationRules.academyMinAge;
  const progress = normalizedAgeProgress(entryAge, age, profile.peakAge);
  return clamp(interpolateCurves(cfg.growthSlowCurve, cfg.growthFastCurve, progress, profile.growthSpeed), 0, 1);
}

/** Cumulative share of the decline budget realized by `age` at neutral activity. */
export function cumulativeDeclineFraction(profile: PlayerCareerProfile, age: number): number {
  const cfg = gameConfig.playerCareer;
  const yearsSincePeak = Math.max(0, age - profile.peakAge);
  return clamp(interpolateCurves(cfg.declineSlowCurve, cfg.declineFastCurve, yearsSincePeak, profile.declineSpeed), 0, 1);
}

/**
 * Instantaneous OVR-equivalent rate of change per season at `age`, before
 * activity modifiers. Positive before the personal peak, negative after it.
 * The live development system integrates this; generation reconstructs the
 * same integral in closed form via the cumulative fractions above.
 */
export function careerSeasonalRate(profile: PlayerCareerProfile, age: number): number {
  const step = 0.5;
  if (age < profile.peakAge) {
    const growth = careerGrowthBudget(profile);
    if (growth <= 0) return 0;
    const from = cumulativeGrowthFraction(profile, age);
    const to = cumulativeGrowthFraction(profile, age + step);
    return (growth * (to - from)) / step;
  }
  const decline = careerDeclineBudget(profile);
  if (decline <= 0) return 0;
  const from = cumulativeDeclineFraction(profile, age);
  const to = cumulativeDeclineFraction(profile, age + step);
  return -(decline * (to - from)) / step;
}

/**
 * Reconstruct the OVR a generated player should currently have, given the peak
 * he is heading for and how much of his curve he has already lived.
 *
 * Lower historical activity reduces realized growth rather than moving a young
 * player closer to his peak, and growth not realized before the personal peak
 * is lost rather than banked.
 */
export function reconstructCurrentTarget(
  profile: PlayerCareerProfile,
  peakTarget: number,
  age: number,
  growthActivityModifier: number,
  declineActivityModifier: number,
): { current: number; growthConsumed: number; declineConsumed: number } {
  const growthBudget = careerGrowthBudget(profile);
  const entryTarget = peakTarget - growthBudget;
  const growthConsumed = growthBudget * cumulativeGrowthFraction(profile, age) * growthActivityModifier;
  const realizedPreDecline = entryTarget + growthConsumed;
  const declineBudget = careerDeclineBudget(profile);
  const declineConsumed = declineBudget * cumulativeDeclineFraction(profile, age) * declineActivityModifier;
  return { current: realizedPreDecline - declineConsumed, growthConsumed, declineConsumed };
}

// ---------------------------------------------------------------------------
// Active-career survival model (§5.5)
// ---------------------------------------------------------------------------

function retirementRollThreshold(age: number, position: Position): number {
  if (age <= 32) return 100;
  const retirementAge = position === 0 ? age - 3 : age;
  if (retirementAge < 32) return 100;
  if (retirementAge === 32) return 99;
  if (retirementAge <= 34) return 90;
  if (retirementAge <= 35) return 55;
  if (retirementAge <= 36) return 30;
  if (retirementAge <= 38) return 15;
  if (retirementAge <= 39) return 5;
  if (retirementAge <= 40) return 3;
  if (retirementAge <= 42) return 2;
  if (retirementAge <= 48) return 1;
  return 0;
}

/** Exact season-end retirement probability. Goalkeepers keep the three-year grace. */
export function retirementProbability(age: number, position: Position): number {
  return (100 - retirementRollThreshold(age, position)) / 100;
}

export { retirementRollThreshold };

/**
 * Probability that a player of this age leaves the active population during a
 * season for a non-retirement structural reason: his contract expires, no club
 * signs him, and he is deleted at the end of the free-agent retention period.
 *
 * Calibrated from full-world simulation rather than derived, because it depends
 * on manager behavior. Transfers, signings, loans, and dormancy are NOT drains
 * — they only change ownership or the boundary a stable stock sits inside.
 */
export function terminalDeletionProbability(age: number): number {
  const curve = gameConfig.playerCareer.freeAgentTerminalLossAgeCurve;
  const keys = Object.keys(curve).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  if (age <= keys[0]) return clamp(curve[keys[0]], 0, 1);
  const last = keys[keys.length - 1];
  if (age >= last) return clamp(curve[last], 0, 1);
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i];
    const hi = keys[i + 1];
    if (age >= lo && age <= hi) {
      const t = hi === lo ? 0 : (age - lo) / (hi - lo);
      return clamp(curve[lo] + (curve[hi] - curve[lo]) * t, 0, 1);
    }
  }
  return clamp(curve[last], 0, 1);
}

/** Oldest age the survival model tracks; beyond this the standing weight is nil. */
export const MAX_CAREER_AGE = 45;

/**
 * Standing-population weight by age for one position: the probability that a
 * player who entered the senior population at the automatic-promotion age is
 * still inside the active boundary at each later age.
 *
 * Shared by initial senior age generation, academy intake planning, long-running
 * calibration, and admin analytics so those four never disagree.
 */
export function seniorSurvivalWeights(position: Position): Map<number, number> {
  const entryAge = gameConfig.playerGenerationRules.academyAutomaticPromotionAge;
  const weights = new Map<number, number>();
  let weight = 1;
  weights.set(entryAge, weight);
  for (let age = entryAge + 1; age <= MAX_CAREER_AGE; age++) {
    weight *= (1 - retirementProbability(age, position)) * (1 - terminalDeletionProbability(age));
    if (weight <= 1e-9) break;
    weights.set(age, weight);
  }
  return weights;
}

/** Expected seasons a player spends inside the active senior population. */
export function expectedActiveSeniorSeasons(position: Position): number {
  let total = 0;
  for (const weight of seniorSurvivalWeights(position).values()) total += weight;
  return total;
}

/**
 * Expected seasons one academy recruit occupies a population slot, from academy
 * entry through every terminal drain. Feeds the retirement baseline.
 */
export function expectedActivePlayerLifetimeFromAcademyEntry(positionWeights: readonly number[]): number {
  const rules = gameConfig.playerGenerationRules;
  const meanIntakeAge = (rules.academyMinAge + rules.academyMaxAge) / 2;
  const academySeasons = rules.academyAutomaticPromotionAge - meanIntakeAge;
  const weightSum = positionWeights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return academySeasons;
  const seniorSeasons = positionWeights.reduce(
    (sum, weight, position) => sum + weight * expectedActiveSeniorSeasons(position as Position),
    0,
  ) / weightSum;
  return academySeasons + seniorSeasons;
}

/** Draw an initial senior age from the standing active-career distribution. */
export function drawStandingSeniorAge(rng: RngState, position: Position): number {
  const weights = seniorSurvivalWeights(position);
  let total = 0;
  for (const weight of weights.values()) total += weight;
  let target = nextDouble(rng) * total;
  let lastAge = gameConfig.playerGenerationRules.academyAutomaticPromotionAge;
  for (const [age, weight] of weights) {
    lastAge = age;
    if (target < weight) return age;
    target -= weight;
  }
  return lastAge;
}
