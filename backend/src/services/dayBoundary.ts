import { gameConfig, configuredUtcMinuteOfDay } from "../config";

/**
 * The single authority on what a game day boundary is. No other module may
 * compute "the boundary" — the day-advance trigger, the pending
 * GAME_DAY_ADVANCE row, the fixture kickoff-grid anchor and the payroll grid
 * all derive from here, so they agree by construction.
 *
 * A game day starts at the configured `gameDayRolloverUtc` (HH:MM) past UTC
 * midnight — production is "00:00". Every boundary instant therefore carries
 * zero seconds and zero milliseconds; any timestamp that does not is the
 * fingerprint of a grid that has drifted (e.g. a resume shift that moved the
 * pending advance row by a raw millisecond delta).
 *
 * Kickoffs are on the 30-minute UTC grid (slot 0 = 00:00 UTC): a raw
 * seasonStartAt at 18:26 would produce 18:26/18:56 slots — fix by truncating
 * the anchor to the boundary before adding round offsets. Game days and
 * rounds stay fixed; only the intra-day kickoff varies. Because the kickoff
 * anchor and the boundary are one instant, the day-advance guard and the
 * fixtures it protects can never desync.
 */

/** Length of one game day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes past UTC midnight at which a game day starts (honours HH:MM). */
export function boundaryOffsetMinutes(): number {
  return configuredUtcMinuteOfDay(gameConfig.scheduler.gameDayRolloverUtc);
}

/** Start instant of the game day containing `ms`. Idempotent. */
export function dayBoundaryAtOrBefore(ms: number): number {
  const offset = boundaryOffsetMinutes() * 60 * 1000;
  return Math.floor((ms - offset) / DAY_MS) * DAY_MS + offset;
}

/** First boundary strictly after `ms`. */
export function nextDayBoundaryAfter(ms: number): number {
  return dayBoundaryAtOrBefore(ms) + DAY_MS;
}

/**
 * How many boundaries fall in (fromBoundaryMs, nowMs]. Returns 0 while
 * `fromBoundaryMs` is in the future — the launch hold relies on this: an
 * anchor at the next boundary must not fire an advance during
 * [resumedAt, seasonBoundary). Returns exactly 1 the moment `nowMs` reaches
 * the next boundary, so a deferred advance never skips a boundary.
 *
 * `fromBoundaryMs` is the aligned grid reference in every production caller;
 * the count is still exact if it is not (boundaries at or before `from` are
 * excluded by construction).
 */
export function boundariesElapsed(fromBoundaryMs: number, nowMs: number): number {
  if (nowMs <= fromBoundaryMs) return 0;
  const offset = boundaryOffsetMinutes() * 60 * 1000;
  return Math.floor((nowMs - offset) / DAY_MS) - Math.floor((fromBoundaryMs - offset) / DAY_MS);
}