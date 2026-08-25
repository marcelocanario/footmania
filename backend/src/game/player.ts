import type { Club, Player, PlayerCareerProfile, Position, RngState } from "./types";
import { nextInt } from "./rng";
import { DAYS_PER_YEAR, DEVELOPMENT } from "./constants";
import { overallFromSkills, OVERALL_SCALE, OVERALL_WEIGHTS, SKILL_KEYS, trainingWeights, type SkillKey } from "./rating";
import { calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "./economy";
import { generateSeniorPlayer, generateYouthPlayer } from "./playerGeneration";
import {
  calculateDeclineActivityModifier,
  calculateGrowthActivityModifier,
  careerDeclineBudget,
  careerGrowthBudget,
  careerSeasonalRate,
  generateCareerProfile,
  retirementProbability,
  retirementRollThreshold,
} from "./careerCurves";
import { bumpSkillsVersion } from "./skillsVersion";

export { overallFromSkills } from "./rating";
export { generateCareerProfile, retirementProbability } from "./careerCurves";

/**
 * Compatibility wrapper for the canonical division-driven generator. New
 * players are always created through the canonical generator; this wrapper
 * adapts the old per-player call shape used by tests and legacy call sites.
 * When no division context is available it falls back to the weakest-division
 * expectation.
 */
export function generatePlayer(rng: RngState, club: Club, opts: { position?: Position; isYouth?: boolean; id: number; seed?: number }): Player {
  const division = club.highestDivision ?? 1;
  const base = {
    id: opts.id,
    clubId: club.id,
    country: club.country,
    position: opts.position ?? (nextInt(rng, 5) as Position),
    isYouth: opts.isYouth ?? false,
    currentDivision: division,
    highestDivisionReached: division,
    totalDivisions: Math.max(1, division),
    seasonId: null,
    generationType: (opts.isYouth ? "seasonal-academy" : "replacement") as "seasonal-academy" | "replacement",
    seed: opts.seed ?? club.id,
    slot: opts.id,
  };
  // NOTE: the passed `rng` stream is intentionally not consumed for quality
  // draws — the canonical generator derives its own server-private per-player
  // seed. The rng argument is retained for API compatibility.
  return opts.isYouth ? generateYouthPlayer(base) : generateSeniorPlayer(base);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function calculatePreciseAge(player: Player, dayIndex: number): number {
  return player.age + dayIndex / DAYS_PER_YEAR;
}

export function calculateRecentActivity(player: Player): number {
  const minutes = player.recentMinutes ?? [];
  if (minutes.length === 0) return DEVELOPMENT.activity.defaultActivity;
  const weights = DEVELOPMENT.activity.weights;
  let weighted = 0;
  let totalWeight = 0;
  const count = Math.min(minutes.length, weights.length);
  for (let i = 0; i < count; i++) {
    const ratio = clamp(minutes[i] / DEVELOPMENT.activity.regulationMinutes, 0, 1);
    weighted += ratio * weights[i];
    totalWeight += weights[i];
  }
  return totalWeight > 0 ? weighted / totalWeight : DEVELOPMENT.activity.defaultActivity;
}

export { calculateGrowthActivityModifier, calculateDeclineActivityModifier } from "./careerCurves";

export function calculateActivityModifier(careerRate: number, activity: number): number {
  if (Math.abs(careerRate) < DEVELOPMENT.developmentEpsilon) return 1;
  return careerRate > 0 ? calculateGrowthActivityModifier(activity) : calculateDeclineActivityModifier(activity);
}

/** OVR-equivalent budget still available inside the player's career budgets. */
export function remainingCareerBudget(player: Player, growing: boolean): number {
  const profile = player.careerProfile;
  return growing
    ? Math.max(0, careerGrowthBudget(profile) - player.careerGrowthConsumed)
    : Math.max(0, careerDeclineBudget(profile) - player.careerDeclineConsumed);
}

/**
 * Effective per-skill training weights after removing skills that are pinned at
 * a hard bound in the direction of travel.
 *
 * Redistribution matters: without it, a focus sending 70% of growth into a skill
 * already at 100 would realize only the remaining 30% of the budget, while a
 * different focus realized all of it. Hitting the player's total remaining
 * CAREER budget is a different thing entirely — that progress stops rather than
 * redistributing, because no capacity remains to spend anywhere.
 */
export function effectiveSkillWeights(player: Player, club: Club, growing: boolean): Record<SkillKey, number> {
  const weights = trainingWeights(player.position, club.trainingFocus ?? "assistant", player.skills);
  const eligible = SKILL_KEYS.filter((key) => (growing ? player.skills[key] < 100 : player.skills[key] > 1));
  const eligibleWeight = eligible.reduce((sum, key) => sum + weights[key], 0);
  const effective = Object.fromEntries(SKILL_KEYS.map((key) => [key, 0])) as Record<SkillKey, number>;
  if (eligibleWeight <= 0) return effective;
  for (const key of eligible) effective[key] = weights[key] / eligibleWeight;
  return effective;
}

/**
 * How much OVR one raw skill point of weighted progress is worth for this
 * position and training distribution. Dividing the OVR-equivalent budget by this
 * converts it into the raw skill progress needed for comparable expected OVR
 * movement across every position.
 *
 * This never sets OVR directly — OVR is always recomputed from the skills.
 */
export function overallSensitivity(position: Position, weights: Record<SkillKey, number>): number {
  const overallWeights = OVERALL_WEIGHTS[position];
  const weighted = SKILL_KEYS.reduce((sum, key) => sum + (overallWeights[key] ?? 0) * weights[key], 0);
  return OVERALL_SCALE[position] * weighted;
}

export function applyDevelopment(player: Player, club: Club, dayIndex: number): void {
  const age = calculatePreciseAge(player, dayIndex);
  const rate = careerSeasonalRate(player.careerProfile, age);
  if (Math.abs(rate) < DEVELOPMENT.developmentEpsilon) return;
  // A provisional/dormant club cannot participate in league fixtures. Treat
  // that unavoidable lack of appearances as neutral rather than applying the
  // inactive-player penalty.
  const activity = club.competitionState === "ACTIVE" || club.competitionState === undefined ? calculateRecentActivity(player) : 1;
  const growing = rate > 0;
  let budget = rate * calculateActivityModifier(rate, activity) * DEVELOPMENT.tickFraction;

  // Respect the player's remaining career budget. Progress stops here; it is
  // never redistributed, because no capacity remains.
  const remaining = remainingCareerBudget(player, growing);
  if (remaining <= 0) return;
  budget = growing ? Math.min(budget, remaining) : Math.max(budget, -remaining);
  if (Math.abs(budget) < DEVELOPMENT.developmentEpsilon) return;

  const weights = effectiveSkillWeights(player, club, growing);
  const sensitivity = overallSensitivity(player.position, weights);
  if (sensitivity <= DEVELOPMENT.developmentEpsilon) return;
  const rawSkillBudget = budget / sensitivity;

  ensureSkillAcc(player);
  for (const [i, key] of SKILL_KEYS.entries()) {
    const progress = rawSkillBudget * weights[key];
    if (progress === 0) continue;
    player.skillAcc[i] += progress;
    if (growing) {
      while (player.skillAcc[i] >= 1 && player.skills[key] < 100) {
        player.skills[key] += 1;
        player.skillAcc[i] -= 1;
      }
      if (player.skills[key] >= 100) player.skillAcc[i] = Math.min(player.skillAcc[i], 0.999999);
    } else {
      while (player.skillAcc[i] <= -1 && player.skills[key] > 1) {
        player.skills[key] -= 1;
        player.skillAcc[i] += 1;
      }
      if (player.skills[key] <= 1) player.skillAcc[i] = Math.max(player.skillAcc[i], -0.999999);
    }
  }

  if (growing) player.careerGrowthConsumed += budget;
  else player.careerDeclineConsumed += -budget;

  // Development changes tec/vel/des/arm/fin/gol, which computeAttributeCenters
  // draws on; invalidate any cached centers so the next tick recomputes them.
  bumpSkillsVersion();
  refreshPlayerDerived(club, player);
}

function ensureSkillAcc(player: Player): void {
  player.skillAcc = SKILL_KEYS.map((_, i) => {
    const value = Number(player.skillAcc?.[i] ?? 0);
    return Number.isFinite(value) ? Math.max(-0.999999, Math.min(0.999999, value)) : 0;
  });
}

/**
 * Refreshes derived values. Player market value follows overall/age/contract;
 * the contract salary is contractual and is NOT recalculated here. The release
 * clause is derived from salary and remaining contract length.
 */
export function refreshPlayerDerived(club: Club, player: Player): void {
  player.overall = overallFromSkills(player.position, player.skills);
  player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
}

export function shouldRetire(rng: RngState, player: Player): boolean {
  // Preserve the historical RNG stream: players aged 32 or younger never draw.
  if (player.age <= 32) return false;
  const roll = nextInt(rng, 100) + 1;
  return roll > retirementRollThreshold(player.age, player.position);
}

export function aging(player: Player) {
  player.age += 1;
  player.seasonGoals = 0;
  player.seasonAssists = 0;
  player.seasonAppearances = 0;
  player.yellows = 0;
  player.reds = 0;
}

export type { PlayerCareerProfile };
