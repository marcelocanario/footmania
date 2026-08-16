import type { RngState, Tie } from "./types";
import { nextInt } from "./rng";

export type { Tie };

export function createKnockoutBracket(rng: RngState, teams: number[]): Tie[][] {
  const shuffled = shuffleArr(rng, teams);
  const rounds: Tie[][] = [];
  let current = shuffled;
  while (current.length > 1) {
    const round: Tie[] = [];
    for (let i = 0; i < current.length; i += 2) {
      round.push({ h: current[i], a: current[i + 1], winner: null, played: false });
    }
    rounds.push(round);
    current = new Array(Math.ceil(current.length / 2)).fill(0);
  }
  return rounds;
}

export function tieWinners(rng: RngState, tie: Tie): number | null {
  if (tie.winner !== null) return tie.winner;
  const leg1 = tie.leg1;
  const leg2 = tie.leg2;
  if (!leg1 && !leg2) return null;
  const resolvePen = (): { hs: number; as: number; winner: number } => {
    if (tie.pen) return tie.pen;
    const roll = penaltyShootout(rng);
    tie.pen = roll;
    return roll;
  };
  if (!leg2) {
    const l1 = leg1!;
    if (l1.hs > l1.as) {
      tie.winner = tie.h;
      tie.played = true;
      return tie.h;
    }
    if (l1.as > l1.hs) {
      tie.winner = tie.a;
      tie.played = true;
      return tie.a;
    }
    const pen = resolvePen();
    tie.winner = pen.winner === tie.h ? tie.h : tie.a;
    tie.played = true;
    return tie.winner;
  }
  const aggH = leg1!.hs + leg2!.as;
  const aggA = leg1!.as + leg2!.hs;
  if (aggH > aggA) {
    tie.winner = tie.h;
    tie.played = true;
    return tie.h;
  }
  if (aggA > aggH) {
    tie.winner = tie.a;
    tie.played = true;
    return tie.a;
  }
  const awayH = leg2!.hs;
  const awayA = leg1!.as;
  if (awayH > awayA) {
    tie.winner = tie.h;
    tie.played = true;
    return tie.h;
  }
  if (awayA > awayH) {
    tie.winner = tie.a;
    tie.played = true;
    return tie.a;
  }
  const pen = resolvePen();
  tie.winner = pen.winner === tie.h ? tie.h : tie.a;
  tie.played = true;
  return tie.winner;
}

export function penaltyShootout(rng: RngState): { hs: number; as: number; winner: number } {
  let hs = 0;
  let as = 0;
  for (let i = 0; i < 5; i++) {
    if (nextInt(rng, 100) < 75) hs++;
    if (nextInt(rng, 100) < 75) as++;
  }
  let winner = hs > as ? 0 : 1;
  if (hs === as) {
    while (true) {
      const h = nextInt(rng, 100) < 75;
      const a = nextInt(rng, 100) < 75;
      if (h && !a) {
        winner = 0;
        break;
      }
      if (!h && a) {
        winner = 1;
        break;
      }
    }
  }
  return { hs, as, winner };
}

function shuffleArr<T>(rng: RngState, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
