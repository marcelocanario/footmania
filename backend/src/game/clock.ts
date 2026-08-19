import { gameConfig, MP_CONFIG } from "../config";

/**
 * Server-authoritative global clock (plans/1. multiplayer.md §3).
 *
 * Time model:
 * - A season is one calendar month (e.g. 2026-08).
 * - A season starts on the first day of the month.
 * - Rounds play on days 1, 3, 5, ..., 27 (14 rounds, one every other day).
 * - The remaining days of the month are the interseason period.
 * - Kickoffs are at a fixed UTC hour (GLOBAL_FIXED mode).
 */
export interface SeasonRef {
  year: number;
  month: number; // 1..12
  startsAt: number; // epoch ms (first instant of month, UTC)
  endsAt: number; // epoch ms (first instant of next month, UTC)
}

export function seasonRefFor(date: Date): SeasonRef {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startsAt = Date.UTC(year, month - 1, 1);
  const endsAt = Date.UTC(month === 12 ? year + 1 : year, month % 12, 1);
  return { year, month, startsAt, endsAt };
}

export function seasonKey(ref: { year: number; month: number }): string {
  return `${ref.year}-${String(ref.month).padStart(2, "0")}`;
}

export function parseSeasonKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** UTC day-of-month (1..31) for a given instant. */
export function utcDayOfMonth(date: Date): number {
  return date.getUTCDate();
}

/** True when `dayOfMonth` is a league round day under the round interval. */
export function isMatchDay(dayOfMonth: number): boolean {
  return (dayOfMonth - gameConfig.league.startDay) % gameConfig.league.matchIntervalDays === 0;
}

/** The round (1-based) played on `dayOfMonth`. Returns null when not a match day. */
export function roundForDay(dayOfMonth: number): number | null {
  if (!isMatchDay(dayOfMonth)) return null;
  return Math.floor((dayOfMonth - gameConfig.league.startDay) / gameConfig.league.matchIntervalDays) + 1;
}

/** The last match day of the season (day-of-month) under the configured calendar. */
export function lastMatchDayOfMonth(year: number, month: number): number {
  const startDay = gameConfig.league.startDay;
  const matchInterval = gameConfig.league.matchIntervalDays;
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Walk days of the month that fall on the round cadence and pick the last one
  // that is <= daysInMonth and yields round <= rounds.
  let last = startDay;
  for (let d = startDay; d <= daysInMonth; d += matchInterval) {
    const r = roundForDay(d);
    if (r !== null && r <= rounds) last = d;
  }
  return last;
}

/** Kickoff timestamp (epoch ms) for round `round` (1-based) of a season. */
export function kickoffForRound(ref: { year: number; month: number }, round: number, hourUtc: number = MP_CONFIG.matchKickoffHourUtc): number {
  const dayOfMonth = gameConfig.league.startDay + (round - 1) * gameConfig.league.matchIntervalDays;
  return Date.UTC(ref.year, ref.month - 1, dayOfMonth, hourUtc, 0, 0);
}

/**
 * Convert a configured local kickoff into a UTC instant.  The calculation is
 * deliberately done for the scheduled date (rather than using the current
 * offset), so DST changes are handled correctly and the resulting timestamp is
 * stable after it has been persisted on the fixture.
 */
export function kickoffForRoundInTimezone(
  ref: { year: number; month: number },
  round: number,
  timeZone: string | null | undefined,
  localHour: number = MP_CONFIG.matchKickoffHourUtc,
): number {
  if (!timeZone) return kickoffForRound(ref, round, localHour);
  const dayOfMonth = gameConfig.league.startDay + (round - 1) * gameConfig.league.matchIntervalDays;
  const localWallClock = Date.UTC(ref.year, ref.month - 1, dayOfMonth, localHour, 0, 0);
  try {
    // One correction is sufficient for normal DST transitions.  Re-read the
    // offset at the candidate instant because the offset on the local wall
    // clock can differ from today's offset.
    const first = localWallClock - timezoneOffsetMinutes(timeZone, localWallClock) * 60_000;
    return localWallClock - timezoneOffsetMinutes(timeZone, first) * 60_000;
  } catch {
    return kickoffForRound(ref, round, localHour);
  }
}

export function isValidIanaTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function timezoneOffsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(instant));
  const value = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** All scheduled round kickoff timestamps for a season. */
export function seasonKickoffs(ref: SeasonRef): number[] {
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  return Array.from({ length: rounds }, (_, i) => kickoffForRound(ref, i + 1));
}

/** The round currently in progress (0 when none), based on `now`. */
export function currentRound(ref: SeasonRef, now: number, kickoffHourUtc: number = MP_CONFIG.matchKickoffHourUtc): number {
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  for (let r = 1; r <= rounds; r++) {
    const k = kickoffForRound(ref, r, kickoffHourUtc);
    // A round is completed after its scheduled match window, not at the
    // instant kickoff begins. This keeps the join cutoff from opening a new
    // club while the seventh round is still being played.
    if (now >= k + MP_CONFIG.matchDurationMinutes * 60 * 1000) continue;
    return r - 1; // completed rounds so far
  }
  return rounds;
}

/** Round whose kickoff has already passed (completed count) — alias of currentRound. */
export function completedRounds(ref: SeasonRef, now: number, kickoffHourUtc: number = MP_CONFIG.matchKickoffHourUtc): number {
  return currentRound(ref, now, kickoffHourUtc);
}

export function joinLockRound(): number {
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  return Math.floor(rounds * MP_CONFIG.joinThresholdPercent);
}

/** Season status string for a given instant. */
export function seasonStatusFor(ref: SeasonRef, now: number, kickoffHourUtc: number = MP_CONFIG.matchKickoffHourUtc): "PREPARATION" | "ACTIVE" | "INTERSEASON" | "ROLLOVER" | "COMPLETE" {
  const lastMatch = lastMatchDayOfMonth(ref.year, ref.month);
  const lastKickoff = Date.UTC(ref.year, ref.month - 1, lastMatch, kickoffHourUtc, 0, 0) + MP_CONFIG.matchDurationMinutes * 60 * 1000;
  if (now < ref.startsAt) return "PREPARATION";
  if (now <= lastKickoff) return "ACTIVE";
  return "INTERSEASON";
}

export function isSeasonOver(ref: SeasonRef, now: number): boolean {
  return now >= ref.endsAt;
}

/** UTC day key (yyyymmdd) used to make daily ticks idempotent. */
export function utcDayKey(date: Date): number {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}
