import type { Club, Player, RngState } from "./types";
import { nextInt } from "./rng";
import { tacticalSkillRating, overallFromSkills } from "./rating";
import { athleticism, energyLoss, loadIncrement, physicalSkill, readiness, recoverEnergy } from "./energyInjury";
import { gameConfig } from "../config";
import { MATCH_SIMULATOR_CONFIG } from "../matchSimulatorConfig";
import { SENIOR_SQUAD_LIMIT } from "./constants";
import type { DeployedRole } from "./positions";
import { DEPLOYED_ROLES, positionGroup } from "./positions";
import { adjustedSkills, adjustedTacticalRating as adjustedRoleRating, isEligible } from "./outOfPosition";
import { FORMATIONS, formationById } from "./formations";

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

// §7 lives in outOfPosition.ts — the single authority for penalties, labels and
// adjusted skills. These thin re-exports keep existing call sites readable.
export { rolePenalty as penaltyFor, suitabilityLabel } from "./outOfPosition";

/** Adjusted raw skills after the role penalty (§7.1); null when ineligible. */
export function adjustedSkillsForRole(p: Player, role: DeployedRole): Player["skills"] | null {
  return adjustedSkills(p.skills, p.position, role);
}

/** Adjusted deployed-role tactical rating (§7.1): never exceeds the unpenalized rating. */
export function adjustedTacticalRating(p: Player, role: DeployedRole): number | null {
  return adjustedRoleRating(p.skills, p.position, role);
}

/** Current adjusted rating × readiness (§9.2). */
export function currentScore(p: Player, role: DeployedRole): number | null {
  const rating = adjustedTacticalRating(p, role);
  if (rating === null) return null;
  return rating * readiness(p.energy);
}

// ---------------------------------------------------------------------------
// Globally optimal XI assignment (§9.2)
//
// Deterministic DP over the 11 formation slots keyed by an 11-bit assigned-slot
// mask. Candidates are sorted by player ID. For each player: skip or assign to
// one empty compatible slot. Tie-break: larger total score (epsilon 1e-9), then
// lexicographically smaller player-ID array in slot order.
// ---------------------------------------------------------------------------

interface PairScore {
  score: number;
  ids: number[];
}

export interface AssignedSlot {
  role: DeployedRole;
  player: Player;
}

export interface BestXiResult {
  formation: number;
  slots: AssignedSlot[];
  totalScore: number;
}

/**
 * Core assignment DP (§9.2), shared by the full-XI and partial variants.
 *
 * State is `(playerIndex, slotMask)` exactly as the plan prescribes: players are
 * iterated once and each is either skipped or placed in one empty compatible
 * slot, so a player can never be used twice by construction. (Keying the state
 * on the mask alone and filtering against one stored representative set is NOT
 * the same DP and is not provably optimal.)
 *
 * Assignments live in one flat Int32Array — `assign[mask * 11 + slot]` — with
 * -1 for "empty", so a state transition copies 11 int32s instead of allocating
 * a JS array. That matters: this runs once per formation per AI club per match.
 *
 * Returns per-mask scores and assignments; the callers pick which mask to read.
 */
const NO_PLAYER = -1;

/** Widest slot list the DP supports: a formation's eleven slots. The bench
 *  archetype list is shorter, so every table below is indexed by slot count. */
const MAX_SLOTS = 11;

/** Popcount of every 11-bit mask. Valid for any narrower mask too. */
const POPCOUNT11 = new Uint8Array(1 << MAX_SLOTS);
for (let mask = 0; mask < 1 << MAX_SLOTS; mask++) {
  let n = 0;
  for (let i = 0; i < MAX_SLOTS; i++) if ((mask & (1 << i)) !== 0) n++;
  POPCOUNT11[mask] = n;
}

/** Masks of a given width bucketed by popcount, built on first use per width. */
const MASK_BUCKETS_BY_WIDTH: (Int32Array[] | undefined)[] = new Array(MAX_SLOTS + 1);
function masksByPopcount(width: number): Int32Array[] {
  const cached = MASK_BUCKETS_BY_WIDTH[width];
  if (cached) return cached;
  const buckets: number[][] = Array.from({ length: width + 2 }, () => []);
  for (let mask = 0; mask < 1 << width; mask++) buckets[POPCOUNT11[mask]].push(mask);
  const built = buckets.map((bucket) => Int32Array.from(bucket));
  MASK_BUCKETS_BY_WIDTH[width] = built;
  return built;
}

interface AssignmentDp {
  score: Float64Array;
  assign: Int32Array;
  reachable: Uint8Array;
  roles: DeployedRole[];
  byId: Map<number, Player>;
}

/** Shared DP tables. Not reentrant: a caller must finish reading the returned
 *  view before starting another assignment run. All three call sites
 *  (assignBestXI, assignOnPitchToSlots, buildBench) do exactly that. */
const _dpScore = new Float64Array(1 << MAX_SLOTS);
const _dpReachable = new Uint8Array(1 << MAX_SLOTS);
const _dpAssign = new Int32Array((1 << MAX_SLOTS) * MAX_SLOTS);

function runAssignmentDp<T extends { id: number }>(
  available: T[],
  roles: readonly DeployedRole[],
  scoreOf: (p: T, role: DeployedRole) => number | null,
): (Omit<AssignmentDp, "byId" | "roles"> & { byId: Map<number, T>; roles: readonly DeployedRole[]; slotCount: number }) | null {
  const slotCount = roles.length;
  if (slotCount < 1 || slotCount > MAX_SLOTS) return null;
  const size = 1 << slotCount;

  // Deterministic candidate order by id: the DP is exhaustive, so ordering
  // affects only tie-break determinism.
  const candidates = [...available].sort((a, b) => a.id - b.id);
  const byId = new Map<number, T>();
  // Per-candidate slot scores, computed once into one flat table indexed by
  // (usable index * 11 + slot) so the relaxation below needs no per-player
  // allocation and no id lookup.
  const slotScores = new Float64Array(candidates.length * slotCount);
  const usable: T[] = [];
  for (const p of candidates) {
    const offset = usable.length * slotCount;
    let any = false;
    for (let slot = 0; slot < slotCount; slot++) {
      const s = scoreOf(p, roles[slot]);
      slotScores[offset + slot] = s ?? -Infinity;
      if (s !== null) any = true;
    }
    if (!any) continue;
    usable.push(p);
    byId.set(p.id, p);
  }

  // Reusable scratch: the three tables total ~110 KB and this DP runs ~30
  // times per simulated match (thirteen-plus formations per side). Every caller
  // consumes the returned view synchronously before the next run, so one shared
  // set of buffers is enough — see the contract note on runAssignmentDp.
  const score = _dpScore;
  const reachable = _dpReachable;
  const assign = _dpAssign;
  score.fill(-Infinity, 0, size);
  reachable.fill(0, 0, size);
  // Only the empty state's row needs clearing: a state's row is written in full
  // (parent row + the newly filled slot) at the moment it becomes reachable, so
  // no stale row can ever be read.
  assign.fill(NO_PLAYER, 0, slotCount);
  score[0] = 0;
  reachable[0] = 1;
  // Per-candidate bitmask of the slots he is eligible for. Iterating only the
  // set bits of `eligible & ~mask` visits exactly the slots the scan used to
  // reach after two rejected tests each, in the same ascending order — a
  // goalkeeper now costs one transition per state instead of eleven.
  const eligibleSlots = new Int32Array(usable.length);
  for (let pi = 0; pi < usable.length; pi++) {
    let bits = 0;
    for (let slot = 0; slot < slotCount; slot++) {
      if (slotScores[pi * slotCount + slot] !== -Infinity) bits |= 1 << slot;
    }
    eligibleSlots[pi] = bits;
  }
  const buckets = masksByPopcount(slotCount);
  const topLayer = slotCount - 1;

  // In-place 0/1 relaxation. A transition always moves a state from popcount k
  // to k+1, so visiting popcount layers in DESCENDING order guarantees a state
  // updated by this player is never read as a source for the same player —
  // exactly the "each item used at most once" property, without copying the
  // whole DP layer per player (which dominated the cost of the 13-formation
  // AI search).
  for (let pi = 0; pi < usable.length; pi++) {
    const pid = usable[pi].id;
    const scoreBase = pi * slotCount;
    const eligible = eligibleSlots[pi];
    // After `pi` players have been relaxed no mask above popcount `pi` can be
    // reachable, so the higher layers are pure iteration over dead states.
    for (let k = pi < topLayer ? pi : topLayer; k >= 0; k--) {
      const bucket = buckets[k];
      for (let bi = 0; bi < bucket.length; bi++) {
        const mask = bucket[bi];
        if (!reachable[mask]) continue;
        let bits = eligible & ~mask;
        if (bits === 0) continue;
        const base = score[mask];
        const rowStart = mask * slotCount;
        while (bits !== 0) {
          const bit = bits & -bits;
          bits ^= bit;
          const slot = 31 - Math.clz32(bit);
          const newMask = mask | bit;
          const newScore = base + slotScores[scoreBase + slot];
          const target = newMask * slotCount;
          if (!reachable[newMask] || newScore > score[newMask] + 1e-9) {
            score[newMask] = newScore;
            reachable[newMask] = 1;
            assign.copyWithin(target, rowStart, rowStart + slotCount);
            assign[target + slot] = pid;
          } else if (Math.abs(newScore - score[newMask]) <= 1e-9) {
            // §9.2 tie-break: lexicographically smaller player-ID array in slot
            // order, with an empty slot sorting after every real id. Compared
            // element by element against the stored row so the candidate row
            // never has to be materialized (ties are common — scores are often
            // exactly equal — so this path is hot).
            let smaller = false;
            for (let i = 0; i < slotCount; i++) {
              const rawA = i === slot ? pid : assign[rowStart + i];
              const rawB = assign[target + i];
              const av = rawA === NO_PLAYER ? Number.MAX_SAFE_INTEGER : rawA;
              const bv = rawB === NO_PLAYER ? Number.MAX_SAFE_INTEGER : rawB;
              if (av !== bv) { smaller = av < bv; break; }
            }
            if (smaller) {
              assign.copyWithin(target, rowStart, rowStart + slotCount);
              assign[target + slot] = pid;
            }
          }
        }
      }
    }
  }
  return { score, assign, reachable, roles, byId, slotCount };
}

/** Lexicographic compare of two flat assignment rows; -1 sorts last. */
function lexAssignSmallerFlat(a: Int32Array, aOff: number, b: Int32Array, bOff: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    const av = a[aOff + i] === NO_PLAYER ? Number.MAX_SAFE_INTEGER : a[aOff + i];
    const bv = b[bOff + i] === NO_PLAYER ? Number.MAX_SAFE_INTEGER : b[bOff + i];
    if (av !== bv) return av < bv;
  }
  return false;
}

export function assignBestXI(
  available: Player[],
  formationId: number,
  scoreOf: (p: Player, role: DeployedRole) => number | null,
): { slots: AssignedSlot[]; totalScore: number } | null {
  const def = formationById(formationId);
  if (!def) return null;
  const dp = runAssignmentDp(available, def.slots.map((slot) => slot.role), scoreOf);
  if (!dp) return null;
  const full = (1 << dp.slotCount) - 1;
  if (!dp.reachable[full]) return null;
  const base = full * dp.slotCount;
  const slots: AssignedSlot[] = [];
  const seen = new Set<number>();
  for (let slot = 0; slot < dp.slotCount; slot++) {
    const pid = dp.assign[base + slot];
    const player = pid === NO_PLAYER ? undefined : dp.byId.get(pid);
    if (!player || seen.has(pid)) return null;
    seen.add(pid);
    slots.push({ role: dp.roles[slot], player });
  }
  return { slots, totalScore: dp.score[full] };
}

/**
 * Partial assignment of a fixed set of players to a formation's slots (§9.1).
 *
 * Used when a side changes formation mid-match: the players already on the
 * pitch must be re-slotted WITHOUT substituting anyone, and a slot may stay
 * empty when the side is short (a dismissed or unreplaced injured GK therefore
 * leaves the GK slot empty rather than handing it to an outfielder).
 *
 * Candidate results compare by: more assigned players, then larger total score,
 * then the §9.2 lexicographic player-ID tie-break in slot order.
 *
 * Returns `playerIdBySlot[slotIndex] = id | null`.
 */
export function assignOnPitchToSlots<T extends { id: number }>(
  onPitch: T[],
  formationId: number,
  scoreOf: (p: T, role: DeployedRole) => number | null,
): (number | null)[] | null {
  const def = formationById(formationId);
  if (!def) return null;
  const dp = runAssignmentDp(onPitch, def.slots.map((slot) => slot.role), scoreOf);
  if (!dp) return null;
  const size = 1 << dp.slotCount;
  let bestMask = -1;
  let bestCount = -1;
  for (let mask = 0; mask < size; mask++) {
    if (!dp.reachable[mask]) continue;
    const count = POPCOUNT11[mask];
    if (bestMask === -1 || count > bestCount) {
      bestMask = mask;
      bestCount = count;
      continue;
    }
    if (count < bestCount) continue;
    const diff = dp.score[mask] - dp.score[bestMask];
    if (diff > 1e-9) { bestMask = mask; continue; }
    if (diff < -1e-9) continue;
    if (lexAssignSmallerFlat(dp.assign, mask * dp.slotCount, dp.assign, bestMask * dp.slotCount, dp.slotCount)) bestMask = mask;
  }
  if (bestMask === -1) return null;
  const base = bestMask * dp.slotCount;
  return Array.from({ length: dp.slotCount }, (_, slot) =>
    dp.assign[base + slot] === NO_PLAYER ? null : dp.assign[base + slot]);
}

/**
 * Assign a FIXED set of players to a formation's slots, maximizing total score
 * (§14.4). Same DP as {@link assignOnPitchToSlots}; the distinct name documents
 * that the caller has already decided who plays and only the slot order is open.
 */
export const assignFixedSetToSlots = assignOnPitchToSlots;


/** Human auto-fill / preview pair score (§9.2): adjusted rating × readiness. */
const humanScoreOf = (p: Player, role: DeployedRole): number | null => currentScore(p, role);

/** AI pair score (§9.2): currentScore - futureCostWeight × futureCost. */
export function aiSelectionValue(player: Player, role: DeployedRole, pressing = 50): number {
  const rating = adjustedTacticalRating(player, role);
  if (rating === null) return -Infinity;
  const base = rating;
  const current = base * readiness(player.energy);
  const spacing = gameConfig.matchSpacingDays;
  const project = (played: boolean): number => {
    let energy = player.energy;
    let load = player.recentLoad ?? 0;
    if (played) {
      energy = Math.max(0, energy - energyLoss({ energy, age: player.age, physicalSkill: physicalSkill(player), position: roleToEnergyRole(role), pressing, involvement: 0.5, minutes: 90 }));
      load = Math.min(6, load + loadIncrement({ position: roleToEnergyRole(role), pressing, involvement: 0.5, minutes: 90 }));
    }
    for (let day = 0; day < spacing; day++) {
      load *= Math.pow(2, -1 / spacing);
      energy = recoverEnergy({ ...player, energy, recentLoad: load }, load, spacing);
    }
    return energy;
  };
  const playedNext = project(true);
  const restedNext = project(false);
  const futureCost = base * (readiness(restedNext) - readiness(playedNext));
  const cfg = MATCH_SIMULATOR_CONFIG.aiPregameTactics as unknown as { futureCostWeight?: number };
  const weight = cfg.futureCostWeight ?? 0.45;
  return current - weight * futureCost;
}

function aiScoreOf(pressing: number) {
  // The value depends only on (player, role) — never on the formation or slot —
  // and each call runs two multi-day energy projections, so memoize across the
  // formations aiBestXI evaluates. The per-player row is keyed by role index so
  // a lookup costs no string concatenation.
  const cache = new Map<number, (number | null)[]>();
  return (p: Player, role: DeployedRole): number | null => {
    let row = cache.get(p.id);
    if (row === undefined) {
      row = new Array<number | null>(DEPLOYED_ROLES.length);
      cache.set(p.id, row);
    }
    const index = DEPLOYED_ROLES.indexOf(role);
    const hit = row[index];
    if (hit !== undefined) return hit;
    const v = aiSelectionValue(p, role, pressing);
    const out = Number.isFinite(v) ? v : null;
    row[index] = out;
    return out;
  };
}

/** §13.1 energy/load role from a deployed role (GK/DEF/MID/ATT). */
function roleToEnergyRole(role: DeployedRole): "GK" | "DEF" | "MID" | "ATT" {
  if (role === "GK") return "GK";
  if (role === "LB" || role === "RB" || role === "CB") return "DEF";
  if (role === "DM" || role === "AM") return "MID";
  return "ATT";
}

export interface Lineup {
  starters: Player[];
  subs: Player[];
  formation: number;
}

/** Preview the lineup kickoff would field (sanitized saved lineup, else auto). */
export function peekLineup(club: Club, allPlayers: Player[]): Lineup | null {
  const saved = club.savedLineup;
  if (saved && saved.starters.length === 11) {
    const sanitized = sanitizeSavedLineup(club, allPlayers, saved);
    if (sanitized) return sanitized;
  }
  const lineup = buildLineup(club, allPlayers);
  if (!lineup) return null;
  return {
    starters: lineup.starters,
    subs: lineup.subs,
    formation: lineup.formation,
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
  const formation = club.tactics.formation;
  const scoreOf = club.isHuman
    ? humanScoreOf
    : aiScoreOf(enginePressingScale(club.tactics.pressing));
  const assigned = assignBestXI(available, formation, scoreOf);
  if (!assigned) return null;
  const starters = assigned.slots.map((s) => s.player);
  const excluded = new Set(starters.map((p) => p.id));
  starters.forEach((p) => { p.starter = true; });
  const subs = buildBench(available, excluded, scoreOf);
  return { starters, subs, formation };
}

/**
 * Bench construction (§9.4): partial DP against the archetype order
 * GK, LB, RB, CB, DM, AM, LW, RW, ST. A state may skip an archetype.
 * Compare final states by: more archetypes filled; lexicographically larger
 * filled-archetype mask read GK→ST (earlier archetype wins at equal counts);
 * larger total current score; lexicographically smaller player-ID array in
 * archetype order (Number.MAX_SAFE_INTEGER for unfilled).
 *
 * The plan text lists eleven archetypes because it predates the removal of the
 * LM/RM sub-roles; the list is now the nine deployed roles, and the mask is
 * nine bits wide. The comparison tuple is unchanged.
 * Append any still-unfilled places by adjusted best-role rating desc, energy
 * desc, overall desc, player ID asc.
 */
const BENCH_ARCHETYPES: DeployedRole[] = ["GK", "LB", "RB", "CB", "DM", "AM", "LW", "RW", "ST"];

function buildBench(available: Player[], excluded: Set<number>, scoreOf: (p: Player, role: DeployedRole) => number | null): Player[] {
  const pool = available.filter((p) => !excluded.has(p.id));
  const dp = runAssignmentDp(pool, BENCH_ARCHETYPES, scoreOf);
  const bench: Player[] = [];
  const used = new Set<number>();
  if (dp) {
    // Compare final states by the §9.4 tuple: more archetypes filled, then the
    // lexicographically larger archetype mask read GK->RM (so an earlier
    // archetype wins at equal counts), then total score, then the smaller
    // player-ID array in archetype order.
    let bestMask = -1;
    for (let mask = 0; mask < 1 << dp.slotCount; mask++) {
      if (!dp.reachable[mask]) continue;
      if (bestMask === -1) { bestMask = mask; continue; }
      const count = POPCOUNT11[mask];
      const bestCount = POPCOUNT11[bestMask];
      if (count !== bestCount) { if (count > bestCount) bestMask = mask; continue; }
      // BENCH_ARCHETYPES[0] = GK is bit 0 (least significant), the opposite of
      // lexicographic significance, so compare the bit-reversed masks.
      const rev = reverseMask(mask, dp.slotCount);
      const bestRev = reverseMask(bestMask, dp.slotCount);
      if (rev !== bestRev) { if (rev > bestRev) bestMask = mask; continue; }
      const diff = dp.score[mask] - dp.score[bestMask];
      if (Math.abs(diff) > 1e-9) { if (diff > 0) bestMask = mask; continue; }
      if (lexAssignSmallerFlat(dp.assign, mask * dp.slotCount, dp.assign, bestMask * dp.slotCount, dp.slotCount)) bestMask = mask;
    }
    if (bestMask !== -1) {
      const base = bestMask * dp.slotCount;
      for (let arch = 0; arch < dp.slotCount; arch++) {
        const id = dp.assign[base + arch];
        if (id === NO_PLAYER) continue;
        const player = dp.byId.get(id);
        if (!player) continue;
        bench.push(player);
        used.add(id);
      }
    }
  }
  // §9.4: append any still-unfilled bench places by adjusted best-role rating
  // desc, energy desc, overall desc, player ID asc.
  const bestRoleOf = (p: Player): number => {
    let best = -1;
    for (const role of BENCH_ARCHETYPES) {
      const rating = adjustedTacticalRating(p, role);
      if (rating !== null && rating > best) best = rating;
    }
    return best;
  };
  const leftovers = pool
    .filter((p) => !used.has(p.id))
    .map((p) => ({ p, rating: bestRoleOf(p) }))
    .sort((a, b) =>
      b.rating - a.rating ||
      b.p.energy - a.p.energy ||
      b.p.overall - a.p.overall ||
      a.p.id - b.p.id);
  for (const { p } of leftovers) {
    if (bench.length >= 11) break;
    bench.push(p);
    used.add(p.id);
  }
  bench.forEach((p) => { p.starter = false; });
  return bench;
}

function reverseMask(mask: number, width: number): number {
  let rev = 0;
  for (let i = 0; i < width; i++) {
    if ((mask & (1 << i)) !== 0) rev |= 1 << (width - 1 - i);
  }
  return rev;
}

/**
 * Club.tactics.pressing is a 0–2 scale (Light/Balanced/Heavy); the Energy
 * model expects the engine's 0–100 scale (same mapping as `enginePressing`).
 */
function enginePressingScale(pressing: number): number {
  return Math.max(0, Math.min(2, pressing)) / 2 * 100;
}

// ---------------------------------------------------------------------------
// Pre-match AI tactic selection (own squad only — no opponent scouting, no
// hidden data). Deterministic: the same roster state always produces the same
// tactics, so a restart or retry cannot reroll a different setup.
// ---------------------------------------------------------------------------

/** Deployed roles played out wide (fullbacks and wingers). */
const WIDE_ROLES = new Set<DeployedRole>(["LB", "RB", "LW", "RW"]);

interface AiTacticsProfile {
  pace: number;
  technique: number;
  passing: number;
  defending: number;
  playmaking: number;
  athleticism: number;
  finishing: number;
  energy: number;
}

/** Attribute profile of the squad's top contributors (config: profileSize). */
function squadProfile(available: Player[], size: number): AiTacticsProfile {
  const core = [...available].sort((a, b) => b.overall - a.overall || a.id - b.id).slice(0, size);
  const mean = (pick: (p: Player) => number): number => core.reduce((sum, p) => sum + pick(p), 0) / core.length;
  return {
    pace: mean((p) => p.skills.pace),
    technique: mean((p) => p.skills.tec),
    passing: mean((p) => p.skills.pas),
    defending: mean((p) => p.skills.des),
    playmaking: mean((p) => p.skills.playmaking),
    athleticism: mean((p) => athleticism(p.skills)),
    finishing: mean((p) => p.skills.fin),
    energy: mean((p) => p.energy),
  };
}

/**
 * Best-XI over all formation variants for a set of available players: the
 * variant whose eleven slots maximize total pair score (§10). Ties keep the
 * lowest formation index. Pure: mutates nothing. Exported for tests and
 * AI-tactic consumers.
 */
export function aiBestXI(
  available: Player[],
  aiOptions: { pressing: number; futureFixtures: boolean }
): { formation: number; slots: AssignedSlot[]; totalScore: number } | null {
  void aiOptions.futureFixtures;
  const scoreOf = aiScoreOf(aiOptions.pressing);
  let best: BestXiResult | null = null;
  // The XI-assignment DP maximizes the sum of scoreOf(player, role), which
  // depends only on how many of each role a formation demands — not their
  // physical order. Two formations with the same role multiset therefore have
  // identical optimal scores (and the same eligibility outcome). FORMATIONS is
  // ordered by id, so the first formation of each multiset seen is that group's
  // lowest id — the existing tie-break winner — and later duplicates can be
  // skipped entirely. This key is derived from the catalog at runtime, so the
  // dedup stays correct automatically as formations are added or removed.
  const seen = new Set<string>();
  for (const f of FORMATIONS) {
    const key = f.slots.map((s) => s.role).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const assigned = assignBestXI(available, f.id, scoreOf);
    if (!assigned) continue;
    if (!best || assigned.totalScore > best.totalScore + 1e-9 || (Math.abs(assigned.totalScore - best.totalScore) <= 1e-9 && f.id < best.formation)) {
      best = { formation: f.id, slots: assigned.slots, totalScore: assigned.totalScore };
    }
  }
  return best;
}

/**
 * Choose the starting tactics that best fit an AI club's own squad and mutate
 * `club.tactics` accordingly. Called per matchday so injuries, suspensions,
 * fatigue and rotation pressure are reflected in both the tactic and the XI:
 *
 * 1. Style/pressing from the squad attribute profile of its top contributors
 *    (CONTROL = technical/passing blend incl. playmaking share; PRESS =
 *    defending + athleticism; COUNTER = pace + finishing; pressing levels gated
 *    by athleticism quality + energy reserve).
 * 2. Formation/XI from `aiBestXI`, scored under the freshly chosen pressing so
 *    rotation cost projection matches reality.
 * 3. Direction exploits whichever slot group of the chosen XI rates higher
 *    (wide vs central) by at least `wideDirectionAdvantageMin` rating points.
 */
export function chooseAiTactics(club: Club, allPlayers: Player[]): void {
  if (club.isHuman) return;
  const cfg = MATCH_SIMULATOR_CONFIG.aiPregameTactics as unknown as {
    profileSize: number;
    controlTechnicalWeight: number;
    controlPassingWeight: number;
    controlPlaymakingShare: number;
    pressDefendingWeight: number;
    pressAthleticismWeight: number;
    counterPaceWeight: number;
    counterFinishingWeight: number;
    pressingHeavyAthleticismMin: number;
    pressingVeryHeavyAthleticismMin: number;
    pressingEnergyReserveMin: number;
    wideDirectionAdvantageMin: number;
  };
  const available = allPlayers.filter(
    (p) => p.clubId === club.id && !p.onSale && p.injuryDays === 0 && p.suspendedGames === 0
  );
  if (available.length === 0) return;

  const profile = squadProfile(available, cfg.profileSize);
  // §10: CONTROL = technical + blended creation (passing/playmaking share).
  const controlCreation = (1 - cfg.controlPlaymakingShare) * profile.passing + cfg.controlPlaymakingShare * profile.playmaking;
  let style = 0;
  let bestStyleScore =
    cfg.controlTechnicalWeight * profile.technique + cfg.controlPassingWeight * controlCreation;
  const pressScore = cfg.pressDefendingWeight * profile.defending + cfg.pressAthleticismWeight * profile.athleticism;
  const counterScore = cfg.counterPaceWeight * profile.pace + cfg.counterFinishingWeight * profile.finishing;
  if (pressScore > bestStyleScore) {
    style = 1;
    bestStyleScore = pressScore;
  }
  if (counterScore > bestStyleScore) {
    style = 2;
    bestStyleScore = counterScore;
  }

  // Pressing intensity: escalate only while the squad is athletic enough to
  // sustain it; Heavy additionally requires an energy reserve.
  let pressing = 0;
  if (profile.athleticism >= cfg.pressingHeavyAthleticismMin) pressing = 1;
  if (profile.athleticism >= cfg.pressingVeryHeavyAthleticismMin && profile.energy >= cfg.pressingEnergyReserveMin) pressing = 2;

  const best = aiBestXI(available, { pressing: enginePressingScale(pressing), futureFixtures: true });
  if (!best) return;

  // Direction: compare mean adjusted tactical rating of the chosen XI's wide vs
  // central outfield slots; play down the wings only when clearly stronger there.
  let wideSum = 0;
  let wideCount = 0;
  let centralSum = 0;
  let centralCount = 0;
  for (const slot of best.slots) {
    if (slot.role === "GK") continue;
    const rating = adjustedTacticalRating(slot.player, slot.role) ?? 0;
    if (WIDE_ROLES.has(slot.role)) {
      wideSum += rating;
      wideCount++;
    } else {
      centralSum += rating;
      centralCount++;
    }
  }
  const wideMean = wideCount > 0 ? wideSum / wideCount : -Infinity;
  const centralMean = centralCount > 0 ? centralSum / centralCount : -Infinity;
  const direction = wideMean - centralMean >= cfg.wideDirectionAdvantageMin ? 1 : 0;

  club.tactics.formation = best.formation;
  club.tactics.style = style;
  club.tactics.pressing = pressing;
  club.tactics.direction = direction;
}

export interface SavedLineupInput {
  formation: number;
  starters: number[];
  subs: number[];
  penaltyTakerId: number | null;
  /** Retired control (no direct-free-kick shot resolution exists in the
   *  engine, plan §11/§14): omit to carry the club's previously stored value
   *  forward unchanged. Only validated against the XI when explicitly given,
   *  so a client that no longer sends this field can never wipe it. */
  freeKickTakerId?: number | null;
}

export function applySavedLineup(club: Club, allPlayers: Player[], input: SavedLineupInput): string | null {
  // Youth are squad-eligible (see buildLineup policy note) and may be saved.
  const roster = allPlayers.filter((p) => p.clubId === club.id);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const all = [...input.starters, ...input.subs];
  const seen = new Set<number>();
  // §9.3 manual-save validation: exactly 11 starters, formation exists,
  // slot 0 natural GK, no natural GK in slots 1..10, all pairings eligible.
  const formationDef = formationById(input.formation);
  if (!formationDef) return "Formation does not exist";
  if (input.starters.length !== 11) return "A starting eleven requires exactly 11 players";
  for (let i = 0; i < all.length; i++) {
    const id = all[i];
    const p = byId.get(id);
    if (!p) return "Lineup contains a player not in the squad";
    if (p.injuryDays > 0 || p.suspendedGames > 0 || p.onSale) {
      return `${p.name} is not available (injured, suspended or on sale)`;
    }
    if (seen.has(id)) return "A player appears twice in the lineup";
    seen.add(id);
    if (i < 11) {
      const role = formationDef.slots[i].role;
      if (role === "GK" && p.position !== "GK") return "Slot 1 must be a natural goalkeeper";
      if (role !== "GK" && p.position === "GK") return "A natural goalkeeper cannot occupy an outfield slot";
      if (!isEligible(p.position, role)) return `${p.name} is ineligible for ${role}`;
    }
  }
  if (input.penaltyTakerId !== null && !input.starters.includes(input.penaltyTakerId)) {
    return "Penalty taker must be in the starting eleven";
  }
  // Absent (undefined) means "leave as stored" — the free-kick taker control
  // was retired from the UI (no engine consumer exists), so a client that
  // never sends this field must not silently null out an existing value.
  const freeKickTakerId = input.freeKickTakerId === undefined ? (club.savedLineup?.freeKickTakerId ?? null) : input.freeKickTakerId;
  if (freeKickTakerId !== null && !input.starters.includes(freeKickTakerId)) {
    return "Free kick taker must be in the starting eleven";
  }
  club.tactics.formation = input.formation;
  club.penaltyTakerId = input.penaltyTakerId;
  club.savedLineup = { starters: input.starters, subs: input.subs, freeKickTakerId };
  return null;
}

/**
 * Repair a saved lineup whose players became unavailable (§9.3 sanitization).
 * Every still-valid player keeps his saved slot. For each invalid slot choose
 * the unused valid bench/squad candidate with the highest pair score for that
 * slot; tie by lower player ID. Does not rearrange other valid starters during
 * ordinary sanitization. Returns null only when no valid starting eleven can be
 * assembled; callers fall back to a fresh `buildLineup`. Deterministic.
 */
export function sanitizeSavedLineup(club: Club, allPlayers: Player[], saved: NonNullable<Club["savedLineup"]>): Lineup | null {
  const roster = allPlayers.filter((p) => p.clubId === club.id);
  const rosterById = new Map(roster.map((p) => [p.id, p]));
  const healthy = (id: number): Player | null => {
    const p = rosterById.get(id);
    return p && p.injuryDays === 0 && p.suspendedGames === 0 && !p.onSale ? p : null;
  };
  for (const player of allPlayers) {
    if (player.clubId === club.id) player.starter = false;
  }
  const formation = club.tactics.formation;
  const formationDef = formationById(formation);
  if (!formationDef) return null;
  const used = new Set<number>();
  // §9.3 "valid" = available, still owned, unique in the squad AND non-null in
  // the compatibility matrix for that EXACT slot (GK exclusivity included).
  // Checking only availability let a saved starter survive a formation change
  // into a slot his natural position cannot legally occupy.
  const slots: (Player | null)[] = formationDef.slots.map((slot, index) => {
    const id = saved.starters[index];
    if (id === undefined) return null;
    const p = healthy(id);
    if (!p || used.has(p.id) || !isEligible(p.position, slot.role)) return null;
    used.add(p.id);
    return p;
  });
  // Valid bench entries keep their relative order; starters win duplicates.
  const benchPool = saved.subs
    .map((id) => healthy(id))
    .filter((p): p is Player => !!p && !used.has(p.id))
    .filter((p, index, list) => list.findIndex((candidate) => candidate.id === p.id) === index);

  const availableSquad = () => roster.filter((p) => p.injuryDays === 0 && p.suspendedGames === 0 && !p.onSale && !used.has(p.id));
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]) continue;
    const role = formationDef.slots[i].role;
    // Highest pair score for this exact slot; tie by lower player ID.
    const candidates = [...benchPool, ...availableSquad()].filter((p) => currentScore(p, role) !== null);
    candidates.sort((a, b) => {
      const sa = currentScore(a, role)!;
      const sb = currentScore(b, role)!;
      if (Math.abs(sa - sb) > 1e-9) return sb - sa;
      return a.id - b.id;
    });
    const promoted = candidates[0];
    if (!promoted) continue;
    const poolIdx = benchPool.findIndex((p) => p.id === promoted.id);
    if (poolIdx >= 0) benchPool.splice(poolIdx, 1);
    used.add(promoted.id);
    slots[i] = promoted;
  }
  const starters = slots.filter((p): p is Player => !!p);
  if (starters.length < 11) return null;

  // Keep surviving valid bench entries in their saved order, then top up to
  // the squad size the user chose with the best remaining available players.
  const benchTarget = Math.min(11, saved.subs.length);
  const bench: Player[] = [...benchPool];
  const claimed = new Set(bench.map((p) => p.id));
  // §9.4 append order: adjusted best-role rating desc, energy desc, overall
  // desc, player ID asc.
  const bestRoleRating = (p: Player): number => {
    let best = -1;
    for (const role of BENCH_ARCHETYPES) {
      const rating = adjustedTacticalRating(p, role);
      if (rating !== null && rating > best) best = rating;
    }
    return best;
  };
  const topUp = availableSquad()
    .filter((p) => !claimed.has(p.id))
    .sort((a, b) =>
      bestRoleRating(b) - bestRoleRating(a) ||
      b.energy - a.energy ||
      b.overall - a.overall ||
      a.id - b.id,
    );
  while (bench.length < benchTarget && topUp.length > 0) {
    bench.push(topUp.shift()!);
  }
  starters.forEach((p) => { p.starter = true; });
  bench.forEach((p) => { p.starter = false; });
  return { starters, subs: bench, formation };
}

export function lineupForMatch(club: Club, allPlayers: Player[], options: { futureFixtures?: boolean } = {}): Lineup | null {
  for (const player of allPlayers) {
    if (player.clubId === club.id) player.starter = false;
  }
  const saved = club.savedLineup;
  if (saved && saved.starters.length !== 11) {
    return buildLineup(club, allPlayers, options);
  }
  if (saved) {
    const sanitized = sanitizeSavedLineup(club, allPlayers, saved);
    if (sanitized) return sanitized;
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

/**
 * Error string when the senior roster has no room for one more player, else
 * null. Every VOLUNTARY acquisition path calls this: transfer bids and their
 * settlement, free-agent bids and signings, loans in, and voluntary youth
 * promotion.
 *
 * Mandatory age promotion deliberately does NOT call this — it may exceed the
 * cap rather than release, list, or overwrite anyone.
 */
export function seniorRosterFullError(world: import("./types").World, clubId: number): string | null {
  return seniorRosterCount(world, clubId) >= SENIOR_SQUAD_LIMIT
    ? `Senior squad is full (${SENIOR_SQUAD_LIMIT} players)`
    : null;
}

/**
 * Error string while the club is ABOVE the senior cap, else null. Mandatory age
 * promotion can push a club into this temporary overflow; until the manager
 * resolves it by selling, loaning out, or releasing, renewals are blocked too.
 * Selling and releasing stay available so the overflow is always resolvable.
 */
export function seniorRosterOverflowError(world: import("./types").World, clubId: number): string | null {
  const count = seniorRosterCount(world, clubId);
  return count > SENIOR_SQUAD_LIMIT
    ? `Senior squad is over the limit (${count}/${SENIOR_SQUAD_LIMIT}); sell, loan out or release a player first`
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

export { overallFromSkills };
