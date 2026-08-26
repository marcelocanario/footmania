import type { Player, PlayerCareerProfile, Position, RngState, SkillSet } from "./types";
import { createRng, nextDouble, nextInt, truncatedNormal } from "./rng";
import { countriesWithNamePools, generateName } from "./names";
import { DAYS_PER_YEAR } from "./constants";
import { overallFromSkills, SKILL_KEYS, OVERALL_SCALE, type SkillKey } from "./rating";
import {
  academyContractDaysForAge,
  academyContractSeasonsForAge,
  calculateAcademySalary,
  calculatePlayerValue,
  calculateProfessionalContractSalary,
  calculateReleaseClause,
  remainingSeasons,
} from "./economy";
import {
  drawStandingSeniorAge,
  generateCareerProfile,
  activityModifiersFor,
  generationActivityModifiers,
  reconstructCurrentTarget,
} from "./careerCurves";
import {
  OVR_MAX,
  OVR_MIN,
  PLAYER_Z_MAX,
  PLAYER_Z_MIN,
  academyPeakMean,
  academyPedigree,
  academyQualitySigma,
  initialClubQualityTargets,
  qualitySigma,
  seniorPeakMean,
  seniorRosterTemplate,
} from "./generationModel";
import { gameConfig } from "../config";

/**
 * Career-shaped, division-driven player generation.
 *
 * Generation draws the hidden career profile FIRST, anchors the player's
 * personal career PEAK on his division, then reconstructs the OVR he should
 * already have at his generated age. An 18-year-old and a 28-year-old with the
 * same career quality therefore look nothing alike: the teenager is early on
 * his curve, the 28-year-old is at or past his peak.
 *
 * Academy pedigree shifts the career peak anchor, never current OVR directly,
 * so a strong academy produces better PROSPECTS rather than ready-made stars.
 *
 * Human and AI clubs share these formulas exactly, and every creation path
 * (new human club, AI filler, replacement, league expansion) reuses them.
 */

// ---------------------------------------------------------------------------
// Generation model re-exports
// ---------------------------------------------------------------------------

/**
 * The division-quality anchors, roster weights and OVR bounds live in
 * `generationModel.ts` so the player-value economy can share the same
 * authorities without a circular import. They are re-exported here because this
 * module is the generation entry point every existing caller already imports.
 */
export {
  PLAYER_Z_MIN,
  PLAYER_Z_MAX,
  DIVISION_CURVE_K,
  OVR_MIN,
  OVR_MAX,
  overallRange,
  qualitySigma,
  academyQualitySigma,
  topDivisionMean,
  bottomDivisionMean,
  divisionStrength,
  divisionMean,
  academyPedigree,
  seniorPeakMean,
  academyPeakMean,
  allocateSlots,
  initialClubQualityTargets,
  SENIOR_POSITION_WEIGHTS,
  ACADEMY_POSITION_WEIGHTS,
  seniorRosterTemplate,
} from "./generationModel";

// ---------------------------------------------------------------------------
// Fixed statistical constants — not designer-facing knobs.
// ---------------------------------------------------------------------------

export const SKILL_TARGET_TOLERANCE_OVR = 1.0;
export const SKILL_GENERATION_MAX_RETRIES = 8;

function clampNumber(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
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

/** Draw a raw birth-quality Z. Independent of the hidden career profile. */
export function drawRawZ(rng: RngState): number {
  return truncatedNormal(rng, 0, 1, PLAYER_Z_MIN, PLAYER_Z_MAX);
}

/**
 * Initial senior age from the standing active-career survivorship distribution:
 * the probability a player who entered the senior population at the automatic
 * promotion age is still inside the active boundary at each later age.
 */
export function drawSeniorAge(rng: RngState, position: Position): number {
  return drawStandingSeniorAge(rng, position);
}

/** Academy age generation: UniformInteger(academyMinAge, academyMaxAge). */
export function drawYouthAge(rng: RngState): number {
  const { academyMinAge, academyMaxAge } = gameConfig.playerGenerationRules;
  return academyMinAge + nextInt(rng, academyMaxAge - academyMinAge + 1);
}

function buildGeneratedPlayer(
  ctx: GeneratePlayerContext,
  age: number,
  profile: PlayerCareerProfile,
  rawZ: number,
  actualOverall: number,
  consumed: { growthConsumed: number; declineConsumed: number },
  skills: SkillSet,
): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const availableForeignCountries = countriesWithNamePools().filter((country) => country !== ctx.country);
  const country = availableForeignCountries.length > 0 && nextDouble(rng) < gameConfig.playerGenerationRules.foreignPlayerChance
    ? availableForeignCountries[nextInt(rng, availableForeignCountries.length)]
    : ctx.country;
  let contractDays: number;
  let salary: number;
  if (ctx.isYouth) {
    // Academy terms are derived, never configured: the contract always ends at
    // the age-21 rollover boundary and can never be renewed or extended.
    contractDays = academyContractDaysForAge(age);
    salary = calculateAcademySalary(actualOverall, age);
  } else {
    const futureCompleteSeasons = nextInt(rng, 3);
    contractDays = DAYS_PER_YEAR * (futureCompleteSeasons + 1);
    salary = calculateProfessionalContractSalary({
      currentOverall: actualOverall,
      currentAge: age,
      futureCompleteSeasons,
      currentSeasonFraction: 1,
    });
  }
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
    careerGrowthConsumed: consumed.growthConsumed,
    careerDeclineConsumed: consumed.declineConsumed,
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
    turnYellows: 0,
    yellowsTurnKey: null,
    loanId: null,
    careerProfile: profile,
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

/** All hidden draws needed to build a youth player without advancing RNG later. */
export interface YouthGenerationBlueprint {
  ctx: GeneratePlayerContext;
  rawZ: number;
  age: number;
  profile: PlayerCareerProfile;
  rngAfterCareerDraws: RngState;
}

/** Draw raw quality, age and career profile in the legacy youth draw order. */
export function drawYouthGenerationBlueprint(ctx: GeneratePlayerContext): YouthGenerationBlueprint {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const age = ctx.age ?? drawYouthAge(rng);
  const profile = generateCareerProfile(rng);
  return { ctx, rawZ, age, profile, rngAfterCareerDraws: { ...rng } };
}

/** Build a youth player from one coherent career blueprint and peak target. */
export function buildYouthPlayerFromBlueprint(
  blueprint: YouthGenerationBlueprint,
  assignedRawZ: number,
  assignedPeakTarget?: number,
): Player {
  const { ctx, age, profile } = blueprint;
  const rng = { ...blueprint.rngAfterCareerDraws };
  const pedigree = academyPedigree(ctx.currentDivision, ctx.highestDivisionReached, ctx.totalDivisions);
  const peakMean = academyPeakMean(pedigree);
  const personalPeakTarget = assignedPeakTarget ?? peakMean + academyQualitySigma() * assignedRawZ;
  const activity = generationActivityModifiers();
  const reconstructed = reconstructCurrentTarget(profile, personalPeakTarget, age, activity.growth, activity.decline);
  const target = clampNumber(Math.round(reconstructed.current), OVR_MIN, OVR_MAX);
  const { skills } = generateSkillsForTarget(rng, ctx.position, target);
  const actualOverall = overallFromSkills(ctx.position, skills);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, assignedRawZ, actualOverall, reconstructed, skills);
}

// ---------------------------------------------------------------------------
// Senior blueprint: draws first, pairing later (initial rosters only)
// ---------------------------------------------------------------------------

/**
 * All of a senior player's hidden career draws, resolved before any skills or
 * identity are generated, so an initial squad can pair peak-quality tickets
 * with career-stage bundles at the squad level without re-rolling anything.
 */
export interface SeniorGenerationBlueprint {
  ctx: GeneratePlayerContext;
  rawZ: number;
  age: number;
  profile: PlayerCareerProfile;
  rngAfterCareerDraws: RngState;
}

/**
 * Draw one senior-generation blueprint. The draw order is fixed and never
 * changes: raw quality Z, then age, then the five hidden career attributes.
 * The RNG snapshot taken after the career draws is a CLONED `{ seed, state }`
 * value, so building the player later can never advance another blueprint's
 * stream.
 */
export function drawSeniorGenerationBlueprint(ctx: GeneratePlayerContext): SeniorGenerationBlueprint {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const age = ctx.age ?? drawSeniorAge(rng, ctx.position);
  const profile = generateCareerProfile(rng);
  const rngAfterCareerDraws = { ...rng };
  return { ctx, rawZ, age, profile, rngAfterCareerDraws };
}

/**
 * Build the player a blueprint describes, anchoring his personal peak on the
 * division and using the supplied (possibly re-paired) raw quality Z.
 *
 * `historicalActivity` is the activity assumption used to reconstruct how much
 * of the curve this age has already lived. It never changes the personal peak
 * formula, the growth/decline budgets, or any marginal draw; skills are
 * generated from a clone of the blueprint's post-career RNG snapshot so the
 * original blueprint stays reusable.
 */
export function buildSeniorPlayerFromBlueprint(
  blueprint: SeniorGenerationBlueprint,
  assignedRawZ: number,
  historicalActivity: number,
  overallBand?: { lower: number; upper: number },
): Player {
  const { ctx, age, profile } = blueprint;
  const rng = { ...blueprint.rngAfterCareerDraws };
  const personalPeakTarget =
    seniorPeakMean(ctx.currentDivision, ctx.totalDivisions) +
    qualitySigma() * assignedRawZ;
  const activity = activityModifiersFor(historicalActivity);
  const reconstructed = reconstructCurrentTarget(profile, personalPeakTarget, age, activity.growth, activity.decline);
  const target = overallBand
    ? clampNumber(Math.round(reconstructed.current), Math.ceil(overallBand.lower), Math.floor(overallBand.upper))
    : clampNumber(Math.round(reconstructed.current), OVR_MIN, OVR_MAX);
  const generated = generateSkillsForTarget(rng, ctx.position, target);
  const skills = overallBand
    ? fitSkillsToOverallBand(ctx.position, generated.skills, overallBand.lower, overallBand.upper)
    : generated.skills;
  const actualOverall = overallFromSkills(ctx.position, skills);
  return buildGeneratedPlayer(ctx, age, profile, assignedRawZ, actualOverall, reconstructed, skills);
}

/**
 * Generate one senior player. His personal peak is anchored on the club's
 * current division; his current OVR is where that peak, his own career curve,
 * and his age put him today. Direct calls keep raw-Z/profile independence.
 */
export function generateSeniorPlayer(ctx: GeneratePlayerContext): Player {
  const blueprint = drawSeniorGenerationBlueprint(ctx);
  return buildSeniorPlayerFromBlueprint(blueprint, blueprint.rawZ, gameConfig.playerCareer.generationHistoricalActivity);
}

// ---------------------------------------------------------------------------
// Initial-senior squad pairing (plans/initial-senior-roster-generation.md)
// ---------------------------------------------------------------------------

/**
 * Pair peak-quality tickets with career-stage bundles for one initial senior
 * squad, countermonotonically inside division-configured age bands.
 *
 * Career-profile bundles are sorted strongest-first within their age bands (by
 * their OVR-equivalent stage adjustment with a zero peak); quality tickets are
 * sorted weakest-first. Pairing by index then gives
 * the weakest remaining quality to the strongest same-age-band stage,
 * narrowing the squad's current-OVR spread while preserving the exact
 * marginal multisets and every career's coherence.
 *
 * The pairing RNG is derived from the first blueprint's generation identity, so
 * the outcome is deterministic and retry-safe; `world.rng` is never touched.
 * Results are returned in original slot order so caller-visible player order,
 * ID allocation, and persistence order stay stable.
 */
export function pairInitialSeniorBlueprints(
  blueprints: readonly SeniorGenerationBlueprint[],
): Array<{ blueprint: SeniorGenerationBlueprint; assignedRawZ: number }> {
  if (blueprints.length === 0) return [];

  const first = blueprints[0];
  const seenSlots = new Set<number>();
  for (const blueprint of blueprints) {
    const { ctx } = blueprint;
    if (ctx.generationType !== "initial-senior" || ctx.isYouth) {
      throw new Error(
        `pairInitialSeniorBlueprints requires initial-senior senior blueprints (got generationType=${ctx.generationType}, isYouth=${ctx.isYouth})`,
      );
    }
    if (seenSlots.has(ctx.slot)) {
      throw new Error(`pairInitialSeniorBlueprints requires unique slots (duplicate slot=${ctx.slot})`);
    }
    seenSlots.add(ctx.slot);
    if (
      ctx.clubId !== first.ctx.clubId ||
      ctx.seed !== first.ctx.seed ||
      ctx.seasonId !== first.ctx.seasonId ||
      ctx.currentDivision !== first.ctx.currentDivision ||
      ctx.totalDivisions !== first.ctx.totalDivisions
    ) {
      throw new Error(
        "pairInitialSeniorBlueprints requires one coherent club/seed/season/division batch",
      );
    }
  }
  if (blueprints.length === 1) return [{ blueprint: blueprints[0], assignedRawZ: blueprints[0].rawZ }];

  const activity = activityModifiersFor(gameConfig.playerGeneration.initialSeniorHistoricalActivity);

  // Counter-pair within age bands rather than across the whole squad. This
  // preserves the intended young-to-prime-to-decline cross-sectional age signal
  // while still removing variance from profile stage differences inside each
  // band. Because reconstructCurrentTarget is linear in the peak target, this
  // is exactly the bundle contribution at the player's actual age.
  const ageBandWidth = gameConfig.playerGeneration.initialSeniorQualityPairingAgeBandWidth;
  const stageOffset = (blueprint: SeniorGenerationBlueprint): number =>
    reconstructCurrentTarget(blueprint.profile, 0, blueprint.age, activity.growth, activity.decline).current;
  const pairingRng = playerRng(first.ctx.seed, first.ctx.clubId, "initial-senior-pairing", 0, first.ctx.seasonId);
  // Allocate tickets randomly across age bands first. This keeps every age
  // band representative in expectation and prevents a systematic quality
  // gradient by age; the exact raw-Z multiset remains unchanged.
  const qualityTickets = [...blueprints].map((blueprint) => ({
    rawZ: blueprint.rawZ,
    sourceSlot: blueprint.ctx.slot,
  }));
  for (let i = qualityTickets.length - 1; i > 0; i--) {
    const j = nextInt(pairingRng, i + 1);
    const tmp = qualityTickets[i];
    qualityTickets[i] = qualityTickets[j];
    qualityTickets[j] = tmp;
  }

  const careersByBand = new Map<number, SeniorGenerationBlueprint[]>();
  for (const blueprint of blueprints) {
    const band = Math.floor(blueprint.age / ageBandWidth);
    const careers = careersByBand.get(band) ?? [];
    careers.push(blueprint);
    careersByBand.set(band, careers);
  }

  const bySlot = new Map<number, number>();
  let ticketOffset = 0;
  for (const [, careers] of [...careersByBand.entries()].sort(([a], [b]) => a - b)) {
    // Strongest stage first; slot order breaks ties deterministically.
    careers.sort((a, b) => {
      const diff = stageOffset(b) - stageOffset(a);
      return diff !== 0 ? diff : a.ctx.slot - b.ctx.slot;
    });

    const bandTickets = qualityTickets.slice(ticketOffset, ticketOffset + careers.length).sort((a, b) => {
      const diff = a.rawZ - b.rawZ;
      return diff !== 0 ? diff : a.sourceSlot - b.sourceSlot;
    });
    ticketOffset += careers.length;

    for (let index = 0; index < careers.length; index++) {
      bySlot.set(careers[index].ctx.slot, bandTickets[index].rawZ);
    }
  }

  return blueprints.map((blueprint) => ({ blueprint, assignedRawZ: bySlot.get(blueprint.ctx.slot)! }));
}

export interface InitialSeniorAssignment {
  blueprint: SeniorGenerationBlueprint;
  assignedRawZ: number;
  targetCurrentOverall: number;
}

/**
 * Condition one initial senior cohort to its division-relative current-OVR
 * band and exact target mean. Ages and career profiles stay untouched; the
 * effective peak coordinate is solved from the selected point on each
 * player's own curve.
 */
export function conditionInitialSeniorBlueprints(
  blueprints: readonly SeniorGenerationBlueprint[],
): InitialSeniorAssignment[] {
  if (blueprints.length === 0) return [];
  const paired = pairInitialSeniorBlueprints(blueprints);
  const first = blueprints[0].ctx;
  const targets = initialClubQualityTargets(first.currentDivision, first.totalDivisions);
  const activity = activityModifiersFor(gameConfig.playerGeneration.initialSeniorHistoricalActivity);
  const peakMean = seniorPeakMean(first.currentDivision, first.totalDivisions);
  const sigma = qualitySigma();

  const stageOffsets = paired.map(({ blueprint }) =>
    reconstructCurrentTarget(blueprint.profile, 0, blueprint.age, activity.growth, activity.decline).current,
  );
  const baseCurrentTargets = paired.map(({ assignedRawZ }, index) =>
    peakMean + sigma * assignedRawZ + stageOffsets[index],
  );
  const lowerBounds = stageOffsets.map((stage) => Math.max(targets.lower, OVR_MIN + stage));
  const upperBounds = stageOffsets.map((stage) => Math.min(targets.upper, OVR_MAX + stage));
  const projected = projectValuesToBoundedMean(baseCurrentTargets, lowerBounds, upperBounds, targets.mean);

  return paired.map(({ blueprint }, index) => {
    const assignedPeak = projected[index] - stageOffsets[index];
    return {
      blueprint,
      assignedRawZ: (assignedPeak - peakMean) / sigma,
      targetCurrentOverall: projected[index],
    };
  });
}

/**
 * Initial-club hard bands are expressed in visible integer OVR. The normal
 * recipe lands within one point of its target, so a boundary target can very
 * occasionally land just outside. Move every skill together until the rounded
 * OVR is back inside; this is deterministic and is never used by ordinary or
 * seasonal generation.
 */
function fitSkillsToOverallBand(position: Position, input: SkillSet, lower: number, upper: number): SkillSet {
  const integerLower = Math.ceil(lower);
  const integerUpper = Math.floor(upper);
  if (integerLower > integerUpper) throw new Error(`No integer OVR exists inside band ${lower}..${upper}`);
  let skills = { ...input };
  for (let step = 0; step <= 100; step++) {
    const overall = overallFromSkills(position, skills);
    if (overall >= integerLower && overall <= integerUpper) return skills;
    const delta = overall < integerLower ? 1 : -1;
    const adjusted = { ...skills };
    for (const key of SKILL_KEYS) adjusted[key] = clampNumber(adjusted[key] + delta, 1, 100);
    if (SKILL_KEYS.every((key) => adjusted[key] === skills[key])) break;
    skills = adjusted;
  }
  throw new Error(`Unable to fit generated skills into OVR band ${integerLower}..${integerUpper}`);
}

/**
 * Shift a vector as little as possible while satisfying heterogeneous bounds
 * and an exact mean. The shared shift preserves all pairwise differences until
 * an item reaches a boundary; deterministic residual correction removes the
 * final floating-point remainder.
 */
export function projectValuesToBoundedMean(
  values: readonly number[],
  lowerBounds: readonly number[],
  upperBounds: readonly number[],
  targetMean: number,
): number[] {
  if (values.length === 0) {
    if (lowerBounds.length !== 0 || upperBounds.length !== 0) throw new Error("Bounded-mean projection length mismatch");
    return [];
  }
  if (values.length !== lowerBounds.length || values.length !== upperBounds.length) {
    throw new Error("Bounded-mean projection length mismatch");
  }
  if (!Number.isFinite(targetMean)) throw new Error("Bounded-mean projection requires a finite target mean");
  for (let i = 0; i < values.length; i++) {
    if (![values[i], lowerBounds[i], upperBounds[i]].every(Number.isFinite)) {
      throw new Error(`Bounded-mean projection requires finite values (index ${i})`);
    }
    if (lowerBounds[i] > upperBounds[i]) {
      throw new Error(`Bounded-mean projection has inverted bounds at index ${i}`);
    }
  }

  const targetSum = targetMean * values.length;
  const minimumSum = lowerBounds.reduce((sum, value) => sum + value, 0);
  const maximumSum = upperBounds.reduce((sum, value) => sum + value, 0);
  const epsilon = 1e-9;
  if (targetSum < minimumSum - epsilon || targetSum > maximumSum + epsilon) {
    throw new Error(`Bounded-mean projection target ${targetMean} is infeasible`);
  }

  let lowShift = Math.min(...values.map((value, i) => lowerBounds[i] - value));
  let highShift = Math.max(...values.map((value, i) => upperBounds[i] - value));
  for (let iteration = 0; iteration < 100; iteration++) {
    const shift = (lowShift + highShift) / 2;
    const sum = values.reduce(
      (total, value, i) => total + clampNumber(value + shift, lowerBounds[i], upperBounds[i]),
      0,
    );
    if (sum < targetSum) lowShift = shift;
    else highShift = shift;
  }

  const shift = (lowShift + highShift) / 2;
  const projected = values.map((value, i) => clampNumber(value + shift, lowerBounds[i], upperBounds[i]));
  let residual = targetSum - projected.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < projected.length && Math.abs(residual) > 1e-10; i++) {
    const room = residual > 0 ? upperBounds[i] - projected[i] : projected[i] - lowerBounds[i];
    const adjustment = Math.sign(residual) * Math.min(Math.abs(residual), Math.max(0, room));
    projected[i] += adjustment;
    residual -= adjustment;
  }
  if (Math.abs(residual) > 1e-7) throw new Error("Bounded-mean projection could not correct its residual");
  return projected;
}

/**
 * Generate a complete initial senior squad through the squad-level pairing
 * step. Every context must be an initial-senior senior slot; no candidate
 * players, rejection loops, or extra raw-Z/profile/age draws are permitted.
 * Players are returned in original slot order.
 */
export function generateInitialSeniorPlayers(contexts: readonly GeneratePlayerContext[]): Player[] {
  const invalid = contexts.find((ctx) => ctx.generationType !== "initial-senior" || ctx.isYouth);
  if (invalid !== undefined) {
    throw new Error(
      `generateInitialSeniorPlayers requires initial-senior senior contexts (got generationType=${invalid.generationType}, isYouth=${invalid.isYouth})`,
    );
  }
  const blueprints = contexts.map(drawSeniorGenerationBlueprint);
  const conditioned = conditionInitialSeniorBlueprints(blueprints);
  const activity = gameConfig.playerGeneration.initialSeniorHistoricalActivity;
  if (contexts.length === 0) return [];
  const band = initialClubQualityTargets(contexts[0].currentDivision, contexts[0].totalDivisions);
  return conditioned.map(({ blueprint, assignedRawZ }) =>
    buildSeniorPlayerFromBlueprint(blueprint, assignedRawZ, activity, band),
  );
}

/**
 * Generate one academy player. His peak anchor comes from the club's academy
 * pedigree, so a strong academy produces better prospects rather than
 * teenagers who are already first-team stars.
 */
export function generateYouthPlayer(ctx: GeneratePlayerContext): Player {
  const blueprint = drawYouthGenerationBlueprint(ctx);
  return buildYouthPlayerFromBlueprint(blueprint, blueprint.rawZ);
}

export interface InitialAcademyAssignment {
  blueprint: YouthGenerationBlueprint;
  assignedRawZ: number;
  assignedPeakTarget: number;
}

function validateInitialAcademyContexts(contexts: readonly GeneratePlayerContext[]): void {
  if (contexts.length === 0) return;
  const first = contexts[0];
  const seenSlots = new Set<number>();
  for (const ctx of contexts) {
    if (ctx.generationType !== "initial-academy" || !ctx.isYouth || ctx.age === undefined) {
      throw new Error(
        `generateInitialAcademyPlayers requires explicit-age initial-academy youth contexts (got generationType=${ctx.generationType}, isYouth=${ctx.isYouth}, age=${ctx.age})`,
      );
    }
    if (seenSlots.has(ctx.slot)) throw new Error(`generateInitialAcademyPlayers requires unique slots (duplicate slot=${ctx.slot})`);
    seenSlots.add(ctx.slot);
    if (
      ctx.clubId !== first.clubId ||
      ctx.seed !== first.seed ||
      ctx.seasonId !== first.seasonId ||
      ctx.currentDivision !== first.currentDivision ||
      ctx.highestDivisionReached !== first.highestDivisionReached ||
      ctx.totalDivisions !== first.totalDivisions
    ) {
      throw new Error("generateInitialAcademyPlayers requires one coherent club/seed/season/division batch");
    }
  }
}

/**
 * Condition the initial academy's future personal peaks to the club's
 * division-relative band, then counter-pair within exact ages. Seasonal intake
 * never calls this helper.
 */
export function conditionInitialAcademyBlueprints(
  blueprints: readonly YouthGenerationBlueprint[],
): InitialAcademyAssignment[] {
  validateInitialAcademyContexts(blueprints.map((blueprint) => blueprint.ctx));
  if (blueprints.length === 0) return [];
  const first = blueprints[0].ctx;
  const targets = initialClubQualityTargets(first.currentDivision, first.totalDivisions);
  const pedigree = academyPedigree(first.currentDivision, first.highestDivisionReached, first.totalDivisions);
  const peakMean = academyPeakMean(pedigree);
  const sigma = academyQualitySigma();
  if (sigma <= 0) throw new Error("Initial academy conditioning requires a positive academy quality spread");

  const basePeaks = blueprints.map((blueprint) => peakMean + sigma * blueprint.rawZ);
  const lowerBounds = blueprints.map(() => targets.lower);
  const upperBounds = blueprints.map(() => targets.upper);
  const projectedPeaks = projectValuesToBoundedMean(basePeaks, lowerBounds, upperBounds, targets.mean);

  const pairingRng = playerRng(first.seed, first.clubId, "initial-academy-pairing", 0, first.seasonId);
  const tickets = projectedPeaks.map((peakTarget, index) => ({
    peakTarget,
    sourceSlot: blueprints[index].ctx.slot,
  }));
  for (let i = tickets.length - 1; i > 0; i--) {
    const j = nextInt(pairingRng, i + 1);
    const tmp = tickets[i];
    tickets[i] = tickets[j];
    tickets[j] = tmp;
  }

  const activity = generationActivityModifiers();
  const byAge = new Map<number, YouthGenerationBlueprint[]>();
  for (const blueprint of blueprints) {
    const group = byAge.get(blueprint.age) ?? [];
    group.push(blueprint);
    byAge.set(blueprint.age, group);
  }

  const peakBySlot = new Map<number, number>();
  let ticketOffset = 0;
  for (const [, careers] of [...byAge.entries()].sort(([a], [b]) => a - b)) {
    careers.sort((a, b) => {
      const stageA = reconstructCurrentTarget(a.profile, 0, a.age, activity.growth, activity.decline).current;
      const stageB = reconstructCurrentTarget(b.profile, 0, b.age, activity.growth, activity.decline).current;
      const difference = stageB - stageA;
      return difference !== 0 ? difference : a.ctx.slot - b.ctx.slot;
    });
    const ageTickets = tickets.slice(ticketOffset, ticketOffset + careers.length).sort((a, b) => {
      const difference = a.peakTarget - b.peakTarget;
      return difference !== 0 ? difference : a.sourceSlot - b.sourceSlot;
    });
    ticketOffset += careers.length;
    for (let index = 0; index < careers.length; index++) {
      peakBySlot.set(careers[index].ctx.slot, ageTickets[index].peakTarget);
    }
  }

  return blueprints.map((blueprint) => {
    const assignedPeakTarget = peakBySlot.get(blueprint.ctx.slot)!;
    return {
      blueprint,
      assignedPeakTarget,
      assignedRawZ: (assignedPeakTarget - peakMean) / sigma,
    };
  });
}

/** Build one complete, conditioned initial academy cohort in slot order. */
export function generateInitialAcademyPlayers(contexts: readonly GeneratePlayerContext[]): Player[] {
  validateInitialAcademyContexts(contexts);
  const blueprints = contexts.map(drawYouthGenerationBlueprint);
  return conditionInitialAcademyBlueprints(blueprints).map(({ blueprint, assignedRawZ, assignedPeakTarget }) =>
    buildYouthPlayerFromBlueprint(blueprint, assignedRawZ, assignedPeakTarget),
  );
}

export { academyContractSeasonsForAge };

export { gameConfig };
