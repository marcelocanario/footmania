/**
 * Pacing for a human-vs-AI match. The engine advances a configurable number of
 * in-game minutes per tick; the frontend paces those ticks in real time so the
 * whole match lasts roughly `durationMinutes` of wall-clock time.
 *
 * The delay is the real-time budget per in-game minute. Fast-forward resolves
 * several minutes per request at the same delay, so it plays ~3x faster than
 * the configured pace while keeping the pitch readable.
 */

/** In-game minutes in a regulation match (used to derive the per-minute delay). */
export const MATCH_MINUTES = 90;

/** Floor so a very short setting can't spam the server. */
export const MIN_TICK_MS = 600;

/** Ceiling so an extreme setting still keeps the match tickable. */
export const MAX_TICK_MS = 120000;

/** Real-time delay (ms) between ticks for a given configured match duration. */
export function tickDelayMs(durationMinutes: number): number {
  const safe = Math.max(1, Math.min(60, Math.round(durationMinutes)));
  const perMinute = (safe * 60_000) / MATCH_MINUTES;
  return Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, Math.round(perMinute)));
}

/** Human-readable description of how long a match takes at the chosen setting. */
export function matchDurationLabel(minutes: number): string {
  const safe = Math.max(1, Math.min(60, Math.round(minutes)));
  return `${safe} min`;
}
