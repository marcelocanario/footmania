import type { Player, Position, RngState, SkillSet } from "./types";
import { createRng, nextDouble, nextInt, truncatedNormal } from "./rng";
import { countriesWithNamePools, generateName } from "./names";
import { DAYS_PER_YEAR, DEVELOPMENT } from "./constants";
import { overallFromSkills, SKILL_KEYS, OVERALL_SCALE, type SkillKey } from "./rating";
import { calculateAcademySalary, calculateBaseSalary, calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "./economy";
import { generateDevelopmentProfile } from "./player";
import { gameConfig } from "../config";

/**
 * Division-driven player generation (plans/4. player-generation.md).
 *
 * This module replaces the club-level-driven generator. All quality is derived
 * from the club's current division (seniors) and current/historical division
 * (academy pedigree). Human and AI clubs use exactly the same formulas, and the
 * same canonical generator is reused by every creation path (new human club,
 * AI filler, replacement, league expansion).
 *
 * The tuning knobs live in gameConfig.playerGeneration; every other constant
 * below is a fixed statistical constant from the spec.
 */

// ---------------------------------------------------------------------------
// Fixed Version 1 statistical constants (spec §7) — not designer-facing knobs.
// ---------------------------------------------------------------------------

export const PLAYER_Z_MIN = -3.0;
export const PLAYER_Z_MAX = 3.0;
export const DIVISION_CURVE_K = 0.5;
export const ACADEMY_CURRENT_WEIGHT = 0.65;
export const ACADEMY_HISTORY_WEIGHT = 0.35;
export const TIER_Z_BOUNDS = [-1.2815515655, -0.5244005127, 0.5244005127, 1.2815515655];
export const SKILL_TARGET_TOLERANCE_OVR = 1.0;
export const SKILL_GENERATION_MAX_RETRIES = 8;

/** Authoritative engine OVR bounds (the engine's global 1..100 scale). */
export const OVR_MIN = 1;
export const OVR_MAX = 100;

/** Full OVR range. */
export function overallRange(): number {
  return OVR_MAX - OVR_MIN;
}

/** Individual quality standard deviation expressed directly in OVR points. */
export function qualitySigma(): number {
  return gameConfig.playerGeneration.playerQualitySpreadOverall;
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
 * Academy pedigree PA = 0.65·S(current) + 0.35·S(highestEver), clamped to [0,1].
 */
export function academyPedigree(currentDivision: number, highestDivisionReached: number, totalDivisions: number): number {
  const sCurrent = divisionStrength(currentDivision, totalDivisions);
  const sHistory = divisionStrength(highestDivisionReached, totalDivisions);
  return Math.max(0, Math.min(1, ACADEMY_CURRENT_WEIGHT * sCurrent + ACADEMY_HISTORY_WEIGHT * sHistory));
}

/** Direct OVR mean offset supplied by academy pedigree (spec §23). */
export function academyPedigreeOverallOffset(pedigree: number): number {
  return gameConfig.playerGeneration.academyPedigreeOverallBoost * pedigree;
}

// ---------------------------------------------------------------------------
// Youth age baselines (spec §26–§28)
// ---------------------------------------------------------------------------

/**
 * Closed-form expected natural growth from age `a` to age `b` under the
 * canonical development defaults (spec §27). Only the population-average
 * generation baselines use the default-activity multiplier; actual player
 * development is untouched.
 */
export function expectedGrowth(a: number, b: number): number {
  const { referenceAge, maxSeasonalGrowth, exponent } = DEVELOPMENT.growthCurve;
  const declineRef = DEVELOPMENT.declineAge.mean;
  const Aref = DEVELOPMENT.activity.inactiveGrowthMultiplier + (1 - DEVELOPMENT.activity.inactiveGrowthMultiplier) * DEVELOPMENT.activity.defaultActivity;
  const coeff = (maxSeasonalGrowth * (declineRef - referenceAge)) / (exponent + 1);
  if (a >= referenceAge) {
    const termA = Math.pow((declineRef - a) / (declineRef - referenceAge), exponent + 1);
    const termB = Math.pow((declineRef - b) / (declineRef - referenceAge), exponent + 1);
    return Aref * coeff * (termA - termB);
  }
  return Aref * (maxSeasonalGrowth * (referenceAge - a) + expectedGrowth(referenceAge, b) / Aref);
}

/** Youth mean offset: μ_youth(a) = μ21 − G(a, 21) (spec §28). */
export function youthAgeOffset(age: number): number {
  return expectedGrowth(age, gameConfig.playerGenerationRules.academyPromotionAge);
}

/** Youth mean for age `a`: μ_bottom − G(a, 21). */
export function youthDivisionMeanForAge(age: number): number {
  return bottomDivisionMean() - youthAgeOffset(age);
}

// ---------------------------------------------------------------------------
// Initial potential (spec §34–§36)
// ---------------------------------------------------------------------------

/**
 * Remaining natural growth integral (spec §34). D is declineStartAge; Gmax, e
 * and the growth reference age come from the existing development config.
 */
export function remainingNaturalGrowth(age: number, declineStartAge: number): number {
  const { referenceAge, maxSeasonalGrowth, exponent } = DEVELOPMENT.growthCurve;
  if (age >= declineStartAge) return 0;
  if (age >= referenceAge) {
    return (maxSeasonalGrowth * (declineStartAge - referenceAge)) / (exponent + 1) * Math.pow((declineStartAge - age) / (declineStartAge - referenceAge), exponent + 1);
  }
  return maxSeasonalGrowth * (referenceAge - age) + (maxSeasonalGrowth * (declineStartAge - referenceAge)) / (exponent + 1);
}

/**
 * Canonical initial potential (spec §35):
 *   ceil(OVR + RemainingGrowth(a, D) × developmentRate × Rmax), clamped to
 *   [OVR, OVR_MAX]. Rmax is the existing development random-factor maximum.
 */
export function initialPotential(overall: number, age: number, declineStartAge: number, developmentRate: number): number {
  const growth = remainingNaturalGrowth(age, declineStartAge);
  const raw = Math.ceil(overall + growth * developmentRate * DEVELOPMENT.randomFactor.max);
  return Math.max(overall, Math.min(OVR_MAX, raw));
}

// ---------------------------------------------------------------------------
// Tier classification from raw Z (spec §37)
// ---------------------------------------------------------------------------

/**
 * Map a raw (unshifted) birth-quality Z to a hidden growth tier 1..5 using
 * exact standard normal percentile thresholds. Raw Z — without the academy
 * pedigree OVR offset — keeps pedigree from indirectly modifying future
 * development. The tier is a server-
 * private development input only: it is never stored on the player and never
 * exposed through any API view.
 */
export function tierFromZ(z: number): number {
  if (z < TIER_Z_BOUNDS[0]) return 1;
  if (z < TIER_Z_BOUNDS[1]) return 2;
  if (z < TIER_Z_BOUNDS[2]) return 3;
  if (z < TIER_Z_BOUNDS[3]) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// Skills toward a target OVR (spec §39)
// ---------------------------------------------------------------------------

export interface SkillStep {
  key: SkillKey;
  fixed: number;
  randomExclusive?: number;
}

export interface SkillShapeRecipe {
  variant: 0 | 1 | 2;
  steps: readonly SkillStep[];
}

function step(key: SkillKey, fixed: number, randomExclusive?: number): SkillStep {
  const result: SkillStep = { key, fixed };
  if (randomExclusive !== undefined) result.randomExclusive = randomExclusive;
  return result;
}

function recipe(variant: SkillShapeRecipe["variant"], ...steps: SkillStep[]): SkillShapeRecipe {
  return { variant, steps };
}

/**
 * Generator-only skill shapes. The selected index and these steps are never
 * stored on a player or exposed through an API; only the resulting skills live
 * beyond generation.
 */
export const SKILL_SHAPE_RECIPES: Record<Position, readonly SkillShapeRecipe[]> = {
  0: [
    recipe(0, step("tec", 2, 5), step("tec", 0, 2)),
    recipe(0, step("tec", 2, 5), step("gol", 0, 2)),
    recipe(0, step("vel", 2, 5), step("tec", 0, 2)),
    recipe(0, step("gol", 1, 3), step("vel", 0, 2)),
    recipe(0, step("tec", 2, 5), step("gol", 0, 2)),
    recipe(0, step("tec", 2, 5), step("vel", 0, 2)),
  ],
  1: [
    recipe(1, step("pas", 2, 3), step("des", 3, 5)),
    recipe(1, step("pas", 2, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 5), step("pas", 3, 3)),
    recipe(0, step("des", 3, 5), step("vel", 16, 3)),
    recipe(0, step("des", 3, 5), step("pas", 2, 3)),
    recipe(0, step("des", 3, 5), step("fin", 3, 3), step("vel", 3, 3)),
    recipe(1, step("pas", 2, 3), step("pas", 3, 3)),
  ],
  2: [
    recipe(0, step("des", 3, 3), step("des", 3, 3), step("pas", 2, 3)),
    recipe(0, step("des", 3, 3), step("des", 3, 2)),
    recipe(0, step("des", 3, 3), step("arm", 3, 6)),
    recipe(0, step("des", 3, 3), step("pas", 2, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("des", 3, 3), step("pas", 2, 3)),
    recipe(0, step("des", 3, 3), step("arm", 3, 6)),
    recipe(0, step("des", 3, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("des", 3, 2)),
    recipe(0, step("des", 3, 3), step("arm", 3, 3), step("fin", 3, 3)),
    recipe(0, step("des", 3, 3), step("des", 3, 3), step("pas", 2, 3)),
    recipe(0, step("arm", 3, 6), step("des", 3, 2)),
  ],
  3: [
    recipe(1, step("arm", 3, 5), step("pas", 3, 5), step("pas", 3, 2)),
    recipe(1, step("arm", 3, 5), step("pas", 3, 5), step("fin", 3, 3)),
    recipe(1, step("fin", 3, 3), step("pas", 3, 2)),
    recipe(1, step("pas", 3, 2), step("fin", 3, 3)),
    recipe(1, step("arm", 3, 5), step("pas", 3, 5), step("tec", 3, 3)),
    recipe(1, step("arm", 3, 5), step("pas", 3, 5), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("des", 3, 3)),
    recipe(0, step("des", 3, 3), step("pas", 3, 2)),
    recipe(0, step("des", 3, 3), step("fin", 2, 3), step("des", 2, 3)),
    recipe(0, step("des", 3, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("pas", 3, 2)),
    recipe(1, step("fin", 3, 3), step("arm", 3, 5), step("pas", 3, 5)),
    recipe(0, step("des", 3, 3), step("des", 3, 3)),
    recipe(1, step("arm", 3, 5), step("pas", 3, 5), step("pas", 3, 2)),
    recipe(1, step("tec", 3, 3), step("pas", 3, 2)),
    recipe(0, step("des", 3, 3), step("fin", 3, 3)),
    recipe(1, step("pas", 3, 2), step("vel", 16, 3)),
    recipe(0, step("des", 3, 3), step("pas", 3, 2)),
  ],
  4: [
    recipe(1, step("fin", 3, 3), step("fin", 2, 3)),
    recipe(2, step("vel", 16, 3), step("fin", 3, 3)),
    recipe(1, step("fin", 3, 3), step("fin", 2, 3)),
    recipe(2, step("tec", 3, 3), step("fin", 3, 3)),
    recipe(1, step("fin", 3, 3), step("vel", 16, 3)),
    recipe(1, step("fin", 3, 3), step("fin", 2, 3)),
    recipe(1, step("fin", 3, 3), step("tec", 3, 3)),
    recipe(1, step("fin", 2, 3), step("vel", 16, 3)),
    recipe(2, step("tec", 3, 3), step("pas", 16, 2)),
    recipe(1, step("fin", 3, 3), step("pas", 16, 2)),
    recipe(1, step("fin", 3, 3), step("des", 3, 3), step("fin", 2)),
    recipe(2, step("vel", 16, 3), step("tec", 3, 3)),
  ],
};

/** Fixed supporting-skill baseline retained from the existing skill model. */
const SUPPORTING_SKILL_BASE = 16;

/** The base Brasfoot-style skill generator, independent of club ownership or division. */
function generateRawSkills(rng: RngState, position: Position, variant: 0 | 1 | 2, target: number, recipe: SkillShapeRecipe): SkillSet {
  const n2 = SUPPORTING_SKILL_BASE;
  const n4 = Math.round(n2 / 3);
  const n3 = 3;
  let s: SkillSet = { gol: 1, vel: 1, tec: 1, pas: 1, des: 1, arm: 1, fin: 1 };
  if (position === 0) {
    s.gol = target + nextInt(rng, 2);
    s.vel = n2 + nextInt(rng, 7);
    s.tec = n2 + nextInt(rng, 4);
    s.pas = n2 + nextInt(rng, 4);
    s.des = n3 + nextInt(rng, 3);
    s.arm = n3 + nextInt(rng, 3);
    s.fin = n3 + nextInt(rng, 3);
  } else if (position === 1) {
    s.gol = 1 + nextInt(rng, 4);
    if (variant === 0) {
      s.des = Math.round(target * 0.8) + nextInt(rng, 6);
      s.fin = n3 + nextInt(rng, 4);
      s.pas = n2 + nextInt(rng, 3);
      s.tec = n2 + nextInt(rng, 7);
      s.arm = n3 + nextInt(rng, 5);
      s.vel = n2 + n3 + nextInt(rng, 6);
    } else {
      s.arm = Math.round(target * 0.5) + nextInt(rng, 5);
      s.fin = n2 + n3 + nextInt(rng, 4);
      s.pas = n2 + n4 + nextInt(rng, 3);
      s.tec = n2 + n4 + nextInt(rng, 7);
      s.des = n2 + nextInt(rng, 4);
      s.vel = n2 + n3 + nextInt(rng, 4);
    }
  } else if (position === 2) {
    s.gol = 1 + nextInt(rng, 7);
    s.des = Math.round(target * 0.9) + nextInt(rng, 2);
    s.vel = n2 + n3 + nextInt(rng, 4);
    s.tec = n2 + n3 + nextInt(rng, 7);
    s.pas = n2 + n3 + nextInt(rng, 3);
    s.arm = n3 + nextInt(rng, 6);
    s.fin = n2 + nextInt(rng, 5);
  } else if (position === 3) {
    s.gol = 1 + nextInt(rng, 4);
    if (variant === 0) {
      s.des = Math.round(target * 0.7) + nextInt(rng, 6);
      s.fin = n2 + nextInt(rng, 4);
      s.pas = n2 + nextInt(rng, 3);
      s.tec = n2 + nextInt(rng, 7);
      s.arm = n2 + nextInt(rng, 5);
      s.vel = n2 + n3 + nextInt(rng, 6);
    } else {
      s.arm = target + nextInt(rng, 2);
      s.fin = n2 + n4 + nextInt(rng, 4);
      s.pas = n2 + n3 + nextInt(rng, 3);
      s.tec = n2 + n4 + nextInt(rng, 7);
      s.des = n2 + nextInt(rng, 4);
      s.vel = n2 + n4 + nextInt(rng, 4);
    }
  } else {
    s.gol = 1 + nextInt(rng, 6);
    s.fin = Math.round(target * 0.8) + nextInt(rng, 2);
    s.vel = n2 + n4 + nextInt(rng, 4);
    s.tec = n2 + n4 + nextInt(rng, 7);
    s.pas = n2 + n3 + nextInt(rng, 3);
    s.des = n3 + nextInt(rng, 6);
    s.arm = n2 + n3 + nextInt(rng, 5);
  }
  for (const operation of recipe.steps) {
    s[operation.key] += operation.fixed + (operation.randomExclusive === undefined ? 0 : nextInt(rng, operation.randomExclusive));
  }
  for (const key of Object.keys(s) as (keyof SkillSet)[]) {
    if (s[key] > 100) s[key] = 100;
  }
  return s;
}

/**
 * Generate skills that produce an OVR within tolerance of `target`, preserving
 * the positional/tactical skill shape. Bounded retries (spec §39).
 */
export function generateSkillsForTarget(rng: RngState, position: Position, target: number): { skills: SkillSet } {
  const recipes = SKILL_SHAPE_RECIPES[position];
  let best: SkillSet | null = null;
  let bestError = Infinity;
  for (let attempt = 0; attempt < SKILL_GENERATION_MAX_RETRIES; attempt++) {
    const selected = recipes[nextInt(rng, recipes.length)];
    let skills = generateRawSkills(rng, position, selected.variant, target, selected);
    let actual = overallFromSkills(position, skills);
    // Scale every skill toward the target using the per-position scale factor
    // (the OVR is a weighted mean scaled by OVERALL_SCALE).
    for (let i = 0; i < 4; i++) {
      const error = actual - target;
      if (Math.abs(error) <= SKILL_TARGET_TOLERANCE_OVR) break;
      const delta = Math.round(error / OVERALL_SCALE[position]);
      if (delta === 0) break;
      for (const key of SKILL_KEYS) {
        skills[key] = Math.max(1, Math.min(100, skills[key] - delta));
      }
      actual = overallFromSkills(position, skills);
    }
    // Final unbiased correction: nudge a single OVR step in the correct
    // direction when the scaled skills landed just off target. This cancels
    // the systematic rounding bias at the extremes of the range.
    if (actual - target < -SKILL_TARGET_TOLERANCE_OVR) {
      const before = actual;
      const boosted = { ...skills };
      for (const key of SKILL_KEYS) {
        boosted[key] = Math.max(1, Math.min(100, boosted[key] + 1));
      }
      const boostedOvr = overallFromSkills(position, boosted);
      if (Math.abs(boostedOvr - target) < Math.abs(before - target)) {
        skills = boosted;
        actual = boostedOvr;
      }
    } else if (actual - target > SKILL_TARGET_TOLERANCE_OVR) {
      const before = actual;
      const reduced = { ...skills };
      for (const key of SKILL_KEYS) {
        reduced[key] = Math.max(1, Math.min(100, reduced[key] - 1));
      }
      const reducedOvr = overallFromSkills(position, reduced);
      if (Math.abs(reducedOvr - target) < Math.abs(before - target)) {
        skills = reduced;
        actual = reducedOvr;
      }
    }
    const error = Math.abs(actual - target);
    if (error <= SKILL_TARGET_TOLERANCE_OVR) {
      return { skills };
    }
    if (error < bestError) {
      bestError = error;
      best = skills;
    }
  }
  const fallback = recipes[0];
  return { skills: best ?? generateRawSkills(rng, position, fallback.variant, target, fallback) };
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

/** Canonical senior weights: GK 10% / FB 14% / CB 18% / MF 32% / FW 26%. */
export const SENIOR_POSITION_WEIGHTS = [0.1, 0.14, 0.18, 0.32, 0.26] as const;
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
// Deterministic per-player RNG (spec §47)
// ---------------------------------------------------------------------------

/**
 * Server-private per-player RNG seed. The slot index is folded into the world
 * seed so a restart/retry reproduces the identical player while separate slots
 * and seasons get separate draws, and the seed is stable across retries
 * (idempotent generation). The world seed already originates from server entropy.
 */
export function playerRng(worldSeed: number, clubId: number, generationType: string, slot: number, seasonId: number | null = null): RngState {
  let h = 0x811c9dc5;
  const key = `${worldSeed}|${clubId}|${generationType}|${seasonId ?? "none"}|${slot}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return createRng(h >>> 0);
}

// ---------------------------------------------------------------------------
// Generated player construction (spec §70/§71)
// ---------------------------------------------------------------------------

export type GenerationType = "initial-senior" | "initial-academy" | "seasonal-academy" | "replacement";

export interface GeneratedPlayerInput {
  id: number;
  clubId: number;
  country: string;
  position: Position;
  /** Age for youth (required). Seniors draw their own age distribution. */
  age?: number;
  isYouth: boolean;
  currentDivision: number;
  highestDivisionReached: number;
  totalDivisions: number;
  seasonId: number | null;
  generationType: GenerationType;
}

export interface GeneratePlayerContext extends GeneratedPlayerInput {
  /** Server world seed (idempotent generation identity). */
  seed: number;
  /** Stable slot index within this generation batch. */
  slot: number;
}

/** Draw a raw birth-quality Z (spec §13). */
export function drawRawZ(rng: RngState): number {
  return truncatedNormal(rng, 0, 1, PLAYER_Z_MIN, PLAYER_Z_MAX);
}

/** Senior age distribution: TN(24, 4, 18, 38), rounded and clamped (spec §18). */
export function drawSeniorAge(rng: RngState): number {
  const age = Math.round(truncatedNormal(rng, 24, 4, 18, 38));
  return Math.max(18, Math.min(38, age));
}

function buildGeneratedPlayer(
  ctx: GeneratePlayerContext,
  age: number,
  profile: { declineStartAge: number; developmentRate: number; developmentVolatility: number },
  rawZ: number,
  actualOverall: number,
  potential: number,
  skills: SkillSet,
): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const availableForeignCountries = countriesWithNamePools().filter((country) => country !== ctx.country);
  const country = availableForeignCountries.length > 0 && nextDouble(rng) < gameConfig.playerGenerationRules.foreignPlayerChance
    ? availableForeignCountries[nextInt(rng, availableForeignCountries.length)]
    : ctx.country;
  const contractDays = ctx.isYouth ? DAYS_PER_YEAR * gameConfig.playerGenerationRules.academyContractSeasons : DAYS_PER_YEAR * (1 + nextInt(rng, 3));
  const salary = ctx.isYouth ? calculateAcademySalary(actualOverall, age) : calculateBaseSalary(actualOverall, age);
  const value = calculatePlayerValue(actualOverall, age, remainingSeasons(contractDays));
  const player: Player = {
    id: ctx.id,
    name: generateName(rng, country),
    country,
    age,
    position: ctx.position,
    side: nextInt(rng, 2),
    skills,
    overall: actualOverall,
    potential,
    energy: 100,
    recentLoad: 0,
    salary,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value,
    releaseClause: 0,
    injuryDays: 0,
    injuryUntilAbsoluteGameDay: null,
    injuryInitialGameDays: null,
    injuryEquivalentRealDays: null,
    injuryCause: null,
    contractDays,
    isYouth: ctx.isYouth,
    starter: false,
    growthAcc: 0,
    potentialAcc: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    yellows: 0,
    reds: 0,
    clubId: ctx.clubId,
    tacPos: -1,
    onSale: false,
    suspendedGames: 0,
    loanId: null,
    developmentProfile: profile,
    recentMinutes: [],
    generatedClubId: ctx.clubId,
    generatedDivision: ctx.currentDivision,
    generatedSeasonId: ctx.seasonId,
    generationType: ctx.generationType,
    generatedClubHighestDivision: ctx.isYouth ? ctx.highestDivisionReached : null,
    rawZ,
  };
  player.releaseClause = calculateReleaseClause(salary, remainingSeasons(contractDays));
  return player;
}

/**
 * Generate one senior player (spec §70). Uses the club's current division only;
 * development traits are drawn independently from the starting-quality Z.
 */
export function generateSeniorPlayer(ctx: GeneratePlayerContext): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const mu = divisionMean(ctx.currentDivision, ctx.totalDivisions);
  const target = mu + qualitySigma() * rawZ;
  const age = ctx.age ?? drawSeniorAge(rng);
  const { skills } = generateSkillsForTarget(rng, ctx.position, Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(target))));
  const actualOverall = overallFromSkills(ctx.position, skills);
  const profile = generateDevelopmentProfile(rng);
  const potential = initialPotential(actualOverall, age, profile.declineStartAge, profile.developmentRate);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, rawZ, actualOverall, potential, skills);
}

/** Youth age generation (spec §31): UniformInteger(academyMinAge, academyMaxAge). */
export function drawYouthAge(rng: RngState): number {
  const { academyMinAge, academyMaxAge } = gameConfig.playerGenerationRules;
  return academyMinAge + nextInt(rng, academyMaxAge - academyMinAge + 1);
}

/**
 * Generate one youth player (spec §71). Youth quality depends on the current
 * division and the highest-ever division reached via the academy pedigree.
 */
export function generateYouthPlayer(ctx: GeneratePlayerContext): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const age = ctx.age ?? drawYouthAge(rng);
  const pedigree = academyPedigree(ctx.currentDivision, ctx.highestDivisionReached, ctx.totalDivisions);
  const muAge = youthDivisionMeanForAge(age);
  const target = muAge + qualitySigma() * rawZ + academyPedigreeOverallOffset(pedigree);
  const { skills } = generateSkillsForTarget(rng, ctx.position, Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(target))));
  const actualOverall = overallFromSkills(ctx.position, skills);
  const profile = generateDevelopmentProfile(rng);
  const potential = initialPotential(actualOverall, age, profile.declineStartAge, profile.developmentRate);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, rawZ, actualOverall, potential, skills);
}

export { gameConfig };
