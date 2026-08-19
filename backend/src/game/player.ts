import type { Club, Player, PlayerDevelopmentProfile, Position, RngState } from "./types";
import { beta, createRng, nextInt, truncatedNormal } from "./rng";
import { DAYS_PER_YEAR, DEVELOPMENT } from "./constants";
import { overallFromSkills, SKILL_KEYS, trainingWeights } from "./rating";
import { calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "./economy";
import { generateSeniorPlayer, generateYouthPlayer } from "./playerGeneration";

export { overallFromSkills } from "./rating";

export const CHARACTERISTIC_NAMES = [
  "Positioning", "Penalty Save", "Reflexes", "Off the Line", "Playmaking",
  "Heading", "Crossing", "Tackling", "Dribbling", "Finishing",
  "Marking", "Passing", "Stamina", "Speed",
];

/**
 * Compatibility wrapper for the canonical division-driven generator
 * (player-generation spec §70/§71). New players are always created through the
 * canonical generator; this wrapper adapts the old per-player call shape used
 * by tests and legacy call sites. When no division context is available it
 * falls back to the weakest-division expectation.
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
  // seed (spec §47). The rng argument is retained for API compatibility.
  return opts.isYouth ? generateYouthPlayer(base) : generateSeniorPlayer(base);
}

export function generateDevelopmentProfile(rng: RngState): PlayerDevelopmentProfile {
  const declineStartAge = truncatedNormal(rng, DEVELOPMENT.declineAge.mean, DEVELOPMENT.declineAge.stdDev, DEVELOPMENT.declineAge.min, DEVELOPMENT.declineAge.max);
  const developmentRate = DEVELOPMENT.developmentRate.min + (DEVELOPMENT.developmentRate.max - DEVELOPMENT.developmentRate.min) * beta(rng, DEVELOPMENT.developmentRate.alpha, DEVELOPMENT.developmentRate.beta);
  const developmentVolatility = DEVELOPMENT.volatility.min + (DEVELOPMENT.volatility.max - DEVELOPMENT.volatility.min) * beta(rng, DEVELOPMENT.volatility.alpha, DEVELOPMENT.volatility.beta);
  return { declineStartAge, developmentRate, developmentVolatility };
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function backfillDevelopmentProfile(worldSeed: number, playerId: number): PlayerDevelopmentProfile {
  const hash = fnv1a(`${worldSeed}|${playerId}|${DEVELOPMENT.backfillVersion}`);
  return generateDevelopmentProfile(createRng(hash));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function calculatePreciseAge(player: Player, dayIndex: number): number {
  return player.age + dayIndex / DAYS_PER_YEAR;
}

export function calculateAgeDevelopment(age: number, declineStartAge: number): number {
  if (age < declineStartAge) {
    const span = declineStartAge - DEVELOPMENT.growthCurve.referenceAge;
    const p = span > 0 ? clamp((age - DEVELOPMENT.growthCurve.referenceAge) / span, 0, 1) : 0;
    return DEVELOPMENT.growthCurve.maxSeasonalGrowth * Math.pow(1 - p, DEVELOPMENT.growthCurve.exponent);
  }
  const t = age - declineStartAge;
  return -(DEVELOPMENT.declineCurve.initialDecline + DEVELOPMENT.declineCurve.coefficient * Math.pow(t, DEVELOPMENT.declineCurve.exponent));
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

export function calculateGrowthActivityModifier(activity: number): number {
  return DEVELOPMENT.activity.inactiveGrowthMultiplier + (1 - DEVELOPMENT.activity.inactiveGrowthMultiplier) * clamp(activity, 0, 1);
}

export function calculateDeclineActivityModifier(activity: number): number {
  return 1 + (DEVELOPMENT.activity.inactiveDeclineMultiplier - 1) * (1 - clamp(activity, 0, 1));
}

export function calculateActivityModifier(careerAdjusted: number, activity: number): number {
  if (Math.abs(careerAdjusted) < DEVELOPMENT.developmentEpsilon) return 1;
  return careerAdjusted > 0 ? calculateGrowthActivityModifier(activity) : calculateDeclineActivityModifier(activity);
}

export function generateDevelopmentRandomFactor(rng: RngState, player: Player): number {
  return truncatedNormal(
    rng,
    DEVELOPMENT.randomFactor.mean,
    player.developmentProfile.developmentVolatility,
    DEVELOPMENT.randomFactor.min,
    DEVELOPMENT.randomFactor.max
  );
}

export function applyDevelopment(rng: RngState, player: Player, club: Club, dayIndex: number): void {
  const age = calculatePreciseAge(player, dayIndex);
  const base = calculateAgeDevelopment(age, player.developmentProfile.declineStartAge);
  if (Math.abs(base) < DEVELOPMENT.developmentEpsilon) return;
  const career = base * player.developmentProfile.developmentRate;
  // A provisional/dormant club cannot participate in league fixtures.  Treat
  // that unavoidable lack of appearances as neutral rather than applying the
  // inactive-player penalty; natural biological development still runs.
  const activity = club.competitionState === "ACTIVE" || club.competitionState === undefined ? calculateRecentActivity(player) : 1;
  const modifier = calculateActivityModifier(career, activity);
  let budget = career * modifier * DEVELOPMENT.tickFraction;
  budget *= generateDevelopmentRandomFactor(rng, player);
  const weights = trainingWeights(player.position, club.trainingFocus ?? "assistant", player.skills);
  const ceiling = developmentCeiling(player, club);
  ensureSkillAcc(player);
  for (const [i, key] of SKILL_KEYS.entries()) {
    player.skillAcc[i] += budget * weights[key];
    if (budget >= 0) {
      while (player.skillAcc[i] >= 1) {
        if (player.skills[key] >= 100 || overallFromSkills(player.position, { ...player.skills, [key]: player.skills[key] + 1 }) > ceiling) {
          player.skillAcc[i] = Math.min(player.skillAcc[i], 0.999999);
          break;
        }
        player.skills[key] += 1;
        player.skillAcc[i] -= 1;
      }
    } else {
      while (player.skillAcc[i] <= -1) {
        if (player.skills[key] <= 1) {
          player.skillAcc[i] = -0.999999;
          break;
        }
        player.skills[key] -= 1;
        player.skillAcc[i] += 1;
      }
    }
  }
  refreshPlayerDerived(club, player);
}

export function potentialGrowth(rng: RngState, player: Player) {
  if (player.potential < player.overall) player.potential = player.overall;
  if (player.age > 20) return;
  let rate = 0.01;
  if (player.age <= 17) rate = 20 / 40;
  else if (player.age === 18) rate = 15 / 40;
  else if (player.age === 19) rate = 14 / 40;
  else if (player.age === 20) rate = 5 / 40;
  // Tier ordering (player-generation §37): 1 = lowest, 5 = highest. Better
  // birth quality raises the potential-growth rate for under-21 players.
  if (player.tier <= 2) rate += 0.03;
  else if (player.tier === 3) rate += 0.04;
  else if (player.tier === 4) rate += 0.07;
  else rate += 0.11;
  player.potentialAcc += rate;
  if (player.potentialAcc > 1 && player.potential < 100) {
    player.potential += 1;
    player.potentialAcc -= 1;
  }
  if (player.potential > 100) player.potential = 100;
}

function ensureSkillAcc(player: Player): void {
  player.skillAcc = SKILL_KEYS.map((_, i) => {
    const value = Number(player.skillAcc?.[i] ?? 0);
    return Number.isFinite(value) ? Math.max(-0.999999, Math.min(0.999999, value)) : 0;
  });
}

// Development ceiling (player-generation §41): the player's own potential plus
// the global OVR maximum. The obsolete club-level cap was removed; no
// division-based cap replaces it.
function developmentCeiling(player: Player, club: Club): number {
  return Math.max(player.overall, Math.min(100, player.potential));
}

/**
 * Refreshes derived values. Player market value follows overall/age/contract;
 * the contract salary is contractual and is NOT recalculated here. The release
 * clause is derived from salary and remaining contract length.
 */
export function refreshPlayerDerived(club: Club, player: Player): void {
  player.overall = overallFromSkills(player.position, player.skills);
  player.potential = Math.max(player.overall, Math.min(100, player.potential));
  player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
}

export function shouldRetire(rng: RngState, player: Player): boolean {
  if (player.age <= 32) return false;
  let age = player.age;
  if (player.position === 0) age -= 3;
  const roll = nextInt(rng, 100) + 1;
  if (age < 32) return false;
  if (age === 32) return roll > 99;
  if (age <= 34) return roll > 90;
  if (age <= 35) return roll > 55;
  if (age <= 36) return roll > 30;
  if (age <= 38) return roll > 15;
  if (age <= 39) return roll > 5;
  if (age <= 40) return roll > 3;
  if (age <= 42) return roll > 2;
  if (age <= 48) return roll > 1;
  return true;
}

export function injuryDays(rng: RngState, player: Player): number {
  let days = nextInt(rng, 14);
  const base = 5 + nextInt(rng, 20);
  let n = days;
  if (player.energy < 10) n += 5;
  else if (player.energy < 50) n += 1;
  if (player.age <= 20) n = n;
  else if (player.age <= 25) n = n + 1;
  else if (player.age <= 30) n = n + 2;
  else if (player.age <= 35) n = n + 3;
  else if (player.age <= 40) n = n + base;
  else n = n + base + 10;
  const bonus = nextInt(rng, 100);
  if (bonus === 1) n += 70;
  else if (bonus < 4) n += 40;
  else if (bonus < 10) n += 20;
  return n;
}

export function aging(rng: RngState, player: Player, club: Club) {
  player.age += 1;
  player.seasonGoals = 0;
  player.seasonAssists = 0;
  player.yellows = 0;
  player.reds = 0;
}
