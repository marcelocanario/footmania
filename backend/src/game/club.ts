import type { Club, Player, RngState } from "./types";
import { nextInt, shuffle } from "./rng";
import { tacticalSkillRating } from "./rating";
import { DAYS_PER_YEAR } from "./constants";
import {
  BENCH_ORDER,
  FORMATION_POSITIONS,
  TICKET_PRICES,
  TICKET_PRICE_NOISE,
  TICKET_SPLIT,
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

export function squadByPosition(players: Player[]): Record<number, Player[]> {
  const byPos: Record<number, Player[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) {
    if (!p.clubId) continue;
    if (p.position >= 0 && p.position <= 4) byPos[p.position].push(p);
  }
  return byPos;
}

export function eligible(players: Player[]): Player[] {
  return players.filter((p) => !p.clubId || p.injuryDays === 0);
}

export function pickForTacPos(players: Player[], tacPos: number, excluded: Set<number>, sideVariant: boolean): Player | null {
  const position = tacPosToBasePosition(tacPos);
  const candidates = players.filter(
    (p) => p.injuryDays === 0 && p.suspendedGames === 0 && p.position === position && !excluded.has(p.id) && !(tacPos === 1 && p.position !== 0)
  );
  if (candidates.length === 0) return null;
  if (sideVariant) {
    const bySide = candidates.filter((p) => p.tacPos >= 0);
    const pool = bySide.length > 0 ? bySide : candidates;
    const sorted = [...pool].sort((a, b) => {
      const tacticalDifference = tacticalSkillRating(b.skills, tacPos) - tacticalSkillRating(a.skills, tacPos);
      if (tacticalDifference !== 0) return tacticalDifference;
      if (a.overall !== b.overall) return b.overall - a.overall;
      return b.energy - a.energy;
    });
    return sorted[0];
  }
  const sorted = [...candidates].sort((a, b) => {
    const tacticalDifference = tacticalSkillRating(b.skills, tacPos) - tacticalSkillRating(a.skills, tacPos);
    return tacticalDifference || b.overall - a.overall || b.energy - a.energy;
  });
  return sorted[0];
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
export function buildLineup(club: Club, allPlayers: Player[]): Lineup | null {
  const roster = allPlayers.filter((p) => p.clubId === club.id && !p.onSale);
  for (const player of allPlayers) {
    if (player.clubId === club.id) player.starter = false;
  }
  const available = roster.filter((p) => p.injuryDays === 0 && p.suspendedGames === 0);
  const formation = FORMATION_POSITIONS[club.tactics.formation] ?? FORMATION_POSITIONS[4];
  const excluded = new Set<number>();
  const starters: Player[] = [];
  for (const tacPos of formation) {
    // A randomly assigned formation can ask for more players in a position
    // than a generated squad has. Fill the tactical slot from the best
    // remaining eligible player rather than returning an empty match lineup.
    const p = pickForTacPos(available, tacPos, excluded, true) ?? pickFallbackForTacPos(available, tacPos, excluded);
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
    const p = pickForTacPos(benchPool, slot, excluded, true);
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

function pickFallbackForTacPos(players: Player[], tacPos: number, excluded: Set<number>): Player | null {
  return players
    .filter((p) => p.injuryDays === 0 && p.suspendedGames === 0 && !excluded.has(p.id))
    .sort((a, b) => tacticalSkillRating(b.skills, tacPos) - tacticalSkillRating(a.skills, tacPos) || b.overall - a.overall || b.energy - a.energy)[0] ?? null;
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

export function lineupForMatch(club: Club, allPlayers: Player[]): Lineup | null {
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
  return buildLineup(club, allPlayers);
}

export function squadStrength(club: Club, allPlayers: Player[]): number {
  const roster = allPlayers.filter((p) => p.clubId === club.id);
  const lineup = buildLineup(club, allPlayers);
  const base = lineup ? lineup.starters.reduce((s, p) => s + p.overall, 0) : 0;
  const squad = roster.reduce((s, p) => s + p.overall, 0);
  return Math.round(base / 11 + squad / 55);
}

export function positionCount(club: Club, allPlayers: Player[]): number[] {
  const counts = [0, 0, 0, 0, 0];
  for (const p of allPlayers) {
    if (p.clubId === club.id) counts[p.position]++;
  }
  return counts;
}

export function weeklySalary(club: Club, allPlayers: Player[]): number {
  let total = 0;
  for (const p of allPlayers) {
    if (p.clubId === club.id) total += Math.round((p.salary * 7) / DAYS_PER_YEAR);
  }
  return total;
}

/** Total seasonal wage bill (Player.salary is the wage for one season). */
export function seasonSalary(club: Club, allPlayers: Player[]): number {
  let total = 0;
  for (const p of allPlayers) {
    if (p.clubId === club.id) total += p.salary;
  }
  return total;
}

export function sectorCapacity(capacity: number): number[] {
  return [
    Math.round(capacity * TICKET_SPLIT[0]),
    Math.round(capacity * TICKET_SPLIT[1]),
    Math.round(capacity * TICKET_SPLIT[2]),
    Math.round(capacity * TICKET_SPLIT[3]),
  ];
}

export interface TicketCalc {
  attendance: number;
  revenue: number;
  sectors: number[];
}

const ATTENDANCE_BY_COMP: Record<string, number[][]> = {
  league: [
    [5, 18, 25, 45], [15, 25, 40, 90], [10, 20, 30, 80], [8, 16, 25, 50], [5, 14, 20, 40],
  ],
  state: [
    [3, 5, 12, 20], [3, 12, 15, 30], [3, 12, 15, 30], [5, 12, 20, 50], [10, 15, 25, 70],
  ],
  cup: [
    [3, 12, 15, 30], [3, 12, 15, 30], [3, 12, 15, 30], [7, 13, 20, 70], [10, 15, 25, 80],
  ],
};

/** Club tier 1..5 derived from level (replaces the removed reputation). */
export function clubTier(club: Club): number {
  return Math.min(5, Math.max(1, Math.round(club.level / 5)));
}

export function calcGate(
  rng: RngState,
  home: Club,
  away: Club,
  compKind: string,
  configuredPrices?: [number, number, number, number]
): TicketCalc {
  const homeTier = clubTier(home);
  const awayTier = clubTier(away);
  const sectors = sectorCapacity(home.stadiumCapacity);
  const reference = TICKET_PRICES[Math.min(5, homeTier)].map((x) => Math.max(1, Math.round(x / 200)));
  let prices = configuredPrices ? [...configuredPrices] : [...reference] as number[];
  if (!configuredPrices && (compKind === "state" || compKind === "cup")) prices = prices.map((x) => Math.max(1, Math.round(x * 0.7)));
  const noise = TICKET_PRICE_NOISE[Math.min(4, homeTier)];
  if (!configuredPrices) {
    for (let i = 0; i < 4; i++) prices[i] += nextInt(rng, Math.max(1, Math.round(noise[i] / 10)) + 1);
  }
  let demand = 0.3;
  if (compKind === "league") demand += 0.15;
  if (compKind === "state" || compKind === "cup") demand += 0.3;
  for (let i = 0; i < 4; i++) prices[i] = Math.max(1, Math.round(prices[i] * (1 + demand)));
  const diff = Math.min(5, Math.abs(awayTier - homeTier));
  const factor = [0, 0.05, 0.1, 0.15, 0.2, 0.25][diff];
  for (let i = 0; i < 4; i++) {
    const adj = Math.round(prices[i] * factor);
    prices[i] = awayTier > homeTier ? prices[i] + adj : Math.max(1, prices[i] - adj);
  }
  const fanFactor = Math.max(0.3, home.fanConfidence / 100);
  const table = ATTENDANCE_BY_COMP[compKind] ?? ATTENDANCE_BY_COMP.league;
  const attIdx = Math.min(4, Math.max(0, homeTier - 1));
  const attPct = table[attIdx] ?? table[0];
  let attendance = 0;
  let revenue = 0;
  for (let i = 0; i < 4; i++) {
    const cap = sectors[i];
    const referencePrice = Math.max(1, reference[i]);
    const elasticity = Math.max(0.35, Math.min(1.5, 1 / (1 + (prices[i] - referencePrice) / referencePrice)));
    const tickets = Math.min(cap, Math.max(0, Math.round((cap * attPct[i] * elasticity * fanFactor) / 100)));
    attendance += tickets;
    revenue += tickets * prices[i];
  }
  return { attendance, revenue, sectors };
}
