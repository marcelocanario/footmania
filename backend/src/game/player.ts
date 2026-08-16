import type { Club, Player, Position, RngState, SkillSet } from "./types";
import { chance, chanceDenom, nextInt } from "./rng";
import { generateName } from "./names";
import { COUNTRY_GROUPS } from "./constants";

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
  if (club.division === 1) return [20, 7];
  if (club.division === 2) return [15, 3];
  if (club.division === 3) return [5, 1];
  if (club.reputation === 5) return [22, 7];
  if (club.reputation === 4) return [15, 4];
  return [5, 1];
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
  if (club.division === 4) clubFactor = Math.round(clubFactor * 1.3);
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
  let factor = 350;
  if (club.division === 1) factor = 750;
  else if (club.division === 2) factor = 550;
  else if (club.division === 3) factor = 500;
  else if (club.division >= 4) factor = 450;
  if (club.level > 20) factor += 50;
  if (isStar || worldClass) factor = Math.round(factor * 0.5) * 2;
  factor = Math.round(factor * 0.5);
  let salary = overall * 2 * factor;
  if (isStar || worldClass) salary += overall * 250;
  if (age >= 32) salary = Math.max(500, salary - (age - 32) * 300);
  if (salary < 500) salary = 500;
  if (worldClass) salary = Math.round(salary * 1.4);
  if (isYouth) salary = Math.round(salary * 0.1);
  return salary * 4;
}

export function generatePlayer(rng: RngState, club: Club, opts: { position?: Position; isYouth?: boolean; id: number }): Player {
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
  let country = club.stateCode === "SP" ? "BRA" : "BRA";
  if (isStar && club.level >= 18 && chance(rng, 50)) {
    const foreign = ["ARG", "URU", "COL", "POR", "ESP", "ITA", "FRA", "ING", "ALE"];
    country = foreign[nextInt(rng, foreign.length)];
  }
  const overall = calcOverall(rng, club, tier, isStar, isYouth);
  const [ovrRep, skillRep] = repFactor(club);
  const skills = generateSkills(rng, position, c1, c2, overall, club.level, skillRep);
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
    contractDays: isYouth ? 365 * 4 : 365 * (1 + nextInt(rng, 3)),
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
  };
  player.releaseClause = Math.round(player.value * (0.12 + nextInt(rng, 24) / 100));
  if (isYouth) player.releaseClause = Math.round(player.value * 0.35);
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

export function weeklyGrowth(rng: RngState, player: Player, club: Club) {
  const cap = overallCap(club);
  let rate = 0;
  let base = 50;
  let nivel = club.level;
  if (club.reputation >= 4) nivel = 20;
  else if (club.reputation === 3) nivel = 18;
  else if (club.reputation <= 2) nivel = 12;
  if (nivel >= 19) rate = player.age < 20 ? 8 / base : player.age < 23 ? 6 / base : player.age < 29 ? 5 / base : 4 / base;
  else if (nivel >= 15) rate = player.age < 18 ? 6 / base : player.age < 21 ? 5 / base : player.age < 29 ? 4 / base : 3 / base;
  else if (nivel >= 11) rate = player.age < 18 ? 5 / base : player.age < 21 ? 4 / base : player.age < 29 ? 3 / base : 2 / base;
  else rate = player.age < 18 ? 4 / base : player.age < 21 ? 3 / base : player.age < 29 ? 2 / base : 1 / base;
  if (player.starter) rate += 0.04;
  if (player.overall >= 30 && player.overall <= 40) rate -= 0.02;
  else if (player.overall >= 41 && player.overall <= 50) rate -= 0.03;
  else if (player.overall >= 51 && player.overall <= 70) rate -= 0.04;
  else if (player.overall >= 71) rate -= 0.05;
  if (player.tier >= 9) rate += 0.07;
  else if (player.tier >= 7) rate += 0.05;
  if (rate < 0.01) rate = 0.01;
  player.growthAcc += rate;
  if (player.growthAcc > 1 && player.overall < 100) {
    if (player.overall < cap) {
      player.overall += 1;
      player.growthAcc -= 1;
    } else {
      player.growthAcc = 1;
    }
  }
  if (player.overall > 100) player.overall = 100;
}

export function weeklyDecline(rng: RngState, player: Player, club: Club) {
  let d5 = player.age - 31;
  const nivel = club.level;
  let division = club.division;
  if (club.reputation >= 4) division = 1;
  else if (club.reputation >= 3) division = 2;
  else division = 3;
  if (nivel >= 20) d5 -= 2;
  let factor = 0;
  if (player.overall <= 50) factor = 0.7 * d5;
  else if (player.overall <= 70) factor = 1.0 * d5;
  else factor = 1.2 * d5;
  if (factor > 0) {
    const rate = factor / 50;
    let floor = 10;
    if (division === 1) floor = 35;
    else if (division === 2) floor = 25;
    else floor = 10;
    player.growthAcc += rate;
    if (player.growthAcc > 1 && player.overall > floor) {
      player.overall -= 1;
      player.growthAcc -= 1;
    }
  }
  if (player.overall < 1) player.overall = 1;
}

export function potentialGrowth(rng: RngState, player: Player) {
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
  if (player.age >= 35) player.overall -= 5;
  if (player.overall < 1) player.overall = 1;
  return n;
}

export function aging(rng: RngState, player: Player, club: Club) {
  player.age += 1;
  if (player.age > 35) {
    player.age = 18 + nextInt(rng, 10);
    player.name = generateName(rng, player.country);
    player.tier = Math.max(1, player.tier - 3);
  }
  player.seasonGoals = 0;
  player.seasonAssists = 0;
  player.yellows = 0;
  player.reds = 0;
}
