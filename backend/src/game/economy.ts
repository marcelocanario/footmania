import { gameConfig, scaleReferenceSeasonFlow, seasonFlowScale } from "../config";
import { meaningfulSigningShare, qualityTierBudget } from "./budget";
import {
  MAX_CAREER_AGE,
  generationActivityModifiers,
  neutralCareerProfile,
  reconstructCurrentTarget,
  retirementProbability,
} from "./careerCurves";
import { seniorPositionWeights, qualitySigma, topDivisionMean } from "./generationModel";
import type { Position } from "./types";

export { scaleReferenceSeasonFlow, seasonFlowScale } from "../config";

export interface EconomyConfig {
  playerValue: {
    base: number;
    careerWeight: number;
    contractRange: number;
  };
  salary: {
    base: number;
    overallReference: number;
    overallExponent: number;
    multiplier: number;
    ageCurve: Record<number, number>;
    floor: number;
    academyMultiplier: number;
  };
  contracts: {
    maxContractSeasons: number;
    renewalMinRaise: number;
    renewalSkillRaiseWeight: number;
    renewalSkillExponent: number;
    renewalMaxRaise: number;
    renewalYouthPremiumWeight: number;
    renewalYouthPremiumAgeCurve: Record<number, number>;
    releaseClauseRemainingValuePct: number;
  };
}

export const economyConfig = (): EconomyConfig => ({
  playerValue: {
    base: gameConfig.playerValueBase,
    careerWeight: gameConfig.playerValueCareerWeight,
    contractRange: gameConfig.playerValueContractRange,
  },
  salary: {
    base: scaleReferenceSeasonFlow(gameConfig.salaryBase),
    overallReference: gameConfig.salaryOverallReference,
    overallExponent: gameConfig.salaryOverallExponent,
    multiplier: gameConfig.salaryMultiplier,
    ageCurve: gameConfig.salaryAgeCurve,
    floor: scaleReferenceSeasonFlow(gameConfig.salaryFloor),
    academyMultiplier: gameConfig.academySalaryMultiplier,
  },
  contracts: {
    maxContractSeasons: gameConfig.maxContractSeasons,
    renewalMinRaise: gameConfig.renewalMinRaise,
    renewalSkillRaiseWeight: gameConfig.renewalSkillRaiseWeight,
    renewalSkillExponent: gameConfig.renewalSkillExponent,
    renewalMaxRaise: gameConfig.renewalMaxRaise,
    renewalYouthPremiumWeight: gameConfig.renewalYouthPremiumWeight,
    renewalYouthPremiumAgeCurve: gameConfig.renewalYouthPremiumAgeCurve,
    releaseClauseRemainingValuePct: gameConfig.releaseClauseRemainingValuePct,
  },
});

export function curveMultiplier(curve: Record<number, number>, age: number): number {
  if (curve[age] !== undefined) return curve[age];
  const keys = Object.keys(curve)
    .map(Number)
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  if (keys.length === 0) return 1;
  if (age <= keys[0]) return curve[keys[0]];
  const last = keys[keys.length - 1];
  if (age >= last) return curve[last];
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i];
    const hi = keys[i + 1];
    if (age >= lo && age <= hi) {
      const vLo = curve[lo];
      const vHi = curve[hi];
      const t = hi === lo ? 0 : (age - lo) / (hi - lo);
      return vLo + (vHi - vLo) * t;
    }
  }
  return curve[last];
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Remaining contract in whole seasons, derived from the configured season length. */
export function remainingSeasons(contractDays: number): number {
  if (contractDays <= 0) return 0;
  return contractDays / gameConfig.seasonDays;
}

// ---------------------------------------------------------------------------
// Player market value (BUSINESS_RULES §3.4)
// ---------------------------------------------------------------------------

/**
 * The continuous economic-quality coordinate of a visible OVR, expressed as a
 * position on the season-budget tier curve.
 *
 * A player exactly at the configured top-division mean sits at tier 1; each
 * population standard deviation of ability above or below that moves one
 * continuous decay step. The coordinate is fractional, may fall below 1 for an
 * exceptional player, and is never persisted, exposed, or derived from how many
 * divisions the pyramid currently has, so prices do not move when the pyramid
 * grows or shrinks.
 */
function qualityTier(overall: number): number {
  return 1 + (topDivisionMean() - clamp(overall, 1, 100)) / qualitySigma();
}

/**
 * What one season of a player of this visible ability is worth: the share of the
 * tier budget a club at his quality level receives that one meaningful
 * first-team signing is expected to cost.
 *
 * This reuses the authoritative tier-budget curve rather than a second price
 * curve, so ability is priced in exactly the currency the pyramid pays out.
 */
function qualityPrice(overall: number): number {
  return qualityTierBudget(qualityTier(overall)) * meaningfulSigningShare();
}

/**
 * The neutral public career curve: OVR-equivalent movement by age along the
 * population-average profile at the population-average historical activity.
 *
 * The peak target passed to `reconstructCurrentTarget` is arbitrary because only
 * DIFFERENCES along this curve are ever used, so the offset cancels. Cached
 * because the curve depends on configuration alone.
 */
const neutralCurveCache = new Map<number, number>();

function neutralCurve(age: number): number {
  const cached = neutralCurveCache.get(age);
  if (cached !== undefined) return cached;
  const activity = generationActivityModifiers();
  const value = reconstructCurrentTarget(neutralCareerProfile(), 0, age, activity.growth, activity.decline).current;
  neutralCurveCache.set(age, value);
  return value;
}

/**
 * The OVR the player is publicly expected to have at `futureAge`.
 *
 * The VISIBLE current OVR is always the anchor and only neutral future movement
 * is added, so growth or decline the player has already lived through is never
 * counted a second time.
 */
function projectedOverall(currentOverall: number, currentAge: number, futureAge: number): number {
  return clamp(currentOverall + neutralCurve(futureAge) - neutralCurve(currentAge), 1, 100);
}

/**
 * Probability an owned player of `currentAge` is still playing at `futureAge`,
 * averaged over the canonical senior position mix.
 *
 * Averaging across positions keeps the goalkeeper retirement grace in the model
 * without making value position-dependent. Free-agent terminal deletion is
 * deliberately excluded: that is a market/population outcome, not intrinsic
 * retirement risk for a player a club owns.
 */
const survivalCache = new Map<string, number>();

function genericSurvival(currentAge: number, futureAge: number): number {
  const key = `${currentAge}|${futureAge}`;
  const cached = survivalCache.get(key);
  if (cached !== undefined) return cached;
  let total = 0;
  // §13.2: generic player-value survival continues averaging the five senior
  // broad-group weights (GK/FB/CB/MF/FW), never the nine child roles.
  const GROUP_POSITIONS: import("./positions").NaturalPosition[][] = [
    ["GK"],
    ["LB", "RB"],
    ["CB"],
    ["DM", "AM"],
    ["LW", "RW", "ST"],
  ];
  const groupWeights = seniorPositionWeights();
  for (let position = 0; position < groupWeights.length; position++) {
    let survival = 1;
    // The current season always survives; every later season applies the
    // retirement probability at the age reached at that rollover, matching
    // processSeasonEndContracts.
    for (let year = currentAge + 1; year <= futureAge; year++) {
      survival *= 1 - retirementProbability(year, GROUP_POSITIONS[position][0]);
    }
    total += groupWeights[position] * survival;
  }
  survivalCache.set(key, total);
  return total;
}

/**
 * Expected economic quality the player still has left to deliver: neutral future
 * quality price summed over the remaining career horizon, discounted by the
 * generic probability he is still playing.
 *
 * Uses raw `qualityPrice` only. It must never call `calculatePlayerValue`, which
 * would make the model recursive.
 */
function careerScore(overall: number, age: number): number {
  // A player already past the tracked horizon still plays the current season.
  if (age > MAX_CAREER_AGE) return qualityPrice(overall);
  let total = 0;
  for (let futureAge = age; futureAge <= MAX_CAREER_AGE; futureAge++) {
    total += genericSurvival(age, futureAge) * qualityPrice(projectedOverall(overall, age, futureAge));
  }
  return total;
}

/**
 * How much AGE is worth: the expected remaining career of this player against
 * the expected remaining career of the SAME visible OVR at the neutral peak age.
 *
 * Because the reference uses the same current OVR, a player at the mean peak age
 * scores exactly 1 and the multiplier is neutral there by construction.
 * `playerValueCareerWeight` then tempers the ratio so total lifetime output
 * cannot overwhelm present ability.
 */
export function careerValueMultiplier(overall: number, age: number): number {
  const cfg = economyConfig().playerValue;
  const reference = careerScore(overall, neutralCareerProfile().peakAge);
  if (reference <= 0) return 1;
  return Math.pow(careerScore(overall, age) / reference, cfg.careerWeight);
}

/**
 * The contract-length adjustment: a modest, symmetric band around the midpoint
 * of the selectable contract range.
 *
 * The neutral length is derived, not configured, so the per-season step lands
 * exactly on both bounds at the extremes of the range. Remaining contract is
 * deliberately absent from `careerScore`: pricing it as extra expected service
 * as well would count it twice and could let it overtake age.
 */
export function contractValueMultiplier(remainingContractSeasons: number): number {
  const cfg = economyConfig().playerValue;
  const maxSeasons = economyConfig().contracts.maxContractSeasons;
  const neutral = (1 + maxSeasons) / 2;
  const step = (2 * cfg.contractRange) / Math.max(1, maxSeasons - 1);
  return clamp(1 + (remainingContractSeasons - neutral) * step, 1 - cfg.contractRange, 1 + cfg.contractRange);
}

/**
 * Market value of a player, anchored to the configured Division 1 season budget.
 *
 * Deterministic: only the PUBLIC inputs overall, age, and remaining contract are
 * used. The signature deliberately takes three numbers rather than a `Player` so
 * a hidden career profile, potential, form, position, or club cannot be passed
 * in by accident.
 *
 * `playerValueBase` is applied here and only here, which makes it a true global
 * scalar: it is excluded from `careerScore` so it cannot distort the age model.
 */
export function calculatePlayerValue(overall: number, age: number, remainingContractSeasons: number): number {
  const cfg = economyConfig().playerValue;
  const overallClamped = clamp(overall, 1, 100);
  return Math.max(
    1,
    Math.round(
      cfg.base *
        qualityPrice(overallClamped) *
        careerValueMultiplier(overallClamped, age) *
        contractValueMultiplier(remainingContractSeasons),
    ),
  );
}

/**
 * Drop the configuration-derived valuation caches. Only needed by tests that
 * mutate the career or generation configuration in place.
 */
export function resetPlayerValueCache(): void {
  neutralCurveCache.clear();
  survivalCache.clear();
}

/**
 * Suggested per-season salary for a player about to sign a contract. Used for
 * generation and first contracts; persisted salaries are contractual and fixed.
 */
export function calculateBaseSalary(overall: number, age: number): number {
  const cfg = economyConfig().salary;
  const overallClamped = clamp(overall, 1, 100);
  const baseSalary = cfg.base * Math.pow(overallClamped / cfg.overallReference, cfg.overallExponent);
  const ageMult = curveMultiplier(cfg.ageCurve, age);
  return Math.max(cfg.floor, Math.round(baseSalary * ageMult * cfg.multiplier));
}

/**
 * Annual demand rate a player attaches to each season of a new professional
 * contract: a floor, a visible-skill component, and a visible-age youth
 * premium. The youth premium is what makes locking a promising young player
 * into a long deal expensive.
 *
 * It reads visible age ONLY. Feeding hidden growth potential in here would leak
 * scouting information through a public salary quote.
 */
export function professionalAnnualDemandRate(currentOverall: number, currentAge: number): number {
  const cfg = economyConfig().contracts;
  const skillNormalized = (clamp(currentOverall, 1, 100) - 1) / 98;
  const skillComponent = cfg.renewalSkillRaiseWeight * Math.pow(skillNormalized, cfg.renewalSkillExponent);
  const youthComponent = cfg.renewalYouthPremiumWeight * curveMultiplier(cfg.renewalYouthPremiumAgeCurve, currentAge);
  return clamp(cfg.renewalMinRaise + skillComponent + youthComponent, cfg.renewalMinRaise, cfg.renewalMaxRaise);
}

/**
 * Levelize a compounding annual demand into one constant per-season salary over
 * the exact contract horizon.
 *
 *   totalSeasonEquivalents = currentSeasonFraction + futureCompleteSeasons
 *   total  = baseline × fraction + baseline × Σ_{i=1..n} (1+r)^i
 *   salary = total / totalSeasonEquivalents
 *
 * `futureCompleteSeasons` is the number of complete seasons IN ADDITION TO the
 * remainder of the current season. It is never a total contract length: passing
 * a total here would price one extra season of service.
 */
export function levelizedContractSalary(
  baseline: number,
  annualDemandRate: number,
  futureCompleteSeasons: number,
  currentSeasonFraction: number,
): number {
  const n = Math.max(0, futureCompleteSeasons);
  const fraction = clamp(currentSeasonFraction, 0, 1);
  const horizon = fraction + n;
  if (horizon <= 0) return Math.round(baseline);
  const r = clamp(annualDemandRate, 0, 1);
  if (r <= 0 || n <= 0) return Math.round(baseline);
  const compounded = Math.pow(1 + r, n + 1) - (1 + r);
  const total = baseline * fraction + baseline * (compounded / r);
  return Math.round(total / horizon);
}

/**
 * The single professional-contract salary authority. Every newly negotiated
 * professional contract goes through here: ordinary renewals, renewals of a
 * promoted player's retained academy contract, the contract attached to a
 * winning transfer bid, free-agent signings, and generated first contracts.
 *
 * Passing `currentSalary` applies the NO-PAY-CUT floor: the contract can never
 * be worth less per season than the player already earns. That holds for a club
 * renewal and for a transfer, because a player under contract does not accept
 * less to change clubs.
 *
 * Omitting it marks a contract with no incumbent wage to protect — a free-agent
 * signing or a generated first contract. An expired salary does not follow a
 * player into free agency, so someone who rejected a renewal may legitimately
 * end up asking for less once his contract has run out.
 */
export function calculateProfessionalContractSalary(opts: {
  currentOverall: number;
  currentAge: number;
  /** Complete seasons in addition to the remainder of the current season. */
  futureCompleteSeasons: number;
  currentSeasonFraction: number;
  /** Present only for a club renewal; acts as a no-pay-cut floor. */
  currentSalary?: number;
}): number {
  const marketBaseline = calculateBaseSalary(opts.currentOverall, opts.currentAge);
  const baseline = opts.currentSalary === undefined ? marketBaseline : Math.max(opts.currentSalary, marketBaseline);
  const rate = professionalAnnualDemandRate(opts.currentOverall, opts.currentAge);
  return levelizedContractSalary(baseline, rate, opts.futureCompleteSeasons, opts.currentSeasonFraction);
}

/** Complete seasons an academy-origin contract still has to run, including this one. */
export function academyContractSeasonsForAge(currentAge: number): number {
  return Math.max(1, gameConfig.playerGenerationRules.academyContractEndAge - currentAge);
}

/**
 * Academy salary: the configured fraction of the salary the SAME player would
 * receive from the complete professional calculation for his current OVR, age,
 * exact term, and season fraction.
 *
 * Academy intake happens at the season boundary, so the current-season fraction
 * is one and a five-season contract is the current season plus four future
 * complete seasons. No professional floor is reapplied afterwards — that would
 * silently break the configured fraction, and the resulting low release clause
 * is a deliberate mobility mechanism for promoted academy players.
 */
export function calculateAcademySalary(currentOverall: number, currentAge: number): number {
  const cfg = economyConfig().salary;
  const seasons = academyContractSeasonsForAge(currentAge);
  const professionalEquivalent = calculateProfessionalContractSalary({
    currentOverall,
    currentAge,
    futureCompleteSeasons: seasons - 1,
    currentSeasonFraction: 1,
  });
  return Math.max(1, Math.round(professionalEquivalent * cfg.academyMultiplier));
}

/** Contract duration in game-days: the remaining current season plus the selected term. */
export function contractDaysForTerm(futureCompleteSeasons: number): number {
  return (Math.max(1, Math.trunc(futureCompleteSeasons)) + 1) * gameConfig.seasonDays;
}

/** Contract duration in game-days for an academy-origin term ending at age 21. */
export function academyContractDaysForAge(currentAge: number): number {
  return academyContractSeasonsForAge(currentAge) * gameConfig.seasonDays;
}

/** Fraction of the current season remaining for a newly negotiated contract. */
export function remainingSeasonFractionForDay(seasonDayIndex: number): number {
  const day = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(seasonDayIndex)));
  return Math.max(0, (gameConfig.seasonDays - day) / gameConfig.seasonDays);
}

/**
 * All server-authoritative salary demands for the selectable contract terms.
 * `currentSalary` is supplied only for club renewals (no-pay-cut baseline).
 */
export function contractDemandOptions(
  currentOverall: number,
  currentAge: number,
  seasonDayIndex: number,
  currentSalary?: number,
): Record<number, number> {
  const currentSeasonFraction = remainingSeasonFractionForDay(seasonDayIndex);
  return Object.fromEntries(
    Array.from({ length: gameConfig.maxContractSeasons }, (_, index) => {
      const futureCompleteSeasons = index + 1;
      return [
        futureCompleteSeasons,
        calculateProfessionalContractSalary({ currentOverall, currentAge, futureCompleteSeasons, currentSeasonFraction, currentSalary }),
      ];
    }),
  );
}

/**
 * Release clause = remaining contract value x configured percentage.
 * Always derived from the current salary and remaining contract length so it
 * stays in sync automatically.
 */
export function calculateReleaseClause(salaryPerSeason: number, remainingSeasons: number): number {
  const pct = economyConfig().contracts.releaseClauseRemainingValuePct;
  return Math.round(salaryPerSeason * remainingSeasons * pct);
}
