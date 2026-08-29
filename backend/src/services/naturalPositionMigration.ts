/**
 * Pure V1 -> V2 natural-position migration logic (§14.3-14.5).
 *
 * Deliberately free of Prisma: `scripts/migrate-natural-positions.ts` reads
 * rows, calls into here, and writes the result inside one transaction. Keeping
 * the assignment, lineup rewrite and neutrality proof here makes them testable
 * without a database — the previous inline version could not be exercised at
 * all, and shipped a crash on its very first player.
 */
import { allocateSeededCounts } from "../game/allocation";
import { assignFixedSetToSlots } from "../game/club";
import { formationById } from "../game/formations";
import { adjustedTacticalRating } from "../game/outOfPosition";
import { legacyPositionGroup, positionGroup } from "../game/positions";
import { overallFromSkills } from "../game/rating";
import { gameConfig } from "../config";
import type { NaturalPosition, PositionGroup } from "../game/positions";
import type { SavedLineup, SkillSet } from "../game/types";

export type LegacyCode = 0 | 1 | 2 | 3 | 4;

/** A player row reduced to exactly what the migration needs. */
export interface MigrationPlayer {
  id: number;
  clubId: number | null;
  isYouth: boolean;
  legacy: LegacyCode;
  skills: SkillSet;
  overall: number;
  injuryDays: number;
  suspendedGames: number;
  onSale: boolean;
}

export interface MigrationClub {
  id: number;
  savedLineupJson: string | null;
  tacticsFormation: number;
  penaltyTakerId: number | null;
}

export interface LineupUpdate {
  clubId: number;
  json: string | null;
  penaltyTakerId: number | null;
}

export interface MigrationPlan {
  positionByPlayer: Map<number, NaturalPosition>;
  lineupUpdates: LineupUpdate[];
  countsByRole: Record<string, number>;
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** §14.2: exact group seed key. */
export function groupSeed(
  saveSeed: number,
  groupType: string,
  groupId: string,
  seniorOrYouth: string,
  legacyGroup: string,
): string {
  return `${saveSeed}|position-v2-migration|${groupType}|${groupId}|${seniorOrYouth}|${legacyGroup}`;
}

/**
 * §14.3: deterministic split of one legacy group inside one stock group.
 *
 * Child-role shares come from the SAME `playerGeneration.positionMix` config
 * that generation uses — a hard-coded split here would permanently give
 * migrated worlds a different forward mix from newly generated ones.
 */
export function splitGroup(
  group: PositionGroup,
  players: MigrationPlayer[],
  saveSeed: number,
  groupType: string,
  groupId: string,
  seniorOrYouth: string,
): Map<number, NaturalPosition> {
  const seed = groupSeed(saveSeed, groupType, groupId, seniorOrYouth, group);
  const within = gameConfig.playerGeneration.positionMix.withinGroup;
  const byId = new Map<number, NaturalPosition>();
  if (players.length === 0) return byId;

  const stableHash = (p: MigrationPlayer) => fnv1a(`${seed}|${p.id}`);
  const byStableHash = (a: MigrationPlayer, b: MigrationPlayer) => stableHash(a) - stableHash(b) || a.id - b.id;
  // Classification always uses RAW role ratings: migration must not apply an
  // out-of-position penalty to a role the player is being considered for.
  const rawRating = (p: MigrationPlayer, role: "DM" | "AM" | "ST" | "LW" | "RW") =>
    adjustedTacticalRating(p.skills, role, role) as number;

  if (group === "GK" || group === "CB") {
    for (const p of players) byId.set(p.id, group === "GK" ? "GK" : "CB");
    return byId;
  }
  if (group === "FB") {
    const counts = allocateSeededCounts(players.length, within.FB, seed);
    const sorted = [...players].sort(byStableHash);
    sorted.slice(0, counts.LB).forEach((p) => byId.set(p.id, "LB"));
    sorted.slice(counts.LB).forEach((p) => byId.set(p.id, "RB"));
    return byId;
  }
  if (group === "MF") {
    const counts = allocateSeededCounts(players.length, within.MF, seed);
    const sorted = [...players].sort((a, b) => {
      const diff = rawRating(b, "DM") - rawRating(b, "AM") - (rawRating(a, "DM") - rawRating(a, "AM"));
      return diff !== 0 ? diff : byStableHash(a, b);
    });
    sorted.slice(0, counts.DM).forEach((p) => byId.set(p.id, "DM"));
    sorted.slice(counts.DM).forEach((p) => byId.set(p.id, "AM"));
    return byId;
  }
  // FW
  const counts = allocateSeededCounts(players.length, within.FW, seed);
  const strikerAdvantage = (p: MigrationPlayer) =>
    rawRating(p, "ST") - Math.max(rawRating(p, "LW"), rawRating(p, "RW"));
  const stSorted = [...players].sort((a, b) => {
    const diff = strikerAdvantage(b) - strikerAdvantage(a);
    return diff !== 0 ? diff : byStableHash(a, b);
  });
  stSorted.slice(0, counts.ST).forEach((p) => byId.set(p.id, "ST"));
  const remaining = stSorted.slice(counts.ST).sort(byStableHash);
  remaining.slice(0, counts.LW).forEach((p) => byId.set(p.id, "LW"));
  remaining.slice(counts.LW).forEach((p) => byId.set(p.id, "RW"));
  return byId;
}

/**
 * §14.2 stock grouping: each club's seniors, each club's academy, all senior
 * free agents, all youth free agents. A loaned player belongs to his LENDER's
 * group (`loanLender`), not the borrower's.
 */
export function assignNaturalPositions(
  players: MigrationPlayer[],
  saveSeed: number,
  loanLender: Map<number, number>,
): Map<number, NaturalPosition> {
  const stockGroups = new Map<string, MigrationPlayer[]>();
  for (const p of players) {
    const key = p.clubId !== null
      ? `${p.isYouth ? "academy" : "senior"}:${loanLender.get(p.id) ?? p.clubId}`
      : `${p.isYouth ? "youth-fa" : "fa"}:free`;
    const list = stockGroups.get(key) ?? [];
    list.push(p);
    stockGroups.set(key, list);
  }
  const positionByPlayer = new Map<number, NaturalPosition>();
  for (const [key, groupPlayers] of stockGroups) {
    const [kind, groupId] = key.split(":");
    const seniorOrYouth = kind === "academy" || kind === "youth-fa" ? "youth" : "senior";
    const byLegacy = new Map<LegacyCode, MigrationPlayer[]>();
    for (const p of groupPlayers) {
      const list = byLegacy.get(p.legacy) ?? [];
      list.push(p);
      byLegacy.set(p.legacy, list);
    }
    for (const [legacy, list] of byLegacy) {
      const split = splitGroup(legacyPositionGroup(legacy), list, saveSeed, kind, groupId, seniorOrYouth);
      for (const [id, pos] of split) positionByPlayer.set(id, pos);
    }
  }
  return positionByPlayer;
}

/**
 * §14.5 numeric neutrality. Throws — never repairs — on any mismatch, so a
 * migration that would move a number aborts before writing anything.
 */
export function assertNumericNeutrality(
  players: MigrationPlayer[],
  positionByPlayer: Map<number, NaturalPosition>,
): Record<string, number> {
  const countsByRole: Record<string, number> = {};
  for (const p of players) {
    const newPos = positionByPlayer.get(p.id);
    if (!newPos) throw new Error(`[position-migration] player ${p.id} was not assigned a natural position`);
    if (positionGroup(newPos) !== legacyPositionGroup(p.legacy)) {
      throw new Error(`[position-migration] group mismatch for player ${p.id}: legacy ${p.legacy} -> ${newPos}`);
    }
    const recomputed = overallFromSkills(newPos, p.skills);
    if (recomputed !== p.overall) {
      throw new Error(
        `[position-migration] OVR mismatch for player ${p.id}: stored ${p.overall} vs recomputed ${recomputed} for ${newPos} (legacy ${p.legacy})`,
      );
    }
    countsByRole[newPos] = (countsByRole[newPos] ?? 0) + 1;
  }
  return countsByRole;
}

/**
 * §14.4: rewrite one club's saved lineup into new slot order. Returns the
 * replacement payload, or `null` to drop the saved lineup so normal sanitation
 * rebuilds it at kickoff.
 */
export function migrateSavedLineup(
  raw: string,
  formationId: number,
  clubId: number,
  byId: Map<number, MigrationPlayer>,
  positionByPlayer: Map<number, NaturalPosition>,
): SavedLineup | null {
  let saved: Partial<SavedLineup> | null = null;
  try {
    saved = JSON.parse(raw) as Partial<SavedLineup>;
  } catch {
    return null;
  }
  if (!saved || !Array.isArray(saved.starters) || saved.starters.length !== 11) return null;
  // The formation must exist: silently falling back to another formation would
  // write a starter order that does not match the club's stored tactics.
  if (!formationById(formationId)) return null;

  // §14.4.3: eleven unique, available, lineup-purpose players.
  const lineupEligible = (id: number): MigrationPlayer | null => {
    const p = byId.get(id);
    if (!p || p.clubId !== clubId) return null;
    if (p.injuryDays > 0 || p.suspendedGames > 0 || p.onSale) return null;
    return p;
  };
  const eligible = saved.starters.map(lineupEligible).filter((p): p is MigrationPlayer => !!p);
  const uniqueStarters = [...new Map(eligible.map((p) => [p.id, p])).values()];
  if (uniqueStarters.length !== 11) return null;

  // §14.4.3: pair score is raw adjusted tactical role rating only — no energy,
  // no future cost. Legacy starter ORDER is discarded (old tactical integers
  // were overloaded); the set is re-slotted optimally.
  const assign = assignFixedSetToSlots(
    uniqueStarters.map((p) => ({ id: p.id })),
    formationId,
    (candidate, role) =>
      adjustedTacticalRating(byId.get(candidate.id)!.skills, positionByPlayer.get(candidate.id)!, role),
  );
  if (!assign || assign.some((id) => id === null)) return null;
  const newStarters = assign as number[];

  const inXI = new Set(newStarters);
  // §14.4.5: drop promoted/invalid bench entries, keep the relative order of
  // every remaining valid unique entry.
  const seenBench = new Set<number>();
  const subs = (Array.isArray(saved.subs) ? saved.subs : []).filter((id) => {
    if (inXI.has(id) || seenBench.has(id)) return false;
    if (!lineupEligible(id)) return false;
    seenBench.add(id);
    return true;
  });
  // §14.4.7: preserve a taker only while he is still in the starter set.
  const freeKickTakerId =
    typeof saved.freeKickTakerId === "number" && inXI.has(saved.freeKickTakerId) ? saved.freeKickTakerId : null;
  return { starters: newStarters, subs, freeKickTakerId };
}

/**
 * Build the complete migration plan: natural positions, the neutrality proof,
 * and every saved-lineup/penalty-taker rewrite. Throws before producing a plan
 * if any legacy code is corrupt or any numeric value would move.
 */
export function buildMigrationPlan(
  players: MigrationPlayer[],
  clubs: MigrationClub[],
  saveSeed: number,
  loanLender: Map<number, number>,
): MigrationPlan {
  // §14.1 step 5: verify every legacy position is in 0..4 before anything else.
  for (const p of players) {
    if (!Number.isInteger(p.legacy) || p.legacy < 0 || p.legacy > 4) {
      throw new Error(`[position-migration] player ${p.id} has invalid legacy position ${p.legacy}`);
    }
  }
  const positionByPlayer = assignNaturalPositions(players, saveSeed, loanLender);
  const countsByRole = assertNumericNeutrality(players, positionByPlayer);
  const byId = new Map(players.map((p) => [p.id, p]));
  const lineupUpdates: LineupUpdate[] = [];
  for (const club of clubs) {
    if (!club.savedLineupJson) continue;
    const migrated = migrateSavedLineup(club.savedLineupJson, club.tacticsFormation, club.id, byId, positionByPlayer);
    const inXI = new Set(migrated?.starters ?? []);
    lineupUpdates.push({
      clubId: club.id,
      json: migrated ? JSON.stringify(migrated) : null,
      // §14.4.7 also covers the penalty taker, which lives on the Club row.
      penaltyTakerId: club.penaltyTakerId !== null && inXI.has(club.penaltyTakerId) ? club.penaltyTakerId : null,
    });
  }
  return { positionByPlayer, lineupUpdates, countsByRole };
}
