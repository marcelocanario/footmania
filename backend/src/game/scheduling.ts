import { MP_CONFIG } from "../config";
import { DAY_MS } from "../services/dayBoundary";

/**
 * Preferred-time fixture scheduling.
 *
 * Game days and rounds are fixed by the season calendar; only the intra-day
 * kickoff varies. The day is divided into `MP_CONFIG.slotsPerDay` half-hour
 * slots on a UTC grid; each club's preferences are half-hour buckets on that
 * same UTC grid (clients convert from/to the user's browser timezone at the
 * edges — the server never stores a timezone). Distances are circular
 * (midnight wraps), so 23:30 is one slot away from 00:00.
 *
 * One game day is one boundary-to-boundary span of the authoritative
 * dayBoundary grid (services/dayBoundary.ts), so `dayStart` anchors passed to
 * the pickers below are always boundary instants.
 *
 * Objective per fixture (lexicographic):
 *   1. minimize the home club's distance to its preferred windows;
 *   2. then the away club's distance;
 *   3. ties resolve pseudo-randomly, seeded from stable fixture identity
 *      (competition/round/clubs) so retries cannot reroll the outcome;
 *   4. hash collisions fall back to the earliest slot.
 *
 * The seeded tie-break spreads unconstrained fixtures (AI vs AI scores 0
 * everywhere) across the whole day instead of stacking every kickoff on one
 * instant, smoothing MATCH_START worker load per round.
 *
 * The final round of a season is synchronized per division/group: one slot is
 * chosen to minimize the summed home distances first, then summed away
 * distances, so every club in the group kicks off together.
 *
 * Clubs without preferences (AI fillers and legacy humans) are unconstrained:
 * their distance is 0 everywhere, so they never distort the optimum but do
 * participate in the seeded spread.
 */

/** Scheduling flexibility of one club. */
export interface PreferenceInput {
  /** Selected half-hour slot indices on the UTC grid (0 = 00:00–00:30 UTC). */
  preferredSlots: number[] | null | undefined;
}

const MS_PER_SLOT = MP_CONFIG.preferredSlotMinutes * 60 * 1000;

/** Half-hour bucket (0..47) of the UTC wall-clock time of `at`. */
export function utcSlotAt(at: number): number {
  const date = new Date(at);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return Math.floor(utcMinutes / MP_CONFIG.preferredSlotMinutes);
}

/**
 * Re-anchor an unplayed, not-yet-kicked-off fixture into its own game day.
 * `seasonStartAt` is the boundary-aligned anchor of Season Day 1; the fixture
 * lands on `seasonStartAt + dayIndex * DAY_MS` plus its ORIGINAL half-hour
 * UTC slot, so the slot is preserved exactly while the day it belongs to
 * becomes its own game day. Used by the game-day-boundary repair migration —
 * one source of truth for "which instant a fixture belongs on". (The
 * launch-hold lift instead RE-TIMES fixtures against the completed roster via
 * retimeDivisionFixtures, which supersedes slot preservation there.)
 */
export function realignFixtureKickoff(fixture: { kickoffAt?: number; scheduledSeasonDayIndex?: number; dayIndex: number }, seasonStartAt: number): number {
  const day = fixture.scheduledSeasonDayIndex ?? fixture.dayIndex;
  const dayStart = seasonStartAt + day * DAY_MS;
  const slot = utcSlotAt(fixture.kickoffAt ?? dayStart);
  return dayStart + slot * MS_PER_SLOT;
}

/**
 * Circular distance in half-hour slots from `at`'s UTC slot to the nearest
 * preferred slot. Unconstrained preferences (null/empty) score 0 everywhere.
 */
export function preferenceDistance(preferredSlots: PreferenceInput["preferredSlots"], at: number): number {
  if (!preferredSlots || preferredSlots.length === 0) return 0;
  const slot = utcSlotAt(at);
  let best = Infinity;
  for (const p of preferredSlots) {
    const raw = Math.abs(slot - p);
    best = Math.min(best, raw, MP_CONFIG.slotsPerDay - raw);
  }
  return best;
}

/** Candidate kickoff instants: every half-hour of the given game day (UTC grid). */
export function candidateKickoffs(dayStartMs: number): number[] {
  return Array.from({ length: MP_CONFIG.slotsPerDay }, (_, slot) => dayStartMs + slot * MS_PER_SLOT);
}

/**
 * Stable 32-bit FNV-1a hash. Deterministic "noise" for tie-breaks: seeded
 * from stable identity strings so a restart or regeneration retry cannot
 * reroll a different kickoff. Also exported for other modules that need a
 * seed derived from stable identity (e.g. fixture ordering).
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash >>> 0;
}

interface ScoredCandidate {
  slot: number;
  home: number;
  away: number;
  jitter: number;
}

function scoreCandidates(dayStartMs: number, seedKey: string, pairs: { home: PreferenceInput; away: PreferenceInput }[]): ScoredCandidate[] {
  return candidateKickoffs(dayStartMs).map((at, slot) => ({
    slot,
    home: pairs.reduce((sum, pair) => sum + preferenceDistance(pair.home.preferredSlots, at), 0),
    away: pairs.reduce((sum, pair) => sum + preferenceDistance(pair.away.preferredSlots, at), 0),
    // Per-slot pseudo-random priority: among equally-preferred slots the
    // winner is uniform over them, unique per fixture identity.
    jitter: stableHash(`${seedKey}:${slot}`),
  }));
}

function bestCandidate(candidates: ScoredCandidate[]): ScoredCandidate {
  return candidates.reduce((best, c) => {
    if (c.home !== best.home) return c.home < best.home ? c : best;
    if (c.away !== best.away) return c.away < best.away ? c : best;
    if (c.jitter !== best.jitter) return c.jitter < best.jitter ? c : best;
    return c.slot < best.slot ? c : best;
  });
}

/** Best kickoff instant for one fixture (home priority, then away, then seeded spread). */
export function pickFixtureKickoff(home: PreferenceInput, away: PreferenceInput, dayStartMs: number, seedKey: string): number {
  const winner = bestCandidate(scoreCandidates(dayStartMs, seedKey, [{ home, away }]));
  return dayStartMs + winner.slot * MS_PER_SLOT;
}

/**
 * Single synchronized kickoff for every fixture of a group's final round:
 * minimize summed home distance first, then summed away distance, then seeded
 * spread, then earliest slot.
 */
export function pickSynchronizedKickoff(pairs: { home: PreferenceInput; away: PreferenceInput }[], dayStartMs: number, seedKey: string): number {
  const winner = bestCandidate(scoreCandidates(dayStartMs, seedKey, pairs));
  return dayStartMs + winner.slot * MS_PER_SLOT;
}

/**
 * Validate user-supplied preferred slots. Accepts any iterable of integers in
 * [0, slotsPerDay); duplicates are collapsed; returns the sorted slot list or
 * null when the input is malformed or below the minimum coverage.
 */
export function validatePreferredHours(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<number>();
  for (const value of input) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= MP_CONFIG.slotsPerDay) return null;
    seen.add(value);
  }
  const slots = [...seen].sort((a, b) => a - b);
  return slots.length >= MP_CONFIG.minPreferredSlots ? slots : null;
}
