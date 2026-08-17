import type { Club, Player, PlayerDevelopmentProfile, Position, RngState, SkillSet } from "./types";
import { beta, chance, chanceDenom, createRng, nextInt, truncatedNormal } from "./rng";
import { generateName } from "./names";
import { COUNTRIES } from "./countries";
import { DAYS_PER_YEAR, DEVELOPMENT } from "./constants";
import { overallFromSkills, SKILL_KEYS, trainingWeights } from "./rating";

export { overallFromSkills } from "./rating";

export const CHARACTERISTIC_NAMES = [
  "Positioning", "Penalty Save", "Reflexes", "Off the Line", "Playmaking",
  "Heading", "Crossing", "Tackling", "Dribbling", "Finishing",
  "Marking", "Passing", "Stamina", "Speed",
];

const TACTICAL_PAIRS: Record<number, [number, number][]> = {
  0: [[0, 3], [0, 1], [2, 0], [1, 2], [3, 1], [0, 2]],
  1: [[6, 10], [6, 13], [10, 11], [10, 13], [10, 6], [10, 9], [6, 11]],
  2: [[7, 10], [7, 12], [7, 5], [10, 13], [7, 13], [7, 10], [7, 5], [7, 13], [7, 12], [7, 9], [7, 10], [5, 12]],
  3: [[4, 11], [4, 9], [9, 11], [11, 9], [4, 8], [4, 13], [7, 10], [7, 11], [7, 5], [7, 13], [10, 13], [10, 11], [9, 4], [10, 12], [4, 11], [8, 11], [7, 9], [11, 13], [7, 11]],
  4: [[9, 5], [13, 9], [9, 5], [8, 9], [9, 13], [9, 5], [9, 8], [5, 13], [8, 11], [9, 11], [9, 12], [13, 8]],
};

const TIER_ROLLS_HIGH = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TIER_BOUNDS_HIGH = [2, 5, 4, 10, 25, 60, 80, 90, 98, 100];
const TIER_BOUNDS_MID = [2, 5, 4, 10, 30, 65, 90, 95, 98, 100];
const TIER_BOUNDS_LOW = [4, 8, 15, 25, 50, 75, 95, 98, 99, 100];

function tierFromBounds(rng: RngState, bounds: number[]): number {
  const roll = nextInt(rng, 100) + 1;
  for (let i = 0; i < bounds.length; i++) {
    if (roll <= bounds[i]) return i + 1;
  }
  return 10;
}

function tierForClub(rng: RngState, club: Club): number {
  if (club.level >= 19 || club.reputation > 3) return tierFromBounds(rng, TIER_BOUNDS_HIGH);
  if (club.level >= 15) return tierFromBounds(rng, TIER_BOUNDS_MID);
  return tierFromBounds(rng, TIER_BOUNDS_LOW);
}

function levelFactor(level: number): number {
  if (level <= 15) return level;
  switch (level) {
    case 16: return 17;
    case 17: return 18;
    case 18: return 19;
    case 19: return 21;
    case 20: return 25;
    case 21: return 26;
    case 22: return 27;
    case 23: return 28;
    case 24: return 29;
    case 25: return 30;
    default: return level;
  }
}

function repFactor(club: Club): [number, number] {
  const rep = Math.max(1, Math.min(5, club.reputation));
  switch (rep) {
    case 5: return [20, 7];
    case 4: return [15, 4];
    case 3: return [12, 3];
    case 2: return [8, 2];
    default: return [5, 1];
  }
}

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

// Faithful port of best/F.java j(int, int) — individual skills on Brasfoot's scale.
function generateSkills(rng: RngState, position: Position, c1: number, c2: number, overall: number, lvl: number, rep: number): SkillSet {
  const n2 = Math.max(1, levelFactor(lvl) - 4);
  const n3 = rep;
  const n4 = Math.round(n2 / 3);
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
export function calcOverall(rng: RngState, club: Club, tier: number, isStar: boolean, isYouth: boolean): number {
  const [rep] = repFactor(club);
  let base = levelFactor(club.level) + rep + nextInt(rng, 3);
  if (isStar || (club.reputation >= 4 && chance(rng, 30))) {
    base = base + 9 + nextInt(rng, 3);
  }
  if (isYouth) {
    base -= 23;
    if (base < 5) base = 10;
  }
  const group = 0;
  if (group <= 1) {
    if (club.level < 3) base = Math.round(base * 0.5);
    else if (club.level < 5) base = Math.round(base * 0.6);
    else if (club.level < 10) base = Math.round(base * 0.7);
  } else {
    if (club.level <= 5) base = Math.round(base * 0.4);
    else if (club.level < 10) base = Math.round(base * 0.65);
    else base = Math.round(base * 0.75);
  }
  if (base > 100) base = 100;
  if (base < 5) base = 5;
  return base;
}

function calcPotential(rng: RngState, age: number, overall: number): number {
  let n2 = 0;
  if (age === 16) n2 = 15;
  else if (age === 17) n2 = 35;
  else if (age === 18) n2 = 55;
  else if (age === 19) n2 = 70;
  else if (age === 20) n2 = 75;
  n2 += nextInt(rng, 5) + 1;
  n2 += overall;
  if (n2 < 1) n2 = 1;
  if (n2 > 100) n2 = 95;
  return n2;
}

export function calcValue(club: Club, overall: number, age: number, tier: number, isStar: boolean, worldClass: boolean, isYouth: boolean): number {
  const level = club.level;
  let clubFactor = level >= 21 ? 750 : level >= 20 ? 600 : level >= 18 ? 500 : level >= 12 ? 400 : 366;
  if (isStar) {
    clubFactor = level >= 22 ? Math.round(clubFactor * 3) : level >= 21 ? Math.round(clubFactor * 2) : Math.round(clubFactor * 1.7);
  }
  if (worldClass) clubFactor = Math.round(clubFactor * 1.6);
  let base = overall * 2;
  base *= base;
  let ageTerm = 0;
  if (age < 20) ageTerm = (32 - age) * 27;
  else if (age <= 25) ageTerm = (32 - age) * 22;
  else if (age < 32) ageTerm = (32 - age) * 15;
  else if (age < 34) ageTerm = (34 - age) * 10;
  else ageTerm = -(age - 34) * 50;
  clubFactor += ageTerm;
  if (clubFactor <= 0) clubFactor = 60;
  let value = base * clubFactor;
  if (isYouth) value = Math.round(value * 0.03) * tier;
  else if (isStar && tier === 10) value = Math.round(value * 1.5);
  return value;
}

export function calcSalary(club: Club, overall: number, age: number, isStar: boolean, worldClass: boolean, isYouth: boolean): number {
  // Salary is the full wage for one season (1 season = 1 in-game year).
  const SALARY_FACTORS = [0, 300, 450, 650, 900, 1200];
  const rep = Math.max(1, Math.min(5, club.reputation));
  let factor = SALARY_FACTORS[rep];
  if (club.level > 20) factor += 50;
  if (isStar || worldClass) factor = Math.round(factor * 0.5) * 2;
  factor = Math.round(factor * 0.5);
  let salary = overall * 2 * factor;
  if (isStar || worldClass) salary += overall * 250;
  if (age >= 32) salary = Math.max(500, salary - (age - 32) * 300);
  if (salary < 500) salary = 500;
  if (worldClass) salary = Math.round(salary * 1.4);
  if (isYouth) salary = Math.round(salary * 0.1);
  return salary;
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

export function generatePlayer(rng: RngState, club: Club, opts: { position?: Position; isYouth?: boolean; id: number; seed?: number }): Player {
  const isYouth = opts.isYouth ?? false;
  const tier = isYouth ? Math.max(1, tierForClub(rng, club) - 1) : tierForClub(rng, club);
  const isStar = tier === 10 && chance(rng, 10);
  const worldClass = isStar && chance(rng, 5);
  const position = opts.position ?? (() => {
    const roll = nextInt(rng, 100);
    if (roll < 10) return 0;
    if (roll < 30) return 1;
    if (roll < 50) return 2;
    if (roll < 80) return 3;
    return 4;
  })();
  const age = isYouth ? 16 + nextInt(rng, 4) : 19 + nextInt(rng, 9);
  const pairs = TACTICAL_PAIRS[position];
  const pair = pairs[nextInt(rng, pairs.length)];
  const c1 = pair[0];
  const c2 = pair[1];
  let country = club.country;
  if (isStar && club.level >= 18 && chance(rng, 50)) {
    // Weighted pick over all countries by strength (nivel 11-20).
    const pool = COUNTRIES.filter((c) => c.code !== country);
    let total = 0;
    for (const c of pool) total += c.strength - 10;
    let roll = nextInt(rng, Math.max(1, total));
    for (const c of pool) {
      roll -= c.strength - 10;
      if (roll < 0) {
        country = c.code;
        break;
      }
    }
  }
  const seedOverall = calcOverall(rng, club, tier, isStar, isYouth);
  const [ovrRep, skillRep] = repFactor(club);
  const skills = generateSkills(rng, position, c1, c2, seedOverall, club.level, skillRep);
  const overall = overallFromSkills(position, skills);
  const player: Player = {
    id: opts.id,
    name: generateName(rng, country),
    country,
    age,
    position,
    side: nextInt(rng, 2),
    skills,
    overall,
    potential: calcPotential(rng, age, overall),
    tier,
    characteristic1: c1,
    characteristic2: c2,
    energy: 100,
    salary: calcSalary(club, overall, age, isStar, worldClass, isYouth),
    value: calcValue(club, overall, age, tier, isStar, worldClass, isYouth),
    releaseClause: 0,
    injuryDays: 0,
    contractDays: isYouth ? DAYS_PER_YEAR * 4 : DAYS_PER_YEAR * (1 + nextInt(rng, 3)),
    isYouth,
    isStar,
    worldClass,
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
    clubId: club.id,
    tacPos: -1,
    onSale: false,
    salePrice: null,
    suspendedGames: 0,
    morale: 70,
    loanId: null,
    developmentProfile: { declineStartAge: 30, developmentRate: 1, developmentVolatility: 0.1 },
    recentMinutes: [],
    releaseClauseFactor: 0.2,
  };
  const releaseFactor = isYouth ? 0.35 : 0.12 + nextInt(rng, 24) / 100;
  player.releaseClause = Math.round(player.value * releaseFactor);
  player.releaseClauseFactor = releaseFactor;
  player.developmentProfile = backfillDevelopmentProfile(opts.seed ?? club.id, opts.id);
  player.recentMinutes = [];
  return player;
}

export function overallCap(club: Club): number {
  let cap = 100;
  const group = 0;
  if (group === 0) cap = 100;
  else if (group === 1) cap = 90;
  else if (group === 2) cap = 75;
  else if (group === 3) cap = 70;
  else if (group === 4) cap = 65;
  else if (group === 5) cap = 55;
  if (club.reputation < 3 && cap > 70) cap = 70;
  return cap;
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
  const activity = calculateRecentActivity(player);
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
  if (player.tier <= 3) rate += 0.03;
  else if (player.tier <= 6) rate += 0.04;
  else if (player.tier <= 8) rate += 0.07;
  else if (player.tier === 9) rate += 0.1;
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

function developmentCeiling(player: Player, club: Club): number {
  return Math.max(player.overall, Math.min(100, overallCap(club), player.potential));
}

export function refreshPlayerDerived(club: Club, player: Player): void {
  player.overall = overallFromSkills(player.position, player.skills);
  player.potential = Math.max(player.overall, Math.min(100, player.potential));
  player.value = calcValue(club, player.overall, player.age, player.tier, player.isStar, player.worldClass, player.isYouth);
  player.salary = calcSalary(club, player.overall, player.age, player.isStar, player.worldClass, player.isYouth);
  // Keep the clause proportional to the player's own randomized factor instead
  // of overwriting it with a flat 0.2 on every development tick.
  player.releaseClause = Math.round(player.value * (Number.isFinite(player.releaseClauseFactor) ? player.releaseClauseFactor : player.isYouth ? 0.35 : 0.2));
}

export function shouldRetire(rng: RngState, player: Player): boolean {
  if (player.age <= 32) return false;
  let age = player.age;
  if (player.isStar) age -= 1;
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
