// ---------------------------------------------------------------------------
// Tactical familiarity (plans/6. match-simulator-overhaul.md §17).
//
// Familiarity (0..100) is tracked PER TACTICAL SETUP, not per club: every
// formation × style × pressing × direction combination a club drills keeps its
// own familiarity and last-used game day in a sparse map on the club. This is
// what plan §17's switch-transfer formula presumes ("targetFamiliarity" is the
// setup you switch INTO) and it lets each drilled setup retain its progress.
//
// All tunables come from MATCH_SIMULATOR_CONFIG.tacticalFamiliarity; the only
// structural constant here is INITIAL_FAMILIARITY, which is the neutral center
// of the 0..100 scale that the centered tactical signals use as ((f-50)/50).
// ---------------------------------------------------------------------------

import { gameConfig } from "../config";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { FORMATION_POSITIONS, PRESSING_NAMES } from "./constants";
import type { Club, LiveTactics, Tactics } from "./types";

/** Neutral starting familiarity for setups never drilled (scale midpoint). */
export const INITIAL_FAMILIARITY = 50;
/** Storage hygiene cap: keep at most this many setups' progress per club. */
const MAX_TRACKED_SETUPS = 12;

export interface TacticFamiliarityEntry {
  /** Drilled familiarity 0..100 for this exact setup (already includes all
   *  growth applied at past match boundaries; decay is applied lazily). */
  familiarity: number;
  /** Absolute game day of the last real competitive match played with this
   *  setup. Null = never used (no decay before the first match). */
  lastUsedAbsoluteGameDay: number | null;
}

export type TacticFamiliarityMap = Record<string, TacticFamiliarityEntry>;

export interface TacticProjection {
  style: number;
  pressing: number;
  direction: number;
  familiarity: number;
}

export interface SetupKeyed {
  formation: number;
  style: number;
  pressing: number;
  direction: number;
}

/** Canonical comparison form: style/direction as indices, pressing normalized
 *  0..1 so the club's integer scale (0..PRESSING_NAMES.length-1) and the live
 *  engine's continuous scale are comparable. */
export interface CanonicalSetup {
  formation: number;
  style: number;
  pressing: number;
  direction: number;
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function setupKey(tactics: SetupKeyed): string {
  return `${tactics.formation}-${tactics.style}-${tactics.pressing}-${tactics.direction}`;
}

export function canonicalFromClub(tactics: Tactics): CanonicalSetup {
  const maxPressing = Math.max(1, PRESSING_NAMES.length - 1);
  return {
    formation: tactics.formation,
    style: tactics.style,
    pressing: tactics.pressing / maxPressing,
    direction: tactics.direction,
  };
}

export function canonicalFromLive(tactics: LiveTactics): CanonicalSetup {
  return {
    formation: tactics.formation,
    style: tactics.style === "COUNTER" ? 2 : tactics.style === "PRESS" ? 1 : 0,
    pressing: Math.max(0, Math.min(1, tactics.pressing)),
    direction: tactics.direction === "WIDE" ? 1 : 0,
  };
}

/** Map key for an already-canonical setup (denormalizes pressing to the
 *  club's integer scale), so live-engine setups can address the same
 *  per-setup progress rows the persistent /club/tactics path writes. */
export function setupKeyFromCanonical(setup: CanonicalSetup): string {
  const maxPressing = Math.max(1, PRESSING_NAMES.length - 1);
  return `${setup.formation}-${setup.style}-${Math.round(setup.pressing * maxPressing)}-${setup.direction}`;
}

/**
 * Similarity between two setups in [0,1]: weighted mean of style equality,
 * pressing closeness, direction equality and formation structural overlap
 * (multiset Jaccard over FORMATION_POSITIONS slot lists). Weights come from
 * config and are normalized so any non-negative combination is valid.
 */
export function setupSimilarity(a: CanonicalSetup, b: CanonicalSetup): number {
  const cfg = MS.tacticalFamiliarity.switchSimilarityWeights;
  const sum = cfg.formation + cfg.style + cfg.pressing + cfg.direction;
  if (sum <= 0) return 0;

  let weighted = 0;
  // Style / direction are categorical.
  weighted += cfg.style * (a.style === b.style ? 1 : 0);
  weighted += cfg.direction * (a.direction === b.direction ? 1 : 0);
  // Pressing is ordinal on the normalized 0..1 scale.
  weighted += cfg.pressing * (1 - Math.abs(a.pressing - b.pressing));
  // Formation overlap: multiset Jaccard of the tacPos slots each formation uses.
  weighted += cfg.formation * formationOverlap(a.formation, b.formation);

  return weighted / sum;
}

function formationOverlap(a: number, b: number): number {
  if (a === b) return 1;
  const slotsA = FORMATION_POSITIONS[a] ?? FORMATION_POSITIONS[4];
  const slotsB = FORMATION_POSITIONS[b] ?? FORMATION_POSITIONS[4];
  const countA = new Map<number, number>();
  for (const slot of slotsA) countA.set(slot, (countA.get(slot) ?? 0) + 1);
  const countB = new Map<number, number>();
  for (const slot of slotsB) countB.set(slot, (countB.get(slot) ?? 0) + 1);
  let intersection = 0;
  let union = 0;
  for (const slot of new Set([...countA.keys(), ...countB.keys()])) {
    const inA = countA.get(slot) ?? 0;
    const inB = countB.get(slot) ?? 0;
    intersection += Math.min(inA, inB);
    union += Math.max(inA, inB);
  }
  return union > 0 ? intersection / union : 0;
}

/** Per-game growth rate so a club reaches ~95% after one full season of games. */
function growthRate(): number {
  const gamesPerSeason = Math.max(1, gameConfig.roundsPerSeason);
  return 1 - Math.exp(-MS.tacticalFamiliarity.seasonTargetExponent / gamesPerSeason);
}

/** Decay a stored entry by the days idle since its last competitive match. */
function decayedFamiliarity(entry: TacticFamiliarityEntry, absoluteGameDay?: number | null): number {
  if (entry.lastUsedAbsoluteGameDay === null || typeof absoluteGameDay !== "number") return entry.familiarity;
  const daysIdle = Math.max(0, Math.trunc(absoluteGameDay) - entry.lastUsedAbsoluteGameDay);
  if (daysIdle === 0) return entry.familiarity;
  return entry.familiarity * Math.exp(-MS.tacticalFamiliarity.dailyUnusedDecay * daysIdle);
}

/** Sanitize an untrusted persisted map: drop malformed rows and clamp values. */
function sanitizeMap(map: unknown): TacticFamiliarityMap | undefined {
  if (!map || typeof map !== "object") return undefined;
  const out: TacticFamiliarityMap = {};
  let valid = false;
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const entry = value as Partial<TacticFamiliarityEntry> | null;
    if (!entry || typeof entry.familiarity !== "number" || !Number.isFinite(entry.familiarity)) continue;
    out[key] = {
      familiarity: clamp100(entry.familiarity),
      lastUsedAbsoluteGameDay:
        typeof entry.lastUsedAbsoluteGameDay === "number" && Number.isFinite(entry.lastUsedAbsoluteGameDay)
          ? Math.max(0, Math.trunc(entry.lastUsedAbsoluteGameDay))
          : null,
    };
    valid = true;
  }
  return valid ? out : undefined;
}

/**
 * Effective familiarity for the club's CURRENT setup with lazy idle decay
 * applied. Missing map or missing entry means never tracked => neutral 50.
 * Pure read: never mutates the club, so repeated reads cannot double-decay.
 */
export function effectiveFamiliarity(club: Pick<Club, "tactics" | "tacticFamiliarity">, absoluteGameDay?: number): number {
  const entry = sanitizeMap(club.tacticFamiliarity)?.[setupKey(club.tactics)];
  if (!entry) return INITIAL_FAMILIARITY;
  return clamp100(decayedFamiliarity(entry, absoluteGameDay));
}

/**
 * Apply plan §17 growth for ONE completed real competitive match to the club's
 * current setup: lazy-decay first, then grow toward 100, then stamp usage day.
 * Mutates the club's map. Called once per finalized fixture from the world's
 * single transaction, so it is idempotent at the save boundary.
 */
export function applyMatchFamiliarity(club: Club, absoluteGameDay: number): void {
  const key = setupKey(club.tactics);
  const map = sanitizeMap(club.tacticFamiliarity) ?? {};
  const entry = map[key] ?? { familiarity: INITIAL_FAMILIARITY, lastUsedAbsoluteGameDay: null };
  const current = decayedFamiliarity(entry, absoluteGameDay);
  const grown = current + (100 - current) * growthRate();
  map[key] = { familiarity: round2(clamp100(grown)), lastUsedAbsoluteGameDay: Math.max(0, Math.trunc(absoluteGameDay)) };
  club.tacticFamiliarity = pruneMap(map, key);
}

/**
 * Plan §17 switch transfer when moving from `srcSetup` (currently executed at
 * `srcFamiliarity`) into `dstSetup`. The target starts from the better of the
 * configured start floor and its own decayed stored progress, then receives
 * partial credit proportional to similarity:
 *
 *   base     = max(switchStartFloor, decayedExisting(target))
 *   transfer = max(0, src - base) * similarity(src, dst) * coefficient
 *   result   = min(100, base + transfer)
 *
 * `dstDecayed` passes the target setup's stored progress (already lazily
 * decayed), or null when the target was never drilled.
 */
export function switchFamiliarity(
  srcFamiliarity: number,
  srcSetup: CanonicalSetup,
  dstSetup: CanonicalSetup,
  dstDecayed: number | null
): number {
  const cfg = MS.tacticalFamiliarity;
  const base = Math.max(cfg.switchStartFloor, dstDecayed !== null && Number.isFinite(dstDecayed) ? dstDecayed : 0);
  const transfer = Math.max(0, srcFamiliarity - base) * setupSimilarity(srcSetup, dstSetup) * cfg.switchTransferCoefficient;
  return round2(clamp100(base + transfer));
}

/**
 * Compute the projected familiarity for every style × pressing × direction
 * combination under `formation`, as seen from `srcSetup` executing at
 * `srcFamiliarity`. Server-authoritative so clients never duplicate the math.
 */
export function projectSetups(
  srcFamiliarity: number,
  srcSetup: CanonicalSetup,
  formation: number,
  styleCount: number,
  pressingCount: number,
  directionCount: number,
  lookupDstDecayed: (style: number, pressing: number, direction: number) => number | null
): TacticProjection[] {
  const projections: TacticProjection[] = [];
  for (let style = 0; style < styleCount; style++) {
    for (let pressing = 0; pressing < pressingCount; pressing++) {
      for (let direction = 0; direction < directionCount; direction++) {
        const dstSetup: CanonicalSetup = { formation, style, pressing: pressing / Math.max(1, pressingCount - 1), direction };
        projections.push({
          style,
          pressing,
          direction,
          familiarity: switchFamiliarity(srcFamiliarity, srcSetup, dstSetup, lookupDstDecayed(style, pressing, direction)),
        });
      }
    }
  }
  return projections;
}

/**
 * Look up the lazily-decayed stored familiarity of an arbitrary setup key on a
 * club's map, or null when never drilled. Used by switch paths and projections.
 */
export function decayedStoredFamiliarity(
  map: TacticFamiliarityMap | undefined | null,
  key: string,
  absoluteGameDay?: number
): number | null {
  const entry = sanitizeMap(map)?.[key];
  if (!entry) return null;
  return round2(clamp100(decayedFamiliarity(entry, absoluteGameDay)));
}

/**
 * Record the result of a persistent tactic switch on the club's map: the
 * destination gains its transferred value (keeping its prior usage anchor),
 * while every other setup — including the abandoned one — keeps its stored
 * progress so switching back later resumes from history rather than resetting.
 */
export function recordSwitch(club: Club, nextTactics: Tactics, nextValue: number): void {
  const map = sanitizeMap(club.tacticFamiliarity) ?? {};
  const dstKey = setupKey(nextTactics);
  const existing = map[dstKey];
  map[dstKey] = {
    familiarity: nextValue,
    // Keep the old usage anchor: idle time already priced via decayedStoredFamiliarity.
    lastUsedAbsoluteGameDay: existing?.lastUsedAbsoluteGameDay ?? null,
  };
  club.tacticFamiliarity = pruneMap(map, dstKey);
}

/** Cap map size, evicting the least-familiar setups other than `keepKey`. */
function pruneMap(map: TacticFamiliarityMap, keepKey: string): TacticFamiliarityMap {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_SETUPS) return map;
  const excess = keys.length - MAX_TRACKED_SETUPS;
  const evictable = keys
    .filter((key) => key !== keepKey)
    .sort((a, b) => map[a].familiarity - map[b].familiarity || (map[a].lastUsedAbsoluteGameDay ?? 0) - (map[b].lastUsedAbsoluteGameDay ?? 0));
  for (let i = 0; i < Math.min(excess, evictable.length); i++) delete map[evictable[i]];
  return map;
}
