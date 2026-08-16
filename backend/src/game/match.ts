import type { Club, LiveMatchState, Match, MatchEvent, MatchStats, Player, RngState } from "./types";
import { chanceDenom, nextInt } from "./rng";
import { lineupForMatch } from "./club";
import {
  CARD_RED_FIRST,
  CARD_RED_SECOND,
  CARD_YELLOW,
  EVENT_CODES,
  GOAL_DAMPING,
  GOAL_SUBTYPES,
  INJURY_FIRST,
  INJURY_SECOND,
  SHOTTER_WEIGHTS,
  TACTIC_STYLE_POSSESSION,
} from "./constants";
import { injuryDays } from "./player";

const SHOOTER_WEIGHT: Record<number, number> = SHOTTER_WEIGHTS;

const ASSISTER_WEIGHT: Record<number, number> = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1,
  10: 10, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 10,
  18: 10, 19: 10, 20: 10, 21: 10, 22: 10, 23: 10, 24: 10, 25: 10,
};

export interface LineupCache {
  home: Player[];
  away: Player[];
  homeSubs: Player[];
  awaySubs: Player[];
}

export function ratingOf(p: Player): number {
  if (p.injuryDays > 0) return 1;
  return Math.max(1, p.overall);
}

function bestN(list: Player[], predicate: (p: Player) => boolean, n: number): number {
  const scores = list
    .filter((p) => p.tacPos >= 0 && predicate(p))
    .map((p) => ratingOf(p))
    .sort((a, b) => b - a);
  if (scores.length === 0) return 0;
  return scores.slice(0, n).reduce((s, x) => s + x, 0) / Math.min(n, scores.length);
}

function midfieldStrength(list: Player[], club: Club): number {
  let sum = 0;
  let count = 0;
  for (const p of list) {
    if (count < 5 && p.tacPos >= 10 && p.tacPos <= 17) {
      sum += ratingOf(p);
      count++;
    }
  }
  const style = TACTIC_STYLE_POSSESSION[Math.min(2, club.tactics.style)] ?? 0;
  if (count < 3) return style / 10 + 0.01;
  return sum / 5 / 10 + style;
}

function defenseStrength(list: Player[]): number {
  let sum = 0;
  let count = 0;
  for (const p of list) {
    if (count < 5 && p.tacPos >= 2 && p.tacPos <= 9) {
      sum += ratingOf(p);
      count++;
    }
  }
  if (count < 3) return 0.01;
  return sum / 5 / 10;
}

function attackStrength(list: Player[]): number {
  let sum = 0;
  let count = 0;
  for (const p of list) {
    if (count < 3 && p.tacPos >= 19 && p.tacPos <= 25) {
      sum += ratingOf(p);
      count++;
    }
  }
  if (count < 1) return 0;
  return sum / 3 / 10;
}

function gkRating(list: Player[]): number {
  for (const p of list) {
    if (p.tacPos === 1) return ratingOf(p) / 10;
  }
  return 0.1;
}

function attackModifier(a: number, b: number): number {
  let n = 8;
  return (a - b) / n;
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
  const candidates = list.filter((p) => p.tacPos > 0 && p.position !== 0 && p.tacPos < 26);
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => {
    let w = SHOOTER_WEIGHT[p.tacPos] ?? 1;
    if (p.characteristic1 === 9 || p.characteristic2 === 9) w += 4;
    else if (p.characteristic1 === 5 || p.characteristic2 === 5) {
      w += 2;
      if (p.position === 2) w += 2;
    }
    return w;
  });
  return candidates[weightedPick(rng, weights)];
}

function pickAssister(rng: RngState, list: Player[], shooter: Player | null): Player | null {
  if (nextInt(rng, 100) > 80) return null;
  const candidates = list.filter(
    (p) => p.tacPos > 0 && p.tacPos < 26 && (!shooter || p.id !== shooter.id)
  );
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => {
    let w = ASSISTER_WEIGHT[p.tacPos] ?? 2;
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
    return w;
  });
  return candidates[weightedPick(rng, weights)];
}

function pickOpponent(rng: RngState, list: Player[]): Player | null {
  const candidates = list.filter((p) => p.tacPos >= 0 && p.tacPos < 26);
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => 1);
  return candidates[weightedPick(rng, weights)];
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
  scores: [number, number];
  possession: [number, number];
  shots: [number, number];
  onGoal: [number, number];
  offTarget: [number, number];
  fouls: [number, number];
  corners: [number, number];
  yellows: [number, number];
  reds: [number, number];
  events: MatchEvent[];
  minuteEvents: MatchEvent[][];
  withBall: number;
  homeNeutral: boolean;
}

function event(type: number, subtype: number, minute: number, half: number, clubId: number, playerId: number | null, player2Id: number | null, goalType: number): MatchEvent {
  return { minute, half, type, subtype, clubId, playerId, player2Id, goalType };
}

function pickSubTarget(rng: RngState, on: Player[], bench: Player[]): { out: Player; in: Player } | null {
  const tired = on.filter((p) => p.tacPos !== 1 && p.energy < 40).sort((a, b) => a.energy - b.energy);
  if (tired.length === 0) return null;
  const out = tired[0];
  const candidates = bench.filter((p) => p.injuryDays === 0 && !p.suspended);
  if (candidates.length === 0) return null;
  const byPos = candidates
    .map((p) => ({ p, score: p.position === out.position ? 2 : p.position === 4 && out.position === 4 ? 2 : 1 }))
    .sort((a, b) => b.score - a.score || b.p.overall - a.p.overall);
  return { out, in: byPos[0].p };
}

function doCardOrInjury(rng: RngState, lm: LiveRuntime, half: number, minute: number) {
  const bucket = minute < 15 ? 0 : minute < 30 ? 1 : 2;
  const yellowBase = CARD_YELLOW[bucket] ?? 30;
  const redBase = (half === 0 ? CARD_RED_FIRST : CARD_RED_SECOND)[bucket] ?? 700;
  const injBase = (half === 0 ? INJURY_FIRST : INJURY_SECOND)[bucket] ?? 600;
  const side = nextInt(rng, 100) > 55 ? 0 : 1;
  const club = side === 0 ? lm.home : lm.away;
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const pressing = club.tactics.pressing >= 2 ? 0 : club.tactics.pressing;
  let yellowDenom = yellowBase + (pressing === 0 ? 30 : 10);
  const totalYellows = lm.yellows[0] + lm.yellows[1];
  const totalReds = lm.reds[0] + lm.reds[1];
  const totalInjuries = lm.events.filter((e) => e.type === EVENT_CODES.INJURY).length;
  if (totalYellows > 5) yellowDenom *= 2;
  else if (totalYellows > 10) yellowDenom = 1000;
  if (totalReds >= 2) yellowDenom = redBase * 2;
  if (totalInjuries >= 1) yellowDenom = injBase * 5;
  if (chanceDenom(rng, yellowDenom)) {
    const p = pickOpponent(rng, on);
    if (p) {
      lm.yellows[side]++;
      lm.events.push(event(EVENT_CODES.YELLOW, 0, minute, half, club.id, p.id, null, 0));
    }
  } else if (chanceDenom(rng, redBase)) {
    const p = pickOpponent(rng, on);
    if (p) {
      lm.reds[side]++;
      lm.events.push(event(EVENT_CODES.RED, 0, minute, half, club.id, p.id, null, 0));
      removeFromPitch(on, p.id);
    }
  } else if (chanceDenom(rng, injBase)) {
    const p = pickOpponent(rng, on);
    if (p) {
      const days = injuryDays(rng, p);
      lm.events.push(event(EVENT_CODES.INJURY, 0, minute, half, club.id, p.id, null, days));
      if (lm.usedSubs[side] < 5) {
        const sub = pickSubTarget(rng, on, bench);
        if (sub && sub.out.id === p.id) {
          performSub(rng, lm, side, sub, minute, half);
        }
      }
    }
  } else if (half === 1 && minute >= 5 && nextInt(rng, 100) < 30) {
    if (lm.usedSubs[side] < 5 && !club.isHuman) {
      const sub = pickSubTarget(rng, on, bench);
      if (sub) {
        performSub(rng, lm, side, sub, minute, half);
      }
    }
  }
}

function removeFromPitch(on: Player[], id: number) {
  const idx = on.findIndex((p) => p.id === id);
  if (idx >= 0) on.splice(idx, 1);
}

function performSub(rng: RngState, lm: LiveRuntime, side: number, sub: { out: Player; in: Player }, minute: number, half: number) {
  const on = side === 0 ? lm.homeOn : lm.awayOn;
  const idx = on.findIndex((p) => p.id === sub.out.id);
  if (idx < 0) return;
  sub.in.tacPos = sub.out.tacPos;
  on[idx] = sub.in;
  lm.usedSubs[side]++;
  const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
  const bIdx = bench.findIndex((p) => p.id === sub.in.id);
  if (bIdx >= 0) bench.splice(bIdx, 1);
  const clubId = side === 0 ? lm.home.id : lm.away.id;
  lm.events.push(event(EVENT_CODES.SUB, 0, minute, half, clubId, sub.out.id, sub.in.id, 0));
}

function fatigue(lm: LiveRuntime, half: number, minute: number) {
  const drop = (p: Player, side: number) => {
    if (p.tacPos === 1) return;
    if (p.age <= 20) p.energy -= 1;
    else if (p.age <= 25) p.energy -= 2;
    else if (p.age <= 31) p.energy -= 3;
    else if (p.age <= 36) p.energy -= 4;
    else p.energy -= 5;
    if (p.energy < 1) p.energy = 1;
  };
  for (const p of lm.homeOn) drop(p, 0);
  for (const p of lm.awayOn) drop(p, 1);
}

function resolveMinute(rng: RngState, lm: LiveRuntime, half: number, minute: number): MatchEvent | null {
  if (minute % 7 === 0) fatigue(lm, half, minute);
  doCardOrInjury(rng, lm, half, minute);
  const withBall = lm.withBall;
  const offBall = withBall === 0 ? 1 : 0;
  const homeSide = withBall === 0;
  const ballStr = homeSide ? lm.homeXI : lm.awayXI;
  const ballClub = homeSide ? lm.home : lm.away;
  const offStr = offBall === 0 ? lm.homeXI : lm.awayXI;

  const mfHome = midfieldStrength(ballStr, ballClub);
  const mfAway = midfieldStrength(offStr, offBall === 0 ? lm.home : lm.away);
  let wHome = 1 + (mfHome - mfAway) / 8;
  let wAway = 1 + (mfAway - mfHome) / 8;
  if (homeSide && !lm.homeNeutral) wHome += 0.3;
  if (wHome < 0.2) wHome = 0.2;
  if (wAway < 0.2) wAway = 0.2;
  const keepBall = weightedPick(rng, homeSide ? [wHome, wAway] : [wAway, wHome]) === 0;

  if (keepBall) {
    const attHome = attackStrength(ballStr);
    const defAway = defenseStrength(offStr);
    let shotW = 1 + (attHome - defAway) / 8;
    let saveW = 1 + (defAway - attHome) / 8;
    if (homeSide && !lm.homeNeutral) shotW += 0.3;
    if (shotW === 0) shotW = 0.1;
    if (saveW === 0) saveW = 0.1;
    if (shotW < 0.2) shotW = 0.2;
    if (saveW < 0.2) saveW = 0.2;
    const isShot = weightedPick(rng, [shotW, saveW]) === 0;
    if (isShot) {
      lm.shots[withBall]++;
      return resolveShot(rng, lm, withBall, half, minute);
    }
  } else {
    lm.fouls[withBall]++;
    lm.withBall = offBall;
  }
  return null;
}

function resolveShot(rng: RngState, lm: LiveRuntime, attackingSide: number, half: number, minute: number): MatchEvent | null {
  const defendingSide = attackingSide === 0 ? 1 : 0;
  const attList = attackingSide === 0 ? lm.homeOn : lm.awayOn;
  const defList = defendingSide === 0 ? lm.homeOn : lm.awayOn;
  const shooter = pickShooter(rng, attList);
  if (!shooter) return null;
  const shooterRating = ratingOf(shooter) / 10;
  const gk = gkRating(defList);
  const attack = attackStrength(attList);
  const def = defenseStrength(defList);
  const homeAttacking = attackingSide === 0;
  let d6 = 1 + (gk - shooterRating) / 8;
  let d7 = 1 + (def - attack) / 8;
  if (homeAttacking && !lm.homeNeutral) d6 += 0.1;
  if (d6 < 0.2) d6 = 0.2;
  if (d7 < 0.2) d7 = 0.2;
  let damp = GOAL_DAMPING[Math.min(6, Math.max(0, lm.scores[attackingSide]))] ?? GOAL_DAMPING[0];
  const defClub = defendingSide === 0 ? lm.home : lm.away;
  const attClub = attackingSide === 0 ? lm.home : lm.away;
  if (lm.scores[attackingSide] >= 2 && defClub.reputation - attClub.reputation >= 2) {
    damp = GOAL_DAMPING[5];
  }
  const goalW = damp[0];
  const saveW = damp[1];
  const offW = damp[2];
  const weights = [goalW * 1, saveW * d6, offW * d7];
  const outcome = weightedPick(rng, weights);
  if (outcome === 0) {
    return scoreGoal(rng, lm, attackingSide, half, minute, shooter, attList, defList);
  } else if (outcome === 1) {
    lm.onGoal[attackingSide]++;
    return null;
  }
  lm.offTarget[attackingSide]++;
  return null;
}

function scoreGoal(rng: RngState, lm: LiveRuntime, attackingSide: number, half: number, minute: number, shooter: Player, attList: Player[], defList: Player[]): MatchEvent {
  lm.scores[attackingSide]++;
  lm.onGoal[attackingSide]++;
  const club = attackingSide === 0 ? lm.home : lm.away;
  let goalType = nextInt(rng, 1000);
  let gType = GOAL_SUBTYPES.NORMAL;
  if (goalType < 900) gType = GOAL_SUBTYPES.NORMAL;
  else if (goalType < 950) gType = GOAL_SUBTYPES.PENALTY;
  else if (goalType < 980) gType = GOAL_SUBTYPES.FREE_KICK;
  else if (goalType < 990) gType = GOAL_SUBTYPES.OWN_GOAL;
  else if (goalType < 995) gType = GOAL_SUBTYPES.OLYMPIC;
  else gType = GOAL_SUBTYPES.NORMAL;
  if (gType === GOAL_SUBTYPES.OLYMPIC && (shooter.position === 0 || shooter.position === 2)) {
    gType = GOAL_SUBTYPES.NORMAL;
  }
  let scorer = shooter;
  let assister: Player | null = null;
  if (gType === GOAL_SUBTYPES.OWN_GOAL) {
    const own = pickOpponent(rng, defList);
    if (own) scorer = own;
    else gType = GOAL_SUBTYPES.NORMAL;
  } else if (gType === GOAL_SUBTYPES.PENALTY) {
    const clubObj = attackingSide === 0 ? lm.home : lm.away;
    const penTaker = attList.find((p) => p.id === clubObj.penaltyTakerId) ?? shooter;
    scorer = penTaker;
    const missed = nextInt(rng, 100) < 15;
    if (missed) {
      lm.events.push(event(EVENT_CODES.MISSED_PENALTY, GOAL_SUBTYPES.PENALTY, minute, half, club.id, scorer.id, null, GOAL_SUBTYPES.PENALTY));
      return event(EVENT_CODES.MISSED_PENALTY, GOAL_SUBTYPES.PENALTY, minute, half, club.id, scorer.id, null, GOAL_SUBTYPES.PENALTY);
    }
  }
  if (gType !== GOAL_SUBTYPES.OWN_GOAL && gType !== GOAL_SUBTYPES.PENALTY) {
    assister = pickAssister(rng, attList, shooter);
  }
  scorer.seasonGoals++;
  scorer.careerGoals++;
  if (assister) {
    assister.seasonAssists++;
    assister.careerAssists++;
  }
  const ev = event(EVENT_CODES.GOAL, gType, minute, half, club.id, scorer.id, assister?.id ?? null, gType);
  lm.events.push(ev);
  if (assister) {
    lm.events.push(event(EVENT_CODES.GOAL + 7, 0, minute, half, club.id, assister.id, null, 0));
  }
  return ev;
}

export interface LiveCreateOpts {
  matchId: number;
  competitionId: number;
  fixtureId: number;
  homeNeutral?: boolean;
  decider?: boolean;
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
    .filter((p) => (p.clubId === home.id || p.clubId === away.id) && p.suspended)
    .map((p) => p.id);
  return {
    matchId: opts.matchId,
    fixtureId: opts.fixtureId,
    competitionId: opts.competitionId,
    homeClubId: home.id,
    awayClubId: away.id,
    homeNeutral: opts.homeNeutral ?? false,
    decider: opts.decider ?? false,
    homeXI: homeXI.map((p) => p.id),
    awayXI: awayXI.map((p) => p.id),
    homeSubs: setup.homeSubs.map((p) => p.id),
    awaySubs: setup.awaySubs.map((p) => p.id),
    homeOn: homeXI.map((p) => p.id),
    awayOn: awayXI.map((p) => p.id),
    usedSubs: [0, 0],
    scores: [0, 0],
    stats: { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0] },
    events: [],
    half: 0,
    minute: 0,
    firstHalfLen: 45 + nextInt(rng, 3),
    secondHalfLen: 45 + nextInt(rng, 5) + 1,
    extraTimePlayed: false,
    withBall: nextInt(rng, 2),
    suspensionClears,
    ended: false,
  };
}

function runtimeFromState(st: LiveMatchState, home: Club, away: Club, allPlayers: Player[]): LiveRuntime {
  const resolve = (ids: number[]) => ids.map((id) => allPlayers.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const homeXI = resolve(st.homeXI);
  const awayXI = resolve(st.awayXI);
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
    scores: st.scores,
    possession: st.stats.possession,
    shots: st.stats.shots,
    onGoal: st.stats.onGoal,
    offTarget: st.stats.offTarget,
    fouls: st.stats.fouls,
    corners: st.stats.corners,
    yellows: st.stats.yellows,
    reds: st.stats.reds,
    events: st.events,
    minuteEvents: [],
    withBall: st.withBall,
    homeNeutral: st.homeNeutral,
  };
}

function writeBackState(lm: LiveRuntime, st: LiveMatchState) {
  st.homeOn = lm.homeOn.map((p) => p.id);
  st.awayOn = lm.awayOn.map((p) => p.id);
  st.homeSubs = lm.homeSubs.map((p) => p.id);
  st.awaySubs = lm.awaySubs.map((p) => p.id);
  st.usedSubs = lm.usedSubs;
  st.scores = lm.scores;
  st.stats.possession = lm.possession;
  st.stats.shots = lm.shots;
  st.stats.onGoal = lm.onGoal;
  st.stats.offTarget = lm.offTarget;
  st.stats.fouls = lm.fouls;
  st.stats.corners = lm.corners;
  st.stats.yellows = lm.yellows;
  st.stats.reds = lm.reds;
  st.events = lm.events;
  st.withBall = lm.withBall;
}

function maybeSubHalfTime(rng: RngState, lm: LiveRuntime, minute = 46, half = 1) {
  for (let side = 0; side < 2; side++) {
    if (lm.usedSubs[side] >= 5) continue;
    const club = side === 0 ? lm.home : lm.away;
    if (club.isHuman) continue;
    const on = side === 0 ? lm.homeOn : lm.awayOn;
    const bench = side === 0 ? lm.homeSubs : lm.awaySubs;
    if (nextInt(rng, 100) < 30) {
      const sub = pickSubTarget(rng, on, bench);
      if (sub) performSub(rng, lm, side, sub, minute, half);
    }
  }
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
          maybeSubHalfTime(rng, lm);
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
  const possessionHome = lm.shots[0] + lm.shots[1] === 0 ? 50 : Math.round((lm.shots[0] / (lm.shots[0] + lm.shots[1])) * 100);
  lm.possession = [possessionHome, 100 - possessionHome];
  const stats: MatchStats = {
    possession: lm.possession,
    shots: lm.shots,
    onGoal: lm.onGoal,
    offTarget: lm.offTarget,
    fouls: lm.fouls,
    corners: lm.corners,
    yellows: lm.yellows,
    reds: lm.reds,
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
  opts: { competitionId: number; fixtureId: number; homeNeutral?: boolean; decider?: boolean }
): SimulatedMatch {
  const st = createLiveMatchState(rng, home, away, allPlayers, {
    matchId: opts.fixtureId,
    competitionId: opts.competitionId,
    fixtureId: opts.fixtureId,
    homeNeutral: opts.homeNeutral,
    decider: opts.decider,
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

export function applyMatchToPlayers(match: Match, players: Player[]) {
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const ev of match.events) {
    if (ev.type === EVENT_CODES.YELLOW) {
      const p = ev.playerId ? byId.get(ev.playerId) : null;
      if (p) {
        p.yellows++;
        if (p.yellows >= 3) {
          p.yellows = 0;
          p.suspended = true;
        }
      }
    } else if (ev.type === EVENT_CODES.RED) {
      const p = ev.playerId ? byId.get(ev.playerId) : null;
      if (p) {
        p.reds++;
        p.suspended = true;
      }
    }
  }
}
