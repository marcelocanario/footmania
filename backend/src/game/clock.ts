import { gameConfig, MP_CONFIG } from "../config";
import { roundForSeasonDayIndex, roundDayIndex, scheduledMatchAt, phaseForSeasonDayIndex } from "../services/seasonCalendar";

/**
 * Server-authoritative global clock (plans/1. multiplayer.md §3).
 *
 * Time model:
 * Civil year/month values are retained only for display and legacy persistence.
 * Competition timing uses the season start instant plus the derived game-day
 * index, so February and month lengths have no football meaning.
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
  return roundForSeasonDayIndex(dayOfMonth, gameConfig) !== null;
}

/** The round (1-based) played on `dayOfMonth`. Returns null when not a match day. */
export function roundForDay(dayOfMonth: number): number | null {
  const round = roundForSeasonDayIndex(dayOfMonth, gameConfig);
  return round === null ? null : round + 1;
}

/** The last match day of the season (day-of-month) under the configured calendar. */
export function lastMatchDayOfMonth(year: number, month: number): number {
  void year;
  void month;
  return gameConfig.lastLeagueMatchDayIndex + 1;
}

/** Kickoff timestamp (epoch ms) for round `round` (1-based) of a season. */
export function kickoffForRound(ref: { year: number; month: number; seasonStartAt?: number }, round: number, hourUtc: number = configuredKickoffHour()): number {
  const start = "startsAt" in ref ? (ref as SeasonRef).startsAt : ("seasonStartAt" in ref ? Number((ref as { seasonStartAt: number }).seasonStartAt) : Date.UTC(ref.year, ref.month - 1, 1));
  const dayIndex = roundDayIndex(round - 1, gameConfig);
  if (hourUtc === configuredKickoffHour()) return scheduledMatchAt(start, dayIndex, gameConfig);
  return start + dayIndex * 24 * 60 * 60 * 1000 + hourUtc * 60 * 60 * 1000;
}

/**
 * Convert a configured local kickoff into a UTC instant.  The calculation is
 * deliberately done for the scheduled date (rather than using the current
 * offset), so DST changes are handled correctly and the resulting timestamp is
 * stable after it has been persisted on the fixture.
 */
export function kickoffForRoundInTimezone(
  ref: { year: number; month: number; seasonStartAt?: number },
  round: number,
  timeZone: string | null | undefined,
  localHour: number = configuredKickoffHour(),
): number {
  if (!timeZone) return kickoffForRound(ref, round, localHour);
  const dayIndex = roundDayIndex(round - 1, gameConfig);
  const seasonStart = ref.seasonStartAt ?? Date.UTC(ref.year, ref.month - 1, 1);
  const seasonDate = new Date(seasonStart + dayIndex * 24 * 60 * 60 * 1000);
  const localWallClock = Date.UTC(seasonDate.getUTCFullYear(), seasonDate.getUTCMonth(), seasonDate.getUTCDate(), localHour, 0, 0);
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
export function currentRound(ref: SeasonRef, now: number, kickoffHourUtc: number = configuredKickoffHour()): number {
  const rounds = gameConfig.roundsPerSeason;
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
export function completedRounds(ref: SeasonRef, now: number, kickoffHourUtc: number = configuredKickoffHour()): number {
  return currentRound(ref, now, kickoffHourUtc);
}

export function joinLockRound(): number {
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  return Math.floor(rounds * MP_CONFIG.joinThresholdPercent);
}

/** Season status string for a given instant. */
export function seasonStatusFor(ref: SeasonRef, now: number, kickoffHourUtc: number = configuredKickoffHour()): "PREPARATION" | "ACTIVE" | "INTERSEASON" | "ROLLOVER" | "COMPLETE" {
  if (now < ref.startsAt) return "PREPARATION";
  const dayIndex = Math.floor((now - ref.startsAt) / (24 * 60 * 60 * 1000));
  if (dayIndex >= gameConfig.seasonDays) return "COMPLETE";
  return phaseForSeasonDayIndex(dayIndex, gameConfig);
}

export function isSeasonOver(ref: SeasonRef, now: number): boolean {
  return now >= ref.endsAt;
}

/** UTC day key (yyyymmdd) used to make daily ticks idempotent. */
export function utcDayKey(date: Date): number {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function configuredKickoffHour(): number {
  return Number(gameConfig.scheduler.leagueMatchStartUtc.slice(0, 2));
}
