import type { Club, LiveMatchState, Match, MatchEvent, MatchStats, Player, RngState, SkillSet, SubSlots, World } from "./types";
import { chanceDenom, nextInt, shuffle } from "./rng";
import { lineupForMatch, tacPosToBasePosition } from "./club";
import {
  ASSISTER_WEIGHTS,
  CARD_RED_FIRST,
  CARD_RED_SECOND,
  CARD_YELLOW,
  CARD_YELLOW_PRESSING,
  CARD_YELLOW_SECOND,
  EVENT_CODES,
  GOAL_DAMPING,
  GOAL_SUBTYPES,
  INJURY_FIRST,
  INJURY_SECOND,
  OWN_GOAL_WEIGHTS,
  PRESSING_POSSESSION,
  SHOTTER_WEIGHTS,
} from "./constants";
import { injuryDays } from "./player";

export interface RatingContext {
  kind: "league" | "cup" | "state";
  homeRep: number;
  awayRep: number;
  awayClubId: number;
}

// Brasfoot c/b.java B() — per-tacPos skill weights (individual ability always on).
const RATING_WEIGHTS: Record<number, [keyof SkillSet, number][]> = {
  1: [["gol", 0.6], ["tec", 0.15], ["vel", 0.15], ["pas", 0.1]],
  2: [["des", 0.4], ["vel", 0.1], ["tec", 0.1], ["pas", 0.3], ["arm", 0.05], ["fin", 0.05]],
  3: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  4: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  5: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  6: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  7: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  8: [["des", 0.5], ["tec", 0.1], ["vel", 0.25], ["pas", 0.1], ["arm", 0.05]],
  9: [["des", 0.4], ["vel", 0.1], ["tec", 0.1], ["pas", 0.3], ["arm", 0.05], ["fin", 0.05]],
  10: [["des", 0.05], ["vel", 0.25], ["tec", 0.15], ["pas", 0.25], ["arm", 0.2], ["fin", 0.1]],
  11: [["des", 0.4], ["vel", 0.15], ["tec", 0.1], ["pas", 0.2], ["arm", 0.1], ["fin", 0.05]],
  12: [["des", 0.4], ["vel", 0.15], ["tec", 0.1], ["pas", 0.2], ["arm", 0.1], ["fin", 0.05]],
  13: [["des", 0.4], ["vel", 0.15], ["tec", 0.1], ["pas", 0.2], ["arm", 0.1], ["fin", 0.05]],
  14: [["des", 0.05], ["vel", 0.1], ["tec", 0.1], ["pas", 0.25], ["arm", 0.4], ["fin", 0.1]],
  15: [["des", 0.05], ["vel", 0.1], ["tec", 0.1], ["pas", 0.25], ["arm", 0.4], ["fin", 0.1]],
  16: [["des", 0.05], ["vel", 0.1], ["tec", 0.1], ["pas", 0.25], ["arm", 0.4], ["fin", 0.1]],
  17: [["des", 0.05], ["vel", 0.25], ["tec", 0.15], ["pas", 0.25], ["arm", 0.2], ["fin", 0.1]],
  18: [["vel", 0.25], ["tec", 0.15], ["pas", 0.15], ["arm", 0.05], ["fin", 0.4]],
  19: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  20: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  21: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  22: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  23: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  24: [["vel", 0.25], ["tec", 0.25], ["pas", 0.05], ["arm", 0.05], ["fin", 0.4]],
  25: [["vel", 0.25], ["tec", 0.15], ["pas", 0.15], ["arm", 0.05], ["fin", 0.4]],
};

// Brasfoot aq.sS — picker position ranges for cards/injuries.
const POSITION_RANGES = [
  [10, 13], [14, 17], [3, 8], [2, 3], [8, 9], [19, 24], [1, 1],
];

export function matchRating(p: Player, ctx: RatingContext): number {
  if (p.injuryDays > 0) return 1;
  const weights = RATING_WEIGHTS[p.tacPos];
  let n = 0;
  if (weights) {
    for (const [key, w] of weights) n += Math.round(p.skills[key] * w);
  }
  if (p.tacPos <= 0) n = Math.round(n * 0.5);
  if (n <= 0) n = 1;
  const clubRep = p.clubId === ctx.awayClubId ? ctx.awayRep : ctx.homeRep;
  if (ctx.kind === "state") {
    // Brasfoot's state-mode modifier applies to domestic players only.
    if (p.country === "BRA") {
      if (clubRep < 3) n = Math.round(n * 0.65);
      else if (clubRep === 3) n = Math.round(n * 0.85);
      else if (clubRep === 4) n = Math.round(n * 0.95);
    }
  } else if (ctx.kind === "league") {
    if (clubRep < 3) n = Math.round(n * 0.85);
    else if (clubRep === 3) n = Math.round(n * 0.95);
  } else if (ctx.kind === "cup") {
    if (clubRep < 3) n = Math.round(n * 0.75);
    else if (clubRep === 3) n = Math.round(n * 0.85);
  }
  return n / 10;
}

function bestN(list: Player[], lo: number, hi: number, n: number, ctx: RatingContext): number {
  let sum = 0;
  let count = 0;
  for (const p of list) {
    if (count < n && p.tacPos >= lo && p.tacPos <= hi) {
      sum += matchRating(p, ctx);
      count++;
    }
  }
  return sum;
}

export function midfieldStrength(list: Player[], club: Club, ctx: RatingContext): number {
  const pressing = Math.min(2, Math.max(0, club.tactics.pressing));
  const bonus = PRESSING_POSSESSION[pressing];
  let sum = 0;
  let count = 0;
  for (const p of list) {
    if (count < 5 && p.tacPos >= 10 && p.tacPos <= 17) {
      sum += matchRating(p, ctx);
      count++;
    }
  }
  if (count < 3) return 0.01;
  return (bonus + sum) / 5;
}

export function defenseStrength(list: Player[], ctx: RatingContext): number {
  const sum = bestN(list, 2, 9, 5, ctx);
  let count = 0;
  for (const p of list) {
    if (p.tacPos >= 2 && p.tacPos <= 9) count++;
    if (count >= 5) break;
  }
  if (count < 3) return 0.01;
  return sum / 5;
}

export function attackStrength(list: Player[], ctx: RatingContext): number {
  const sum = bestN(list, 19, 25, 3, ctx);
  let count = 0;
  for (const p of list) {
    if (p.tacPos >= 19 && p.tacPos <= 25) count++;
    if (count >= 3) break;
  }
  if (count < 1) return 0;
  return sum / 3;
}

export function gkRating(list: Player[], ctx: RatingContext): number {
  for (const p of list) {
    if (p.tacPos === 1) return matchRating(p, ctx);
  }
  return 0.1;
}

function cbCount(list: Player[]): number {
  let n = 0;
  for (const p of list) {
    if (p.tacPos >= 3 && p.tacPos <= 8) n++;
  }
  return n;
}

// c/b.java a() — possession duel divisor (year scaling, ported verbatim).
function possessionDiv(year: number): number {
  if (year >= 5) return 11;
  if (year >= 9) return 12;
  return 8;
}

// c/b.java b() — shot duel divisor.
function shotDiv(year: number): number {
  if (year >= 5) return 10;
  return 8;
}

function weightedPick(rng: RngState, weights: number[]): number {
  const total = weights.reduce((s, x) => s + x, 0);
  if (total <= 0) return 0;
  let roll = nextInt(rng, 1000000) / 1000000 * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function pickShooter(rng: RngState, list: Player[]): Player | null {
  const candidates = list.filter((p) => p.tacPos > 0 && p.tacPos !== 1 && p.position !== 0 && p.tacPos < 26);
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => {
    let w = SHOTTER_WEIGHTS[p.tacPos] ?? 1;
    if (p.characteristic1 === 9 || p.characteristic2 === 9) w += 4;
    else if (p.characteristic1 === 5 || p.characteristic2 === 5) {
      w += 2;
      if (p.position === 2) w += 2;
    }
    return w;
  });
  return candidates[weightedPick(rng, weights)];
}

function pickAssister(rng: RngState, list: Player[], shooter: Player | null, pressing: number): Player | null {
  if (nextInt(rng, 100) > 80) return null;
  const candidates = list.filter(
    (p) => p.tacPos > 0 && p.tacPos < 26 && (!shooter || p.id !== shooter.id)
  );
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => {
    let w = ASSISTER_WEIGHTS[p.tacPos] ?? 2;
    if (p.characteristic1 === 11 || p.characteristic2 === 11) {
      w += 10;
      if (p.characteristic1 === 4 || p.characteristic2 === 4) w += 5;
    } else if (p.characteristic1 === 4 || p.characteristic2 === 4) {
      w += 2;
      if (p.characteristic1 === 8) w += 2;
    } else if (p.characteristic1 === 8 || p.characteristic2 === 8) {
      w += 2;
      if (p.characteristic1 === 13) w += 2;
    } else if (p.characteristic1 === 13 || p.characteristic2 === 13) {
      w += 1;
      if (p.position === 1) w += 2;
    } else if (p.characteristic1 === 6 || p.characteristic2 === 6) {
      w += 5;
      if (p.position === 1) w += 2;
    }
    if (pressing === 1 && p.position === 1) w += 20;
    return w;
  });
  return candidates[weightedPick(rng, weights)];
}

function pickOwnGoal(rng: RngState, list: Player[]): Player | null {
  const candidates = list.filter((p) => p.tacPos >= 0 && p.tacPos < 26);
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => OWN_GOAL_WEIGHTS[p.tacPos] ?? 1);
  return candidates[weightedPick(rng, weights)];
}

type CardPicker = "yellow" | "red" | "injury";

function pickCardTarget(rng: RngState, list: Player[], picker: CardPicker): Player | null {
  let idx: number;
  if (picker === "yellow") {
    const roll = nextInt(rng, 100);
    idx = roll < 25 ? 0 : roll < 40 ? 1 : roll < 65 ? 2 : roll < 73 ? 3 : roll < 82 ? 4 : roll < 85 ? 6 : 5;
  } else if (picker === "red") {
    const roll = nextInt(rng, 200);
    idx = roll === 0 ? 6 : roll < 80 ? 0 : roll < 110 ? 1 : roll < 160 ? 2 : roll < 170 ? 3 : roll < 190 ? 4 : 5;
  } else {
    const roll = nextInt(rng, 500);
    idx = roll === 0 ? 6 : roll < 150 ? 0 : roll < 250 ? 1 : roll < 320 ? 2 : roll < 360 ? 3 : roll < 420 ? 4 : 5;
  }
  const [lo, hi] = POSITION_RANGES[idx];
  const candidates = list.filter((p) => p.tacPos >= lo && p.tacPos <= hi);
  if (candidates.length === 0) return null;
  return candidates[nextInt(rng, candidates.length)];
}

export interface MatchSetup {
  home: Club;
  away: Club;
  homeXI: Player[];
  awayXI: Player[];
  homeSubs: Player[];
  awaySubs: Player[];
}

export function setupMatch(home: Club, away: Club, allPlayers: Player[]): MatchSetup {
  const hl = lineupForMatch(home, allPlayers);
  const al = lineupForMatch(away, allPlayers);
  const empty = { starters: [], subs: [] as Player[] };
  const homeXI = hl ? hl.starters : empty.starters;
  const awayXI = al ? al.starters : empty.starters;
  const homeSubs = hl ? hl.subs : [];
  const awaySubs = al ? al.subs : [];
  return { home, away, homeXI, awayXI, homeSubs, awaySubs };
}

interface LiveRuntime {
  home: Club;
  away: Club;
  homeXI: Player[];
  awayXI: Player[];
  homeSubs: Player[];
  awaySubs: Player[];
  homeOn: Player[];
  awayOn: Player[];
  usedSubs: [number, number];
  subbedIn: [number[], number[]];
  scores: [number, number];
  possession: [number, number];
  possessionCounts: [number, number];
  shots: [number, number];
  onGoal: [number, number];
  offTarget: [number, number];
  fouls: [number, number];
  corners: [number, number];
  yellows: [number, number];
  reds: [number, number];
  tackles: [number, number];
  wrongPasses: [number, number];
  events: MatchEvent[];
  withBall: number;
  homeNeutral: boolean;
  year: number;
  ctx: RatingContext;
  playerYellows: Record<number, number>;
  subSlots: SubSlots;
}

function event(type: number, subtype: number, minute: number, half: number, clubId: number, playerId: number | null, player2Id: number | null, goalType: number): MatchEvent {
  return { minute, half, type, subtype, clubId, playerId, player2Id, goalType };
}

function bestBenchForTacPos(bench: Player[], tacPos: number, outIsGK: boolean): Player | null {
  if (outIsGK) {
    const gks = bench.filter((p) => p.position === 0).sort((a, b) => b.overall - a.overall || b.energy - a.energy);
    return gks[0] ?? null;
  }
  const base = tacPosToBasePosition(tacPos);
  const same = bench.filter((p) => p.position === base).sort((a, b) => b.overall - a.overall || b.energy - a.energy);
  if (same.length > 0) return same[0];
  const others = bench.filter((p) => p.position !== 0).sort((a, b) => b.overall - a.overall);
  return others[0] ?? null;
}

function performSub(rng: RngState, lm: LiveRuntime, side: number, sub: { out: Player; in: Player }, minute: number, half: number, positionOverride?: number) {
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const idx = on.findIndex((p) => p.id === sub.out.id);
  if (idx < 0) return;
  sub.in.tacPos = positionOverride ?? sub.out.tacPos;
  on[idx] = sub.in;
  lm.usedSubs[side]++;
  lm.subbedIn[side].push(sub.in.id);
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const bIdx = bench.findIndex((p) => p.id === sub.in.id);
  if (bIdx >= 0) bench.splice(bIdx, 1);
  const clubId = side === 0 ? lm.home.id : lm.away.id;
  lm.events.push(event(EVENT_CODES.SUB, 0, minute, half, clubId, sub.out.id, sub.in.id, 0));
}

function removeFromPitch(on: Player[], id: number) {
  const idx = on.findIndex((p) => p.id === id);
  if (idx >= 0) on.splice(idx, 1);
}

// I.java l() — fatigue every 7 minutes; GK only fatigues in the second half.
function fatigue(lm: LiveRuntime, half: number) {
  const drop = (p: Player) => {
    if (p.tacPos === 1 && half === 0) return;
    let d = 1;
    if (p.age <= 20) d = 1;
    else if (p.age <= 25) d = 2;
    else if (p.age <= 31) d = 3;
    else if (p.age <= 36) d = 4;
    else d = 5;
    p.energy = Math.max(1, p.energy - d);
  };
  for (const p of lm.homeOn) drop(p);
  for (const p of lm.awayOn) drop(p);
}

function doTacticalSub(rng: RngState, lm: LiveRuntime, side: number, outP: Player, minute: number, half: number): boolean {
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const inP = bestBenchForTacPos(bench, outP.tacPos, outP.position === 0);
  if (!inP) return false;
  performSub(rng, lm, side, { out: outP, in: inP }, minute, half);
  return true;
}

function randomOutfieldSub(rng: RngState, lm: LiveRuntime, side: number, minute: number, half: number): boolean {
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  if (on.length === 0) return false;
  let idx = nextInt(rng, on.length);
  const subbedIn = lm.subbedIn[side];
  if (subbedIn.includes(on[idx].id)) idx = nextInt(rng, on.length);
  const p = on[idx];
  if (p.tacPos !== 1 && !subbedIn.includes(p.id)) {
    return doTacticalSub(rng, lm, side, p, minute, half);
  }
  return false;
}

function tiredSub(rng: RngState, lm: LiveRuntime, side: number, minute: number, half: number): boolean {
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const threshold = minute > 40 ? 90 : 60;
  let idx = 0;
  if (minute > 40 && on.length > 0) idx = nextInt(rng, on.length);
  for (let i = idx; i < on.length; i++) {
    const p = on[i];
    if (p.tacPos !== 1 && p.energy < threshold) {
      return doTacticalSub(rng, lm, side, p, minute, half);
    }
  }
  return false;
}

// I.java m() — halftime / tactical / tired substitution slots (AI clubs only).
function maybeTacticalSub(rng: RngState, lm: LiveRuntime, minute: number) {
  let homeSubbed = false;
  if (!lm.home.isHuman && lm.usedSubs[0] < 5) {
    if (minute === 0) {
      if (lm.scores[1] - lm.scores[0] >= 1 && nextInt(rng, 100) > 50) {
        homeSubbed = randomOutfieldSub(rng, lm, 0, 0, 1);
      }
    } else if (lm.subSlots.gn[0].includes(minute)) {
      if (lm.scores[1] - lm.scores[0] >= 1 || lm.scores[0] === lm.scores[1]) {
        homeSubbed = randomOutfieldSub(rng, lm, 0, minute, 1);
      }
    } else if (lm.subSlots.gm[0].includes(minute)) {
      homeSubbed = tiredSub(rng, lm, 0, minute, 1);
    }
  }
  if (homeSubbed) return;
  if (!lm.away.isHuman && lm.usedSubs[1] < 5) {
    if (minute === 0) {
      if (lm.scores[0] - lm.scores[1] >= 2 && nextInt(rng, 100) > 50) {
        randomOutfieldSub(rng, lm, 1, 0, 1);
      }
    } else if (lm.subSlots.gn[1].includes(minute)) {
      if (lm.scores[0] - lm.scores[1] >= 1) {
        randomOutfieldSub(rng, lm, 1, minute, 1);
      }
    } else if (lm.subSlots.gm[1].includes(minute)) {
      tiredSub(rng, lm, 1, minute, 1);
    }
  }
}

// I.java o() — per-minute tired substitution chance (live matches only, AI clubs).
function maybeO(rng: RngState, lm: LiveRuntime, half: number, minute: number) {
  const n5 = minute < 10 ? 95 : minute < 30 ? 80 : minute < 40 ? 60 : 40;
  if (nextInt(rng, 100) + 1 <= n5) return;
  if (!lm.home.isHuman && lm.usedSubs[0] < 5) {
    for (const p of lm.homeOn) {
      if (p.tacPos !== 1) {
        if (p.energy < 75) {
          doTacticalSub(rng, lm, 0, p, minute, half);
          return;
        }
      } else if (half === 1 && p.energy < 40) {
        doTacticalSub(rng, lm, 0, p, minute, half);
        return;
      }
    }
  }
  if (!lm.away.isHuman && lm.usedSubs[1] < 5) {
    for (const p of lm.awayOn) {
      if (p.tacPos !== 1) {
        if (p.energy < 75) {
          doTacticalSub(rng, lm, 1, p, minute, half);
          return;
        }
      } else if (half === 1 && p.energy < 40) {
        doTacticalSub(rng, lm, 1, p, minute, half);
        return;
      }
    }
  }
}

function autoSubAfterCard(rng: RngState, lm: LiveRuntime, side: number, minute: number, half: number, sentOff: Player) {
  const club = side === 0 ? lm.home : lm.away;
  if (club.isHuman || lm.usedSubs[side] >= 5) return;
  if (sentOff.tacPos > 13) return;
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  if (on.length === 0) return;
  let outP = pickInRange(rng, on, 18, 25);
  if (!outP) outP = pickInRange(rng, on, 14, 17);
  if (!outP && sentOff.tacPos === 1) outP = pickInRange(rng, on, 2, 25);
  if (!outP) return;
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const inP = bestBenchForTacPos(bench, sentOff.tacPos, sentOff.position === 0);
  if (!inP) return;
  performSub(rng, lm, side, { out: outP, in: inP }, minute, half, sentOff.tacPos);
}

function autoSubAfterInjury(rng: RngState, lm: LiveRuntime, side: number, minute: number, half: number, injured: Player) {
  const club = side === 0 ? lm.home : lm.away;
  if (club.isHuman || lm.usedSubs[side] >= 5) return;
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const inP = bestBenchForTacPos(bench, injured.tacPos, injured.position === 0);
  if (!inP) return;
  performSub(rng, lm, side, { out: injured, in: inP }, minute, half);
}

function pickInRange(rng: RngState, list: Player[], lo: number, hi: number): Player | null {
  const candidates = list.filter((p) => p.tacPos >= lo && p.tacPos <= hi);
  if (candidates.length === 0) return null;
  return candidates[nextInt(rng, candidates.length)];
}

// I.java a(I, n2, n3) — per-minute cards / injuries / substitutions block.
function doCardOrInjury(rng: RngState, lm: LiveRuntime, half: number, minute: number) {
  const bucket = minute < 15 ? 0 : minute < 30 ? 1 : 2;
  const yellowBase = (half === 0 ? CARD_YELLOW : CARD_YELLOW_SECOND)[bucket] ?? 30;
  const redBase = (half === 0 ? CARD_RED_FIRST : CARD_RED_SECOND)[bucket] ?? 700;
  const injBase = (half === 0 ? INJURY_FIRST : INJURY_SECOND)[bucket] ?? 600;
  const side = nextInt(rng, 100) > 55 ? 0 : 1;
  const club = side === 0 ? lm.home : lm.away;
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const pressing = club.tactics.pressing >= 3 ? 0 : Math.max(0, club.tactics.pressing);
  let yellowDenom = yellowBase + CARD_YELLOW_PRESSING[Math.min(2, pressing)];
  const totalYellows = lm.yellows[0] + lm.yellows[1];
  const totalReds = lm.reds[0] + lm.reds[1];
  const totalInjuries = lm.events.filter((e) => e.type === EVENT_CODES.INJURY).length;
  if (totalYellows > 10) yellowDenom = 1000;
  else if (totalYellows > 5) yellowDenom *= 2;
  if (totalReds >= 2) yellowDenom = redBase * 2;
  if (totalInjuries >= 1) yellowDenom = injBase * 5;
  if (chanceDenom(rng, yellowDenom)) {
    const p = pickCardTarget(rng, on, "yellow");
    if (p) {
      const count = (lm.playerYellows[p.id] ?? 0) + 1;
      lm.playerYellows[p.id] = count;
      lm.fouls[side]++;
      if (count >= 2) {
        lm.reds[side]++;
        lm.events.push(event(EVENT_CODES.RED, 0, minute, half, club.id, p.id, null, 0));
        removeFromPitch(on, p.id);
        autoSubAfterCard(rng, lm, side, minute, half, p);
      } else {
        lm.yellows[side]++;
        lm.events.push(event(EVENT_CODES.YELLOW, 0, minute, half, club.id, p.id, null, 0));
      }
    }
  } else if (chanceDenom(rng, redBase)) {
    const p = pickCardTarget(rng, on, "red");
    if (p) {
      lm.reds[side]++;
      lm.fouls[side]++;
      lm.events.push(event(EVENT_CODES.RED, 0, minute, half, club.id, p.id, null, 0));
      removeFromPitch(on, p.id);
      autoSubAfterCard(rng, lm, side, minute, half, p);
    }
  } else if (chanceDenom(rng, injBase)) {
    const p = pickCardTarget(rng, on, "injury");
    if (p) {
      const days = injuryDays(rng, p);
      p.injuryDays = days;
      lm.events.push(event(EVENT_CODES.INJURY, 0, minute, half, club.id, p.id, null, days));
      if (!club.isHuman) {
        removeFromPitch(on, p.id);
        autoSubAfterInjury(rng, lm, side, minute, half, p);
      }
    }
  } else if (half === 1 && minute >= 5) {
    maybeTacticalSub(rng, lm, minute);
  }
}

// c/b.java vR() — possession duel. Returns the side that wins the minute.
function possessionDuel(rng: RngState, lm: LiveRuntime, ctx: RatingContext): number {
  const ballSide = lm.withBall;
  const offSide = 1 - ballSide;
  const ballList = ballSide === 0 ? lm.homeOn : lm.awayOn;
  const offList = offSide === 0 ? lm.homeOn : lm.awayOn;
  const mfBall = midfieldStrength(ballList, ballSide === 0 ? lm.home : lm.away, ctx);
  const mfOff = midfieldStrength(offList, offSide === 0 ? lm.home : lm.away, ctx);
  const div = possessionDiv(lm.year);
  let dBall = 1 + (mfBall - mfOff) / div;
  let dOff = 1 + (mfOff - mfBall) / div;
  if (!lm.homeNeutral && ballSide === 0) dBall += 0.3;
  if (dBall < 0.2) dBall = 0.2;
  if (dOff < 0.2) dOff = 0.2;
  const pick = weightedPick(rng, [55 * dBall, 45 * dOff]);
  return pick === 0 ? ballSide : offSide;
}

// c/b.java vS() — shot duel. 0 = attacker wins (shot), 1 = defender (tackle).
function shotDuel(rng: RngState, lm: LiveRuntime, ctx: RatingContext): number {
  const attSide = lm.withBall;
  const defSide = 1 - attSide;
  const attStr = attackStrength(attSide === 0 ? lm.homeOn : lm.awayOn, ctx);
  const defStr = defenseStrength(defSide === 0 ? lm.homeOn : lm.awayOn, ctx);
  const div = possessionDiv(lm.year);
  let dAtt = 1 + (attStr - defStr) / div;
  let dDef = 1 + (defStr - attStr) / div;
  if (defStr === 0) dDef = 0.1;
  if (!lm.homeNeutral && attSide === 0) dAtt += 0.3;
  if (attStr === 0) dAtt = 0.1;
  if (dAtt < 0.2) dAtt = 0.2;
  if (dDef < 0.2) dDef = 0.2;
  if (lm.home.isHuman || lm.away.isHuman) {
    const cbs = cbCount(defSide === 0 ? lm.homeOn : lm.awayOn);
    if (cbs === 0) dDef = 0.1;
    else if (cbs === 1) dDef = 0.05;
  }
  return weightedPick(rng, [50 * dAtt, 50 * dDef]);
}

// c/b.java vT() — shot resolution. Returns a goal event or null.
function shotResolution(rng: RngState, lm: LiveRuntime, ctx: RatingContext, half: number, minute: number): MatchEvent | null {
  const attSide = lm.withBall;
  const defSide = 1 - attSide;
  const attList = attSide === 0 ? lm.homeOn : lm.awayOn;
  const defList = defSide === 0 ? lm.homeOn : lm.awayOn;
  const shooter = pickShooter(rng, attList);
  if (!shooter) return null;
  const attStr = attackStrength(attList, ctx);
  const defStr = defenseStrength(defList, ctx);
  const gk = gkRating(defList, ctx);
  const shooterRating = matchRating(shooter, ctx);
  const div = shotDiv(lm.year);
  let d6 = 1 + (gk - shooterRating) / div;
  let d7 = 1 + (defStr - attStr) / div;
  if (lm.home.isHuman || lm.away.isHuman) {
    const cbs = cbCount(defList);
    if (cbs === 0) d6 = Math.round(d6 * 0.2);
    else if (cbs === 1) d6 = Math.round(d6 * 0.4);
  }
  if (!lm.homeNeutral) {
    if (attSide === 0) {
      d6 += 0.1;
      d7 = d6 + 0.1;
    } else {
      d6 -= 0.1;
      d7 = d6 - 0.1;
    }
  }
  let damp = GOAL_DAMPING[Math.min(6, Math.max(0, lm.scores[attSide]))] ?? GOAL_DAMPING[0];
  const defClub = defSide === 0 ? lm.home : lm.away;
  const attClub = attSide === 0 ? lm.home : lm.away;
  if (lm.scores[attSide] >= 2 && defClub.reputation - attClub.reputation >= 2) {
    damp = GOAL_DAMPING[5];
  }
  if (d6 < 0.2) d6 = 0.2;
  if (d7 < 0.2) d7 = 0.2;
  const outcome = weightedPick(rng, [damp[0], damp[1] * d6, damp[2] * d7]);
  if (outcome === 0) {
    return scoreGoal(rng, lm, ctx, half, minute, shooter, attList, defList);
  }
  if (outcome === 1) {
    lm.onGoal[attSide]++;
    return null;
  }
  lm.offTarget[attSide]++;
  return null;
}

// c/b.java a() — goal event.
function scoreGoal(rng: RngState, lm: LiveRuntime, ctx: RatingContext, half: number, minute: number, shooter: Player, attList: Player[], defList: Player[]): MatchEvent {
  const attSide = lm.withBall;
  const club = attSide === 0 ? lm.home : lm.away;
  const roll = nextInt(rng, 1000);
  let gType: number;
  if (half === 1) {
    gType = roll < 800 ? GOAL_SUBTYPES.NORMAL : roll < 850 ? GOAL_SUBTYPES.PENALTY : roll < 980 ? GOAL_SUBTYPES.FREE_KICK : roll < 990 ? GOAL_SUBTYPES.OWN_GOAL : roll < 995 ? GOAL_SUBTYPES.OLYMPIC : GOAL_SUBTYPES.NORMAL;
  } else {
    gType = roll < 900 ? GOAL_SUBTYPES.NORMAL : roll < 950 ? GOAL_SUBTYPES.PENALTY : roll < 980 ? GOAL_SUBTYPES.FREE_KICK : roll < 990 ? GOAL_SUBTYPES.OWN_GOAL : roll < 995 ? GOAL_SUBTYPES.OLYMPIC : GOAL_SUBTYPES.NORMAL;
  }
  if (gType === GOAL_SUBTYPES.OLYMPIC) {
    if (shooter.position === 0 || shooter.position === 2) {
      gType = GOAL_SUBTYPES.NORMAL;
    }
  }
  let scorer = shooter;
  let assister: Player | null = null;
  if (gType === GOAL_SUBTYPES.OWN_GOAL) {
    const own = pickOwnGoal(rng, defList);
    if (own) scorer = own;
    else gType = GOAL_SUBTYPES.NORMAL;
  } else if (gType === GOAL_SUBTYPES.PENALTY) {
    const taker = attList.find((p) => p.id === club.penaltyTakerId) ?? shooter;
    scorer = taker;
    if (lm.home.isHuman || lm.away.isHuman) {
      if (nextInt(rng, 100) >= 85) {
        const ev = event(EVENT_CODES.MISSED_PENALTY, GOAL_SUBTYPES.PENALTY, minute, half, club.id, scorer.id, null, GOAL_SUBTYPES.PENALTY);
        lm.events.push(ev);
        return ev;
      }
    }
  } else if (gType === GOAL_SUBTYPES.FREE_KICK) {
    const fkTakerId = club.savedLineup?.freeKickTakerId ?? null;
    if (fkTakerId !== null) {
      const taker = attList.find((p) => p.id === fkTakerId);
      if (taker) scorer = taker;
    }
  }
  if (gType === GOAL_SUBTYPES.NORMAL) {
    const pressing = Math.max(0, club.tactics.pressing);
    assister = pickAssister(rng, attList, scorer, pressing);
  }
  lm.scores[attSide]++;
  lm.onGoal[attSide]++;
  if (gType !== GOAL_SUBTYPES.OWN_GOAL) {
    scorer.seasonGoals++;
    scorer.careerGoals++;
  }
  if (assister) {
    assister.seasonAssists++;
    assister.careerAssists++;
  }
  const ev = event(EVENT_CODES.GOAL, gType, minute, half, club.id, scorer.id, assister?.id ?? null, gType);
  lm.events.push(ev);
  if (assister) {
    lm.events.push(event(EVENT_CODES.ASSIST, 0, minute, half, club.id, assister.id, null, 0));
  }
  return ev;
}

function updatePossession(lm: LiveRuntime) {
  const total = lm.possessionCounts[0] + lm.possessionCounts[1];
  if (total <= 0) {
    lm.possession[0] = 50;
    lm.possession[1] = 50;
    return;
  }
  const home = Math.round((lm.possessionCounts[0] / total) * 100);
  lm.possession[0] = home;
  lm.possession[1] = 100 - home;
}

function resolveMinute(rng: RngState, lm: LiveRuntime, half: number, minute: number): MatchEvent | null {
  if (minute % 7 === 0) fatigue(lm, half);
  doCardOrInjury(rng, lm, half, minute);
  if (lm.home.isHuman || lm.away.isHuman) maybeO(rng, lm, half, minute);
  const ctx = lm.ctx;
  const ballSide = lm.withBall;
  const offSide = 1 - ballSide;
  const winner = possessionDuel(rng, lm, ctx);
  lm.possessionCounts[winner]++;
  updatePossession(lm);
  let ev: MatchEvent | null = null;
  if (winner === ballSide) {
    if (shotDuel(rng, lm, ctx) === 0) {
      lm.shots[ballSide]++;
      ev = shotResolution(rng, lm, ctx, half, minute);
    } else if (nextInt(rng, 100) < 50) {
      lm.tackles[offSide]++;
    } else {
      lm.wrongPasses[ballSide]++;
    }
  } else if (nextInt(rng, 100) < 50) {
    lm.tackles[offSide]++;
  } else {
    lm.wrongPasses[ballSide]++;
  }
  lm.withBall = offSide;
  return ev;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// I.java hb() — pre-rolled substitution minute slots.
function rollSubSlots(rng: RngState): SubSlots {
  const gs = shuffle(rng, range(19, 38));
  const gt = range(5, 15);
  const gu = range(16, 35);
  const gv = range(36, 42);
  const gw = shuffle(rng, range(43, 47));
  const gn: number[][] = [[gs[0], gs[1], -1], [gs[2], gs[3], -1]];
  if (nextInt(rng, 100) > 30) gn[0][2] = gs[4];
  if (nextInt(rng, 100) > 30) gn[1][2] = gs[5];
  const n3 = nextInt(rng, 100);
  const pool = n3 > 90 ? gt : n3 > 50 ? gu : gv;
  const shuffled = shuffle(rng, pool);
  const gm: number[][] = [[shuffled[0], shuffled[1], -1, -1], [shuffled[2], shuffled[3], -1, -1]];
  if (nextInt(rng, 100) > 20) gm[0][2] = gw[0];
  if (nextInt(rng, 100) > 50) gm[0][3] = gw[1];
  if (nextInt(rng, 100) > 20) gm[1][2] = gw[2];
  if (nextInt(rng, 100) > 50) gm[1][3] = gw[3];
  return { gn, gm };
}

export interface LiveCreateOpts {
  matchId: number;
  competitionId: number;
  fixtureId: number;
  homeNeutral?: boolean;
  decider?: boolean;
  compKind?: "league" | "cup" | "state";
  year?: number;
}

export function createLiveMatchState(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: LiveCreateOpts
): LiveMatchState {
  const setup = setupMatch(home, away, allPlayers);
  const homeXI = setup.homeXI.length === 11 ? setup.homeXI : setup.homeSubs.slice(0, 11).concat(setup.homeXI).slice(0, 11);
  const awayXI = setup.awayXI.length === 11 ? setup.awayXI : setup.awaySubs.slice(0, 11).concat(setup.awayXI).slice(0, 11);
  const suspensionClears = allPlayers
    .filter((p) => (p.clubId === home.id || p.clubId === away.id) && p.suspendedGames > 0)
    .map((p) => p.id);
  return {
    matchId: opts.matchId,
    fixtureId: opts.fixtureId,
    competitionId: opts.competitionId,
    homeClubId: home.id,
    awayClubId: away.id,
    homeNeutral: opts.homeNeutral ?? false,
    decider: opts.decider ?? false,
    compKind: opts.compKind ?? "league",
    year: opts.year ?? 1,
    homeXI: homeXI.map((p) => p.id),
    awayXI: awayXI.map((p) => p.id),
    homeSubs: setup.homeSubs.map((p) => p.id),
    awaySubs: setup.awaySubs.map((p) => p.id),
    homeOn: homeXI.map((p) => p.id),
    awayOn: awayXI.map((p) => p.id),
    usedSubs: [0, 0],
    subbedIn: [[], []],
    scores: [0, 0],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
    events: [],
    half: 0,
    minute: 0,
    firstHalfLen: 45 + nextInt(rng, 3),
    secondHalfLen: 45 + nextInt(rng, 5) + 1,
    extraTimePlayed: false,
    withBall: nextInt(rng, 2),
    possessionCounts: [0, 0],
    playerYellows: {},
    subSlots: rollSubSlots(rng),
    suspensionClears,
    ended: false,
  };
}

function runtimeFromState(st: LiveMatchState, home: Club, away: Club, allPlayers: Player[]): LiveRuntime {
  const resolve = (ids: number[]) => ids.map((id) => allPlayers.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const homeXI = resolve(st.homeXI);
  const awayXI = resolve(st.awayXI);
  const ctx: RatingContext = {
    kind: st.compKind ?? "league",
    homeRep: home.reputation,
    awayRep: away.reputation,
    awayClubId: away.id,
  };
  return {
    home,
    away,
    homeXI,
    awayXI,
    homeSubs: resolve(st.homeSubs),
    awaySubs: resolve(st.awaySubs),
    homeOn: resolve(st.homeOn),
    awayOn: resolve(st.awayOn),
    usedSubs: st.usedSubs,
    subbedIn: st.subbedIn ?? [[], []],
    scores: st.scores,
    possession: st.stats.possession,
    possessionCounts: st.possessionCounts ?? [0, 0],
    shots: st.stats.shots,
    onGoal: st.stats.onGoal,
    offTarget: st.stats.offTarget,
    fouls: st.stats.fouls,
    corners: st.stats.corners,
    yellows: st.stats.yellows,
    reds: st.stats.reds,
    tackles: st.stats.tackles ?? [0, 0],
    wrongPasses: st.stats.wrongPasses ?? [0, 0],
    events: st.events,
    withBall: st.withBall,
    homeNeutral: st.homeNeutral,
    year: st.year ?? 1,
    ctx,
    playerYellows: st.playerYellows ?? {},
    subSlots: st.subSlots ?? { gn: [[-1, -1, -1], [-1, -1, -1]], gm: [[-1, -1, -1, -1], [-1, -1, -1, -1]] },
  };
}

function writeBackState(lm: LiveRuntime, st: LiveMatchState) {
  st.homeOn = lm.homeOn.map((p) => p.id);
  st.awayOn = lm.awayOn.map((p) => p.id);
  st.homeSubs = lm.homeSubs.map((p) => p.id);
  st.awaySubs = lm.awaySubs.map((p) => p.id);
  st.usedSubs = lm.usedSubs;
  st.subbedIn = lm.subbedIn;
  st.scores = lm.scores;
  st.stats.possession = lm.possession;
  st.stats.shots = lm.shots;
  st.stats.onGoal = lm.onGoal;
  st.stats.offTarget = lm.offTarget;
  st.stats.fouls = lm.fouls;
  st.stats.corners = lm.corners;
  st.stats.yellows = lm.yellows;
  st.stats.reds = lm.reds;
  st.stats.tackles = lm.tackles;
  st.stats.wrongPasses = lm.wrongPasses;
  st.events = lm.events;
  st.withBall = lm.withBall;
  st.possessionCounts = lm.possessionCounts;
  st.playerYellows = lm.playerYellows;
}

export interface LiveTickResult {
  events: MatchEvent[];
  finished: boolean;
  atHalfTime: boolean;
}

export function tickLiveMatch(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  st: LiveMatchState,
  minutes: number,
  opts?: { resume?: boolean; ignoreHalfTime?: boolean }
): LiveTickResult {
  const lm = runtimeFromState(st, home, away, allPlayers);
  return tickRuntime(rng, st, lm, minutes, opts);
}

function tickRuntime(rng: RngState, st: LiveMatchState, lm: LiveRuntime, minutes: number, opts?: { resume?: boolean; ignoreHalfTime?: boolean }): LiveTickResult {
  const newEvents: MatchEvent[] = [];
  const atHalftime = !st.ended && !st.extraTimePlayed && st.half === 1 && st.minute === 0;
  if (atHalftime && !opts?.ignoreHalfTime && !opts?.resume) {
    writeBackState(lm, st);
    return { events: [], finished: false, atHalfTime: true };
  }
  let remaining = minutes;
  let guard = 0;
  while (remaining > 0 && !st.ended && guard < 500) {
    guard++;
    const len = st.half === 0 ? st.firstHalfLen : st.secondHalfLen;
    if (st.minute >= len) {
      if (st.half === 0) {
        if (st.extraTimePlayed) {
          st.half = 1;
          st.minute = 0;
        } else {
          maybeTacticalSub(rng, lm, 0);
          st.half = 1;
          st.minute = 0;
          if (!opts?.ignoreHalfTime) {
            writeBackState(lm, st);
            return { events: newEvents, finished: false, atHalfTime: true };
          }
        }
        continue;
      }
      if (st.extraTimePlayed) {
        finishMatchState(rng, lm, st, newEvents);
      } else if (st.decider && lm.scores[0] === lm.scores[1]) {
        st.extraTimePlayed = true;
        st.half = 0;
        st.minute = 0;
        st.firstHalfLen = 15;
        st.secondHalfLen = 15;
      } else {
        finishMatchState(rng, lm, st, newEvents);
      }
      continue;
    }
    const ev = resolveMinute(rng, lm, st.half, st.minute);
    if (ev) newEvents.push(ev);
    st.minute++;
    remaining--;
  }
  writeBackState(lm, st);
  return { events: newEvents, finished: st.ended, atHalfTime: false };
}

function finishMatchState(rng: RngState, lm: LiveRuntime, st: LiveMatchState, newEvents: MatchEvent[]) {
  if (st.ended) return;
  if (st.decider && lm.scores[0] === lm.scores[1]) {
    doShootout(rng, lm, st, newEvents);
  }
  st.ended = true;
}

function doShootout(rng: RngState, lm: LiveRuntime, st: LiveMatchState, newEvents: MatchEvent[]) {
  const takers: [Player[], Player[]] = [
    lm.homeOn.filter((p) => p.position !== 0),
    lm.awayOn.filter((p) => p.position !== 0),
  ];
  const pickTaker = (side: number, kick: number): Player | null => {
    const list = takers[side];
    if (list.length === 0) return null;
    const club = side === 0 ? lm.home : lm.away;
    const preferred = list.find((p) => p.id === club.penaltyTakerId) ?? list.find((p) => p.tacPos >= 18);
    return preferred ?? list[kick % list.length];
  };
  const homeScores = [0, 0];
  const doKick = (side: number, kick: number) => {
    const taker = pickTaker(side, kick);
    if (!taker) return;
    const scored = nextInt(rng, 100) < 75;
    const club = side === 0 ? lm.home : lm.away;
    const minute = 120 + kick;
    if (scored) {
      homeScores[side]++;
      const ev = event(EVENT_CODES.GOAL, GOAL_SUBTYPES.PENALTY, minute, 2, club.id, taker.id, null, GOAL_SUBTYPES.PENALTY);
      lm.events.push(ev);
      newEvents.push(ev);
    } else {
      const ev = event(EVENT_CODES.MISSED_PENALTY, GOAL_SUBTYPES.PENALTY, minute, 2, club.id, taker.id, null, GOAL_SUBTYPES.PENALTY);
      lm.events.push(ev);
      newEvents.push(ev);
    }
  };
  let kick = 0;
  for (let round = 0; round < 5; round++) {
    doKick(0, kick);
    doKick(1, kick);
    kick++;
  }
  while (homeScores[0] === homeScores[1]) {
    doKick(0, kick);
    doKick(1, kick);
    kick++;
  }
  const winner = homeScores[0] > homeScores[1] ? lm.home.id : lm.away.id;
  st.shootout = { scores: homeScores as [number, number], winner };
}

function matchFromRuntime(st: LiveMatchState, lm: LiveRuntime, opts: { competitionId: number; fixtureId: number }): Match {
  updatePossession(lm);
  const stats: MatchStats = {
    possession: lm.possession,
    shots: lm.shots,
    onGoal: lm.onGoal,
    offTarget: lm.offTarget,
    fouls: lm.fouls,
    corners: lm.corners,
    yellows: lm.yellows,
    reds: lm.reds,
    tackles: lm.tackles,
    wrongPasses: lm.wrongPasses,
  };
  return {
    id: st.matchId,
    fixtureId: st.fixtureId,
    competitionId: st.competitionId,
    homeClubId: st.homeClubId,
    awayClubId: st.awayClubId,
    homeScore: lm.scores[0],
    awayScore: lm.scores[1],
    penaltyWinnerId: st.shootout?.winner ?? null,
    penaltyScore: st.shootout?.scores,
    attendance: 0,
    gateRevenue: 0,
    events: lm.events,
    stats,
    extraTime: st.extraTimePlayed,
    minuteEvents: [],
  };
}

export interface SimulatedMatch {
  match: Match;
  homeGoals: number;
  awayGoals: number;
}

export function simulateMatch(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  opts: { competitionId: number; fixtureId: number; homeNeutral?: boolean; decider?: boolean; compKind?: "league" | "cup" | "state"; year?: number }
): SimulatedMatch {
  const st = createLiveMatchState(rng, home, away, allPlayers, {
    matchId: opts.fixtureId,
    competitionId: opts.competitionId,
    fixtureId: opts.fixtureId,
    homeNeutral: opts.homeNeutral,
    decider: opts.decider,
    compKind: opts.compKind,
    year: opts.year,
  });
  tickLiveMatch(rng, home, away, allPlayers, st, 500, { ignoreHalfTime: true });
  const match = matchFromRuntime(st, runtimeFromState(st, home, away, allPlayers), { competitionId: opts.competitionId, fixtureId: opts.fixtureId });
  return { match, homeGoals: st.scores[0], awayGoals: st.scores[1] };
}

export interface LiveSubResult {
  event: MatchEvent | null;
  error?: string;
}

export function performLiveSub(
  rng: RngState,
  home: Club,
  away: Club,
  allPlayers: Player[],
  st: LiveMatchState,
  side: number,
  outId: number,
  inId: number
): LiveSubResult {
  if (st.ended) return { event: null, error: "Match already finished" };
  const lm = runtimeFromState(st, home, away, allPlayers);
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const out = on.find((p) => p.id === outId);
  const inPlayer = bench.find((p) => p.id === inId);
  if (!out) return { event: null, error: "Player not on the pitch" };
  if (!inPlayer) return { event: null, error: "Player not on the bench" };
  if (lm.usedSubs[side] >= 5) return { event: null, error: "No substitutions left" };
  if (out.tacPos === 1 && inPlayer.position !== 0) return { event: null, error: "Replace the goalkeeper with another goalkeeper" };
  performSub(rng, lm, side, { out, in: inPlayer }, st.minute, st.half);
  writeBackState(lm, st);
  return { event: lm.events[lm.events.length - 1] };
}

export function isPregame(st: LiveMatchState): boolean {
  return !st.ended && !st.extraTimePlayed && st.half === 0 && st.minute === 0 && st.events.length === 0;
}

export function livePhase(st: LiveMatchState): string {
  if (st.ended) return st.shootout ? "shootout" : "fulltime";
  if (isPregame(st)) return "pregame";
  if (st.extraTimePlayed) return st.half === 0 ? "et1" : "et2";
  if (st.half === 0) return "first";
  return st.minute === 0 ? "halftime" : "second";
}

export function rebuildLiveHumanLineup(st: LiveMatchState, humanClub: Club, allPlayers: Player[]): void {
  const setup = lineupForMatch(humanClub, allPlayers);
  if (!setup) return;
  const xi = setup.starters.length === 11 ? setup.starters : setup.subs.slice(0, 11).concat(setup.starters).slice(0, 11);
  const xiIds = xi.map((p) => p.id);
  const subIds = setup.subs.map((p) => p.id);
  if (st.homeClubId === humanClub.id) {
    st.homeXI = xiIds;
    st.homeOn = xiIds.slice();
    st.homeSubs = subIds;
  } else {
    st.awayXI = xiIds;
    st.awayOn = xiIds.slice();
    st.awaySubs = subIds;
  }
}

export function buildMatchFromState(st: LiveMatchState, home: Club, away: Club, allPlayers: Player[]): Match {
  return matchFromRuntime(st, runtimeFromState(st, home, away, allPlayers), { competitionId: st.competitionId, fixtureId: st.fixtureId });
}

export function tribunalSuspension(rng: RngState): number {
  const roll = nextInt(rng, 100);
  if (roll < 60) return 1;
  if (roll < 85) return 2;
  if (roll < 95) return 3;
  if (roll < 99) return 5;
  return 10;
}

export function applyMatchToPlayers(match: Match, world: World) {
  const byId = new Map(world.players.map((p) => [p.id, p]));
  for (const ev of match.events) {
    const p = ev.playerId ? byId.get(ev.playerId) : null;
    if (!p) continue;
    if (ev.type === EVENT_CODES.YELLOW) {
      p.yellows++;
      if (p.yellows >= 3) {
        p.yellows = 0;
        p.suspendedGames = Math.max(p.suspendedGames, 1);
      }
    } else if (ev.type === EVENT_CODES.RED) {
      p.reds++;
      const games = tribunalSuspension(world.rng);
      p.suspendedGames = Math.max(p.suspendedGames, games);
      const fine = Math.round(p.salary / 10);
      const club = world.clubs.find((c) => c.id === ev.clubId);
      if (club) {
        club.cash += fine;
        club.ledger.income.push({ code: 12, amount: fine, day: world.dayIndex, label: `Fine: ${p.name} (${games} game${games > 1 ? "s" : ""})` });
        const flavor = games >= 5 ? "after a violent challenge" : games >= 3 ? "for a serious foul" : "for foul play";
        world.news.push({
          dayIndex: world.dayIndex,
          text: `Tribunal suspends ${p.name} (${club.name}) for ${games} game${games > 1 ? "s" : ""} ${flavor}. The club collects a fine of ${fine}.`,
          kind: "tribunal",
          clubId: club.id,
        });
      }
      p.morale = Math.max(0, p.morale - 20);
    }
  }
}
