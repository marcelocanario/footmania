import { gameConfig, MP_CONFIG } from "../config";
import { roundForSeasonDayIndex } from "../services/seasonCalendar";

/**
 * Server-authoritative global clock (plans/1. multiplayer.md §3).
 *
 * Time model:
 * Civil year/month values are retained only for display and legacy persistence.
 * Competition timing uses the season start instant plus the derived game-day
 * index, so February and month lengths have no football meaning.
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

/** The round (1-based) played on a season day index. Returns null when not a match day. */
export function roundForDay(seasonDayIndex: number): number | null {
  const round = roundForSeasonDayIndex(seasonDayIndex, gameConfig);
  return round === null ? null : round + 1;
}

export function joinLockRound(): number {
  const rounds = gameConfig.league.turns * (gameConfig.league.teams - 1);
  return Math.floor(rounds * MP_CONFIG.joinThresholdPercent);
}
