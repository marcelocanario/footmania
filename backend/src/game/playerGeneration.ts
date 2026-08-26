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
  generationActivityModifiers,
  reconstructCurrentTarget,
} from "./careerCurves";
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
// Fixed statistical constants — not designer-facing knobs.
// ---------------------------------------------------------------------------

export const PLAYER_Z_MIN = -3.0;
export const PLAYER_Z_MAX = 3.0;
export const DIVISION_CURVE_K = 0.5;
export const SKILL_TARGET_TOLERANCE_OVR = 1.0;
export const SKILL_GENERATION_MAX_RETRIES = 8;

/** Authoritative engine OVR bounds (the engine's global 1..100 scale). */
export const OVR_MIN = 1;
export const OVR_MAX = 100;

/** Full OVR range. */
export function overallRange(): number {
  return OVR_MAX - OVR_MIN;
}

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

/**
 * Shared career-shaped construction: anchor the personal peak, reconstruct how
 * much of the curve this age has already lived, then generate skills toward the
 * resulting target. The persisted overall is always recomputed from the skills.
 */
function generateFromPeakAnchor(ctx: GeneratePlayerContext, peakMean: number, sigma: number, age: number, rng: RngState, rawZ: number): Player {
  const profile = generateCareerProfile(rng);
  const personalPeakTarget = peakMean + sigma * rawZ;
  const activity = generationActivityModifiers();
  const reconstructed = reconstructCurrentTarget(profile, personalPeakTarget, age, activity.growth, activity.decline);
  const target = Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(reconstructed.current)));
  const { skills } = generateSkillsForTarget(rng, ctx.position, target);
  const actualOverall = overallFromSkills(ctx.position, skills);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, rawZ, actualOverall, reconstructed, skills);
}

/**
 * Generate one senior player. His personal peak is anchored on the club's
 * current division; his current OVR is where that peak, his own career curve,
 * and his age put him today.
 */
export function generateSeniorPlayer(ctx: GeneratePlayerContext): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const age = ctx.age ?? drawSeniorAge(rng, ctx.position);
  return generateFromPeakAnchor(ctx, seniorPeakMean(ctx.currentDivision, ctx.totalDivisions), qualitySigma(), age, rng, rawZ);
}

/**
 * Generate one academy player. His peak anchor comes from the club's academy
 * pedigree, so a strong academy produces better prospects rather than
 * teenagers who are already first-team stars.
 */
export function generateYouthPlayer(ctx: GeneratePlayerContext): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const rawZ = drawRawZ(rng);
  const age = ctx.age ?? drawYouthAge(rng);
  const pedigree = academyPedigree(ctx.currentDivision, ctx.highestDivisionReached, ctx.totalDivisions);
  return generateFromPeakAnchor(ctx, academyPeakMean(pedigree), academyQualitySigma(), age, rng, rawZ);
}

export { academyContractSeasonsForAge };

export { gameConfig };
