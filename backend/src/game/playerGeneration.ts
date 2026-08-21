import type { Player, Position, RngState, SkillSet } from "./types";
import { createRng, nextInt, truncatedNormal } from "./rng";
import { generateName } from "./names";
import { DAYS_PER_YEAR, DEVELOPMENT } from "./constants";
import { overallFromSkills, SKILL_KEYS, OVERALL_SCALE } from "./rating";
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
 * The three tuning knobs live in gameConfig.playerGeneration; every other
 * constant below is a Version 1 fixed statistical constant from the spec.
 */

// ---------------------------------------------------------------------------
// Fixed Version 1 statistical constants (spec §7) — not designer-facing knobs.
// ---------------------------------------------------------------------------

export const PLAYER_Z_MIN = -3.0;
export const PLAYER_Z_MAX = 3.0;
export const TOP_DIVISION_HEADROOM_SIGMAS = 4.0;
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

/** Individual quality spread: sigma = spreadFraction * R (spec §6/§77). */
export function qualitySigma(): number {
  return gameConfig.playerGeneration.playerQualitySpreadFraction * overallRange();
}

/** Top-division senior mean: OVR_MAX - 4σ (spec §8). */
export function topDivisionMean(): number {
  return OVR_MAX - TOP_DIVISION_HEADROOM_SIGMAS * qualitySigma();
}

/** Bottom-division senior mean: μ_top - 3σ (spec §9). */
export function bottomDivisionMean(): number {
  return topDivisionMean() - gameConfig.playerGeneration.divisionSpanSigmas * qualitySigma();
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

/** Division mean μ(D) = μ_bottom + 3σ·S(D) (spec §11). */
export function divisionMean(division: number, totalDivisions: number): number {
  return bottomDivisionMean() + gameConfig.playerGeneration.divisionSpanSigmas * qualitySigma() * divisionStrength(division, totalDivisions);
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

/** Academy-adjusted quality score ZA = Z + academyPedigreeSigmas·PA (spec §23). */
export function academyAdjustedZ(rawZ: number, pedigree: number): number {
  return rawZ + gameConfig.playerGeneration.academyPedigreeSigmas * pedigree;
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
 * exact standard normal percentile thresholds. Raw Z — not ZA — keeps academy
 * pedigree from indirectly modifying future development. The tier is a server-
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

const TACTICAL_PAIRS: Record<Position, [number, number][]> = {
  0: [[0, 3], [0, 1], [2, 0], [1, 2], [3, 1], [0, 2]],
  1: [[6, 10], [6, 13], [10, 11], [10, 13], [10, 6], [10, 9], [6, 11]],
  2: [[7, 10], [7, 12], [7, 5], [10, 13], [7, 13], [7, 10], [7, 5], [7, 13], [7, 12], [7, 9], [7, 10], [5, 12]],
  3: [[4, 11], [4, 9], [9, 11], [11, 9], [4, 8], [4, 13], [7, 10], [7, 11], [7, 5], [7, 13], [10, 13], [10, 11], [9, 4], [10, 12], [4, 11], [8, 11], [7, 9], [11, 13], [7, 11]],
  4: [[9, 5], [13, 9], [9, 5], [8, 9], [9, 13], [9, 5], [9, 8], [5, 13], [8, 11], [9, 11], [9, 12], [13, 8]],
};

/** Fixed supporting-skill baseline retained from the existing skill model. */
const SUPPORTING_SKILL_BASE = 16;

function sideVariant(position: Position, c1: number, c2: number): number {
  if (position === 0 || position === 2) return 0;
  if (position === 1) {
    if (c1 === 13 || c1 === 6) return 1;
    if (c1 === 7 || c1 === 10) return 0;
    if (c2 === 13 || c1 === 6) return 1;
    if (c2 === 7 || c2 === 10) return 0;
    if (c1 === 8 || c1 === 9 || c1 === 11 || c1 === 4) return 1;
    return 0;
  }
  if (position === 3) {
    if (c1 === 11 || c1 === 9 || c1 === 8 || c1 === 4) return 1;
    if (c1 === 7 || c1 === 10) return 0;
    if (c2 === 11 || c2 === 9 || c2 === 8 || c2 === 4) return 1;
    if (c2 === 7 || c2 === 10) return 0;
    return 1;
  }
  if (position === 4) {
    if (c1 === 7 || c1 === 10) return 0;
    if (c1 === 8 || c1 === 13 || c1 === 6) return 2;
    return 1;
  }
  return 0;
}

/** The base Brasfoot-style skill generator, independent of club ownership or division. */
function generateRawSkills(rng: RngState, position: Position, c1: number, c2: number, overall: number): SkillSet {
  const n2 = SUPPORTING_SKILL_BASE;
  const n4 = Math.round(n2 / 3);
  const n3 = 3;
  let s: SkillSet = { gol: 1, vel: 1, tec: 1, pas: 1, des: 1, arm: 1, fin: 1 };
  const variant = sideVariant(position, c1, c2);
  if (position === 0) {
    s.gol = overall + nextInt(rng, 2);
    s.vel = n2 + nextInt(rng, 7);
    s.tec = n2 + nextInt(rng, 4);
    s.pas = n2 + nextInt(rng, 4);
    s.des = n3 + nextInt(rng, 3);
    s.arm = n3 + nextInt(rng, 3);
    s.fin = n3 + nextInt(rng, 3);
  } else if (position === 1) {
    s.gol = 1 + nextInt(rng, 4);
    if (variant === 0) {
      s.des = Math.round(overall * 0.8) + nextInt(rng, 6);
      s.fin = n3 + nextInt(rng, 4);
      s.pas = n2 + nextInt(rng, 3);
      s.tec = n2 + nextInt(rng, 7);
      s.arm = n3 + nextInt(rng, 5);
      s.vel = n2 + n3 + nextInt(rng, 6);
    } else {
      s.arm = Math.round(overall * 0.5) + nextInt(rng, 5);
      s.fin = n2 + n3 + nextInt(rng, 4);
      s.pas = n2 + n4 + nextInt(rng, 3);
      s.tec = n2 + n4 + nextInt(rng, 7);
      s.des = n2 + nextInt(rng, 4);
      s.vel = n2 + n3 + nextInt(rng, 4);
    }
  } else if (position === 2) {
    s.gol = 1 + nextInt(rng, 7);
    s.des = Math.round(overall * 0.9) + nextInt(rng, 2);
    s.vel = n2 + n3 + nextInt(rng, 4);
    s.tec = n2 + n3 + nextInt(rng, 7);
    s.pas = n2 + n3 + nextInt(rng, 3);
    s.arm = n3 + nextInt(rng, 6);
    s.fin = n2 + nextInt(rng, 5);
  } else if (position === 3) {
    s.gol = 1 + nextInt(rng, 4);
    if (variant === 0) {
      s.des = Math.round(overall * 0.7) + nextInt(rng, 6);
      s.fin = n2 + nextInt(rng, 4);
      s.pas = n2 + nextInt(rng, 3);
      s.tec = n2 + nextInt(rng, 7);
      s.arm = n2 + nextInt(rng, 5);
      s.vel = n2 + n3 + nextInt(rng, 6);
    } else {
      s.arm = overall + nextInt(rng, 2);
      s.fin = n2 + n4 + nextInt(rng, 4);
      s.pas = n2 + n3 + nextInt(rng, 3);
      s.tec = n2 + n4 + nextInt(rng, 7);
      s.des = n2 + nextInt(rng, 4);
      s.vel = n2 + n4 + nextInt(rng, 4);
    }
  } else {
    s.gol = 1 + nextInt(rng, 6);
    s.fin = Math.round(overall * 0.8) + nextInt(rng, 2);
    s.vel = n2 + n4 + nextInt(rng, 4);
    s.tec = n2 + n4 + nextInt(rng, 7);
    s.pas = n2 + n3 + nextInt(rng, 3);
    s.des = n3 + nextInt(rng, 6);
    s.arm = n2 + n3 + nextInt(rng, 5);
  }
  const applyTrait = (c: number, primary: boolean) => {
    if (position === 0) {
      if (c === 0 || c === 3) s.tec += primary ? 2 + nextInt(rng, 5) : nextInt(rng, 2);
      if (c === 2) s.vel += primary ? 2 + nextInt(rng, 5) : nextInt(rng, 2);
      if (c === 1) s.gol += primary ? 1 + nextInt(rng, 3) : nextInt(rng, 2);
    } else if (position === 1) {
      if (c === 4) { s.arm += n3 + nextInt(rng, 5); s.pas += n3 + nextInt(rng, 5); }
      if (c === 5) { s.fin += 2 + nextInt(rng, 3); s.des += 2 + nextInt(rng, 3); }
      if (c === 6) s.pas += 2 + nextInt(rng, 3);
      if (c === 7) s.des += n3 + nextInt(rng, 3);
      if (c === 8) s.tec += n3 + nextInt(rng, 3);
      if (c === 9) { s.fin += n3 + nextInt(rng, 3); s.vel += n3 + nextInt(rng, 3); }
      if (c === 10) s.des += n3 + nextInt(rng, 5);
      if (c === 11) s.pas += n3 + nextInt(rng, 3);
      if (c === 12) s.des += 3 + nextInt(rng, 3);
      if (c === 13) s.vel += n2 + nextInt(rng, 3);
    } else if (position === 2) {
      if (c === 4) { s.arm += n3 + nextInt(rng, 5); s.pas += n3 + nextInt(rng, 5); }
      if (c === 5) s.arm += n3 + nextInt(rng, 6);
      if (c === 6) s.pas += 2 + nextInt(rng, 3);
      if (c === 7) s.des += n3 + nextInt(rng, 3);
      if (c === 8) s.tec += n3 + nextInt(rng, 3);
      if (c === 9) { s.arm += 3 + nextInt(rng, 3); s.fin += 3 + nextInt(rng, 3); }
      if (c === 10) { s.des += 3 + nextInt(rng, 3); s.pas += 2 + nextInt(rng, 3); }
      if (c === 11) s.pas += n3 + nextInt(rng, 3);
      if (c === 12) s.des += n3 + nextInt(rng, 2);
      if (c === 13) s.vel += n2 + nextInt(rng, 3);
    } else if (position === 3) {
      if (c === 4) { s.arm += n3 + nextInt(rng, 5); s.pas += n3 + nextInt(rng, 5); }
      if (c === 5) { s.fin += 2 + nextInt(rng, 3); s.des += 2 + nextInt(rng, 3); }
      if (c === 6) s.pas += 2 + nextInt(rng, 3);
      if (c === 7) s.des += n3 + nextInt(rng, 3);
      if (c === 8) s.tec += n3 + nextInt(rng, 3);
      if (c === 9) s.fin += n3 + nextInt(rng, 3);
      if (c === 10) s.des += 3 + nextInt(rng, 3);
      if (c === 11) s.pas += n3 + nextInt(rng, 2);
      if (c === 12) s.des += 3 + nextInt(rng, 3);
      if (c === 13) s.vel += n2 + nextInt(rng, 3);
    } else {
      if (c === 4) { s.arm += n2 + nextInt(rng, 5); s.pas += n3 + nextInt(rng, 5); }
      if (c === 5) s.fin += 2 + nextInt(rng, 3);
      if (c === 6) s.pas += 2 + nextInt(rng, 3);
      if (c === 7) s.des += n3 + nextInt(rng, 3);
      if (c === 8) s.tec += n3 + nextInt(rng, 3);
      if (c === 9) s.fin += 3 + nextInt(rng, 3);
      if (c === 10) s.des += 3 + nextInt(rng, 3);
      if (c === 11) s.pas += n2 + nextInt(rng, 2);
      if (c === 12) { s.des += 3 + nextInt(rng, 3); s.fin += 2; }
      if (c === 13) s.vel += n2 + nextInt(rng, 3);
    }
  };
  applyTrait(c1, true);
  applyTrait(c2, false);
  for (const key of Object.keys(s) as (keyof SkillSet)[]) {
    if (s[key] > 100) s[key] = 100;
  }
  return s;
}

/**
 * Generate skills that produce an OVR within tolerance of `target`, preserving
 * the positional/tactical skill shape. Bounded retries (spec §39).
 */
export function generateSkillsForTarget(rng: RngState, position: Position, target: number): { skills: SkillSet; c1: number; c2: number } {
  const pairs = TACTICAL_PAIRS[position];
  let best: SkillSet | null = null;
  let bestError = Infinity;
  for (let attempt = 0; attempt < SKILL_GENERATION_MAX_RETRIES; attempt++) {
    const pair = pairs[nextInt(rng, pairs.length)];
    let skills = generateRawSkills(rng, position, pair[0], pair[1], target);
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
      return { skills, c1: pair[0], c2: pair[1] };
    }
    if (error < bestError) {
      bestError = error;
      best = skills;
    }
  }
  return { skills: best ?? generateRawSkills(rng, position, TACTICAL_PAIRS[position][0][0], TACTICAL_PAIRS[position][0][1], target), c1: TACTICAL_PAIRS[position][0][0], c2: TACTICAL_PAIRS[position][0][1] };
}

// ---------------------------------------------------------------------------
// Roster slot allocation (spec §17, largest-remainder method)
// ---------------------------------------------------------------------------

/** Deterministic largest-remainder allocation of `total` slots across weights. */
export function allocateSlots(weights: number[], total: number): number[] {
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

/** Canonical senior position weights: GK 10% / DEF 32% / MID 32% / ATT 26%. */
export const SENIOR_POSITION_WEIGHTS = [0.1, 0.32, 0.32, 0.26];
const POSITION_GROUPS: Position[] = [0, 1, 2, 3, 4];

/**
 * Build the senior roster position template using the canonical weights via the
 * largest-remainder method. Broad groups map to base positions 0..4 (GK, FB,
 * CB, MF, FW), matching the existing subposition assignment inside each group.
 */
export function seniorRosterTemplate(total: number): Position[] {
  const counts = allocateSlots(SENIOR_POSITION_WEIGHTS, total);
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
  c1: number,
  c2: number,
): Player {
  const rng = playerRng(ctx.seed, ctx.clubId, ctx.generationType, ctx.slot, ctx.seasonId);
  const contractDays = ctx.isYouth ? DAYS_PER_YEAR * gameConfig.playerGenerationRules.academyContractSeasons : DAYS_PER_YEAR * (1 + nextInt(rng, 3));
  const salary = ctx.isYouth ? calculateAcademySalary(actualOverall, age) : calculateBaseSalary(actualOverall, age);
  const value = calculatePlayerValue(actualOverall, age, remainingSeasons(contractDays));
  const player: Player = {
    id: ctx.id,
    name: generateName(rng, ctx.country),
    country: ctx.country,
    age,
    position: ctx.position,
    side: nextInt(rng, 2),
    skills,
    overall: actualOverall,
    potential,
    characteristic1: c1,
    characteristic2: c2,
    energy: 100,
    salary,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value,
    releaseClause: 0,
    injuryDays: 0,
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
  const { skills, c1, c2 } = generateSkillsForTarget(rng, ctx.position, Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(target))));
  const actualOverall = overallFromSkills(ctx.position, skills);
  const profile = generateDevelopmentProfile(rng);
  const potential = initialPotential(actualOverall, age, profile.declineStartAge, profile.developmentRate);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, rawZ, actualOverall, potential, skills, c1, c2);
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
  const zA = academyAdjustedZ(rawZ, pedigree);
  const muAge = youthDivisionMeanForAge(age);
  const target = muAge + qualitySigma() * zA;
  const { skills, c1, c2 } = generateSkillsForTarget(rng, ctx.position, Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(target))));
  const actualOverall = overallFromSkills(ctx.position, skills);
  const profile = generateDevelopmentProfile(rng);
  const potential = initialPotential(actualOverall, age, profile.declineStartAge, profile.developmentRate);
  return buildGeneratedPlayer({ ...ctx, age }, age, profile, rawZ, actualOverall, potential, skills, c1, c2);
}

export { gameConfig };
