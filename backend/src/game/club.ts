import type { Club, Player, RngState } from "./types";
import { nextInt, shuffle } from "./rng";
import { tacticalSkillRating } from "./rating";
import { energyLoss, loadIncrement, physicalSkill, readiness, recoverEnergy } from "./energyInjury";
import { gameConfig } from "../config";
import {
  BENCH_ORDER,
  FORMATION_POSITIONS,
  SENIOR_SQUAD_LIMIT,
} from "./constants";

export function tacticsForClub(rng: RngState): Club["tactics"] {
  const roll = nextInt(rng, 100);
  let formation = 4;
  if (roll <= 2) formation = 0;
  else if (roll <= 4) formation = 1;
  else if (roll <= 7) formation = 2;
  else if (roll <= 38) formation = 3;
  else if (roll <= 49) formation = 4;
  else if (roll <= 60) formation = 5;
  else if (roll <= 65) formation = 6;
  else if (roll <= 72) formation = 7;
  else if (roll <= 90) formation = 8;
  else if (roll <= 92) formation = 9;
  else if (roll <= 101) formation = 10;
  const style = nextInt(rng, 100);
  const direction = nextInt(rng, 100);
  return {
    formation,
    style: style <= 5 ? 2 : style <= 70 ? 0 : 1,
    pressing: nextInt(rng, 100) <= 70 ? 0 : 1,
    direction: direction <= 70 ? 0 : 1,
  };
}

export function eligible(players: Player[]): Player[] {
  return players.filter((p) => !p.clubId || p.injuryDays === 0);
}

/** AI selection context: rotation projection inputs (plan 9 §21). */
interface AiSelectionOptions {
  /** Team pressing on the engine's 0–100 scale. */
  pressing: number;
  /** Whether another league fixture follows in the current season (§21.4). */
  futureFixtures: boolean;
}

const DEFAULT_AI_SELECTION: AiSelectionOptions = { pressing: 50, futureFixtures: true };

export function pickForTacPos(players: Player[], tacPos: number, excluded: Set<number>, sideVariant: boolean, aiOptions: AiSelectionOptions = DEFAULT_AI_SELECTION): Player | null {
  const position = tacPosToBasePosition(tacPos);
  const candidates = players.filter(
    (p) => p.injuryDays === 0 && p.suspendedGames === 0 && p.position === position && !excluded.has(p.id) && !(tacPos === 1 && p.position !== 0)
  );
  if (candidates.length === 0) return null;
  const useFutureCost = aiOptions.futureFixtures;
  if (sideVariant) {
    const bySide = candidates.filter((p) => p.tacPos >= 0);
    const pool = bySide.length > 0 ? bySide : candidates;
    const sorted = [...pool].sort((a, b) => {
      const tacticalDifference = selectionValue(b, tacPos, aiOptions) - selectionValue(a, tacPos, aiOptions);
      if (tacticalDifference !== 0) return tacticalDifference;
      if (a.overall !== b.overall) return b.overall - a.overall;
      return b.energy - a.energy;
    });
    return sorted[0];
  }
  const sorted = [...candidates].sort((a, b) => {
    const tacticalDifference = selectionValue(b, tacPos, aiOptions) - selectionValue(a, tacPos, aiOptions);
    return tacticalDifference || b.overall - a.overall || b.energy - a.energy;
  });
  return sorted[0];
}

function selectionValue(player: Player, tacPos: number, aiOptions: AiSelectionOptions): number {
  return aiOptions.futureFixtures ? aiSelectionValue(player, tacPos, aiOptions.pressing) : tacticalSkillRating(player.skills, tacPos);
}

export function tacPosToBasePosition(tacPos: number): number {
  if (tacPos === 0 || tacPos === 1) return 0;
  if (tacPos === 2 || tacPos === 9 || tacPos === 10 || tacPos === 17) return 1;
  if (tacPos >= 3 && tacPos <= 8) return 2;
  if (tacPos >= 11 && tacPos <= 16) return 3;
  return 4;
}

export interface Lineup {
  starters: Player[];
  subs: Player[];
  formation: number;
  positions: number[];
}

export function peekLineup(club: Club, allPlayers: Player[]): Lineup | null {
  const saved = club.savedLineup;
  if (saved && saved.starters.length === 11) {
    const formation = FORMATION_POSITIONS[club.tactics.formation] ?? FORMATION_POSITIONS[4];
    const rosterIds = new Set(allPlayers.filter((p) => p.clubId === club.id).map((p) => p.id));
    const starters = saved.starters
      .map((id) => allPlayers.find((p) => p.id === id))
      .filter((p): p is Player => !!p && rosterIds.has(p.id) && p.injuryDays === 0 && p.suspendedGames === 0);
    if (starters.length === 11) {
      const seen = new Set(starters.map((p) => p.id));
      const subs = saved.subs
        .map((id) => allPlayers.find((p) => p.id === id))
        .filter((p): p is Player => !!p && !seen.has(p.id) && rosterIds.has(p.id) && p.injuryDays === 0 && p.suspendedGames === 0);
      return { starters, subs, formation: club.tactics.formation, positions: formation };
    }
  }
  const lineup = buildLineup(club, allPlayers);
  if (!lineup) return null;
  return {
    starters: lineup.starters,
    subs: lineup.subs,
    formation: lineup.formation,
    positions: lineup.positions,
  };
}

// Match-squad eligibility policy: youth players are eligible for senior match
// squads (worldgen guarantees every club can field 11 only when youth may
// fill gaps). All lineup paths must agree (buildLineup, lineupValid,
// applySavedLineup, /club/lineup picker): benched youth are eligible
// 0-minute squad members for activity tracking (spec section 15).
export function buildLineup(club: Club, allPlayers: Player[], options: { futureFixtures?: boolean } = {}): Lineup | null {
  const roster = allPlayers.filter((p) => p.clubId === club.id && !p.onSale);
  for (const player of allPlayers) {
    if (player.clubId === club.id) player.starter = false;
  }
  const available = roster.filter((p) => p.injuryDays === 0 && p.suspendedGames === 0);
  const formation = FORMATION_POSITIONS[club.tactics.formation] ?? FORMATION_POSITIONS[4];
  const excluded = new Set<number>();
  const starters: Player[] = [];
  // AI rotation pressure uses the team's actual pressing and whether another
  // league fixture follows this season; humans pick their own lineups.
  const aiOptions: AiSelectionOptions | null = club.isHuman
    ? null
    : {
        pressing: enginePressingScale(club.tactics.pressing),
        futureFixtures: options.futureFixtures ?? true,
      };
  for (const tacPos of formation) {
    // A randomly assigned formation can ask for more players in a position
    // than a generated squad has. Fill the tactical slot from the best
    // remaining eligible player rather than returning an empty match lineup.
    const p = pickForTacPos(available, tacPos, excluded, true, aiOptions ?? undefined) ?? pickFallbackForTacPos(available, tacPos, excluded, aiOptions ?? undefined);
    if (p) {
      p.tacPos = tacPos;
      p.starter = true;
      excluded.add(p.id);
      starters.push(p);
    }
  }
  const subs: Player[] = [];
  const benchPool = available.filter((p) => !excluded.has(p.id)).sort((a, b) => b.overall - a.overall);
  for (const slot of BENCH_ORDER) {
    const p = pickForTacPos(benchPool, slot, excluded, true, aiOptions ?? undefined);
    if (p) {
      p.tacPos = slot;
      p.starter = false;
      excluded.add(p.id);
      subs.push(p);
    }
  }
  if (starters.length < 11) return null;
  return { starters, subs, formation: club.tactics.formation, positions: formation };
}

/**
 * Club.tactics.pressing is a 0–2 scale (Light/Heavy/Very Heavy); the Energy
 * model expects the engine's 0–100 scale (same mapping as `enginePressing`).
 */
function enginePressingScale(pressing: number): number {
  return Math.max(0, Math.min(2, pressing)) / 2 * 100;
}

/** Current effectiveness minus the deterministic next-match cost of overplaying. */
export function aiSelectionValue(player: Player, tacPos: number, pressing = 50): number {
  const base = tacticalSkillRating(player.skills, tacPos);
  const current = base * readiness(player.energy);
  const spacing = gameConfig.matchSpacingDays;
  const project = (played: boolean): number => {
    let energy = player.energy;
    let load = player.recentLoad ?? 0;
    if (played) {
      energy = Math.max(0, energy - energyLoss({ energy, age: player.age, physicalSkill: physicalSkill(player), position: player.position, pressing, involvement: 0.5, minutes: 90 }));
      load = Math.min(6, load + loadIncrement({ position: player.position, pressing, involvement: 0.5, minutes: 90 }));
    }
    for (let day = 0; day < spacing; day++) {
      load *= Math.pow(2, -1 / spacing);
      energy = recoverEnergy({ ...player, energy, recentLoad: load }, load, spacing);
    }
    return energy;
  };
  const playedNext = project(true);
  const restedNext = project(false);
  // Fixed Version 1 decision-horizon coefficient from plan 9 §21.4.
  const futureCost = base * (readiness(restedNext) - readiness(playedNext));
  return current - 0.45 * futureCost;
}

function pickFallbackForTacPos(players: Player[], tacPos: number, excluded: Set<number>, aiOptions: AiSelectionOptions = DEFAULT_AI_SELECTION): Player | null {
  return players
    .filter((p) => p.injuryDays === 0 && p.suspendedGames === 0 && !excluded.has(p.id))
    .sort((a, b) => selectionValue(b, tacPos, aiOptions) - selectionValue(a, tacPos, aiOptions) || b.overall - a.overall || b.energy - a.energy)[0] ?? null;
}

export interface SavedLineupInput {
  formation: number;
  starters: number[];
  subs: number[];
  penaltyTakerId: number | null;
  freeKickTakerId: number | null;
}

export function applySavedLineup(club: Club, allPlayers: Player[], input: SavedLineupInput): string | null {
  // Youth are squad-eligible (see buildLineup policy note) and may be saved.
  const roster = allPlayers.filter((p) => p.clubId === club.id);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const all = [...input.starters, ...input.subs];
  const seen = new Set<number>();
  for (const id of all) {
    const p = byId.get(id);
    if (!p) return "Lineup contains a player not in the squad";
    if (p.injuryDays > 0 || p.suspendedGames > 0 || p.onSale) {
      return `${p.name} is not available (injured, suspended or on sale)`;
    }
    if (seen.has(id)) return "A player appears twice in the lineup";
    seen.add(id);
  }
  if (input.penaltyTakerId !== null && !input.starters.includes(input.penaltyTakerId)) {
    return "Penalty taker must be in the starting eleven";
  }
  if (input.freeKickTakerId !== null && !input.starters.includes(input.freeKickTakerId)) {
    return "Free kick taker must be in the starting eleven";
  }
  club.tactics.formation = input.formation;
  club.penaltyTakerId = input.penaltyTakerId;
  club.savedLineup = { starters: input.starters, subs: input.subs, freeKickTakerId: input.freeKickTakerId };
  return null;
}

function byId(allPlayers: Player[], id: number): Player | null {
  return allPlayers.find((p) => p.id === id) ?? null;
}

function lineupValid(club: Club, saved: NonNullable<Club["savedLineup"]>, allPlayers: Player[]): boolean {
  if (!saved.starters || saved.starters.length !== 11) return false;
  const rosterIds = new Set(allPlayers.filter((p) => p.clubId === club.id).map((p) => p.id));
  const seen = new Set<number>();
  for (const id of saved.starters) {
    const p = byId(allPlayers, id);
    if (!p || !rosterIds.has(id) || seen.has(id)) return false;
    if (p.injuryDays > 0 || p.suspendedGames > 0 || p.onSale) return false;
    seen.add(id);
  }
  for (const id of saved.subs) {
    if (seen.has(id) || !rosterIds.has(id)) return false;
    const p = byId(allPlayers, id);
    if (!p || p.injuryDays > 0 || p.suspendedGames > 0 || p.onSale) return false;
    seen.add(id);
  }
  return true;
}

export function lineupForMatch(club: Club, allPlayers: Player[], options: { futureFixtures?: boolean } = {}): Lineup | null {
  for (const player of allPlayers) {
    if (player.clubId === club.id) player.starter = false;
  }
  const saved = club.savedLineup;
  if (saved && lineupValid(club, saved, allPlayers)) {
    const formation = FORMATION_POSITIONS[club.tactics.formation] ?? FORMATION_POSITIONS[4];
    const starters: Player[] = [];
    for (let i = 0; i < 11; i++) {
      const p = byId(allPlayers, saved.starters[i]);
      if (p) {
        p.tacPos = formation[i];
        p.starter = true;
        starters.push(p);
      }
    }
    const subs: Player[] = [];
    for (let i = 0; i < saved.subs.length; i++) {
      const p = byId(allPlayers, saved.subs[i]);
      if (p) {
        p.tacPos = BENCH_ORDER[i] ?? 1;
        p.starter = false;
        subs.push(p);
      }
    }
    if (starters.length === 11) return { starters, subs, formation: club.tactics.formation, positions: formation };
  }
  return buildLineup(club, allPlayers, options);
}

/**
 * Senior (non-youth) squad size. Loaned-in players count (they occupy a squad
 * slot at the borrowing club); loaned-out players do not (their clubId is the
 * borrower). The single source for the SENIOR_SQUAD_LIMIT cap on every
 * acquisition path.
 */
export function seniorRosterCount(world: import("./types").World, clubId: number): number {
  return world.players.filter((p) => p.clubId === clubId && !p.isYouth).length;
}

/** Error string when the senior roster is at/over the shared cap, else null. */
export function seniorRosterFullError(world: import("./types").World, clubId: number): string | null {
  return seniorRosterCount(world, clubId) >= SENIOR_SQUAD_LIMIT
    ? `Senior squad is full (${SENIOR_SQUAD_LIMIT} players)`
    : null;
}

/**
 * Ephemeral filler-AI club (invariant #28). AI teams exist for a single
 * season: they have a fixed generated roster, no owner, no finances and no
 * market participation. They are destroyed when a human takes their slot or at
 * rollover, and every surviving AI is replaced by a fresh team each season.
 * Lives here (not in multiplayer.ts) so low-level modules like payroll can
 * use it without import cycles.
 */
export function isEphemeralAI(club: Club): boolean {
  return club.ownerUserId === null && !club.isHuman;
}
