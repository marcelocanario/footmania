import { configuredUtcHour, gameConfig, type GameConfig } from "../config";

export type SeasonPhase = "ACTIVE" | "POST_MATCH" | "INTERSEASON";

export interface CalendarValues {
  roundsPerSeason: number;
  matchSpacingDays: number;
  lastLeagueMatchDayIndex: number;
  seasonDays: number;
  interseasonDays: number;
  interseasonAfterMatchDays: number;
  interseasonBeforeNextSeasonDays: number;
  postMatchStartIndex: number;
  interseasonStartIndex: number;
  preparationStartIndex: number;
}

export interface SeasonScheduleEntry {
  seasonDayIndex: number;
  seasonDay: number;
  label: string;
  round: number | null;
  phase: SeasonPhase;
  payroll: boolean;
  weeklySimulation: boolean;
}

export function calendarValues(config: Pick<GameConfig, "league" | "interseasonDays" | "interseasonAfterMatchDays" | "interseasonBeforeNextSeasonDays" | "seasonDays" | "roundsPerSeason" | "matchSpacingDays" | "lastLeagueMatchDayIndex"> = gameConfig): CalendarValues {
  const interseasonStartIndex = config.lastLeagueMatchDayIndex + 1 + config.interseasonAfterMatchDays;
  const preparationStartIndex = config.seasonDays - config.interseasonBeforeNextSeasonDays;
  if (interseasonStartIndex !== preparationStartIndex) {
    throw new Error("Inter-season calendar boundaries do not agree");
  }
  return {
    roundsPerSeason: config.roundsPerSeason,
    matchSpacingDays: config.matchSpacingDays,
    lastLeagueMatchDayIndex: config.lastLeagueMatchDayIndex,
    seasonDays: config.seasonDays,
    interseasonDays: config.interseasonDays,
    interseasonAfterMatchDays: config.interseasonAfterMatchDays,
    interseasonBeforeNextSeasonDays: config.interseasonBeforeNextSeasonDays,
    postMatchStartIndex: config.lastLeagueMatchDayIndex + 1,
    interseasonStartIndex,
    preparationStartIndex,
  };
}

export function roundDayIndex(roundIndex: number, config = gameConfig): number {
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= config.roundsPerSeason) {
    throw new Error(`Invalid league round index: ${roundIndex}`);
  }
  return config.league.startDay + roundIndex * config.matchSpacingDays;
}

export function leagueMatchDayIndices(config = gameConfig): number[] {
  return Array.from({ length: config.roundsPerSeason }, (_, roundIndex) => roundDayIndex(roundIndex, config));
}

export function roundForSeasonDayIndex(seasonDayIndex: number, config = gameConfig): number | null {
  const offset = seasonDayIndex - config.league.startDay;
  if (offset < 0 || offset % config.matchSpacingDays !== 0) return null;
  const round = offset / config.matchSpacingDays;
  return round >= 0 && round < config.roundsPerSeason ? round : null;
}

export function phaseForSeasonDayIndex(seasonDayIndex: number, config = gameConfig): SeasonPhase {
  if (seasonDayIndex < 0 || seasonDayIndex >= config.seasonDays) throw new Error(`Invalid season day index: ${seasonDayIndex}`);
  if (seasonDayIndex <= config.lastLeagueMatchDayIndex) return "ACTIVE";
  return seasonDayIndex < calendarValues(config).interseasonStartIndex ? "POST_MATCH" : "INTERSEASON";
}

export function daysForSeasons(seasons: number, config = gameConfig): number {
  if (!Number.isFinite(seasons) || seasons < 0) throw new Error("seasons must be non-negative");
  return Math.round(seasons * config.seasonDays);
}

export function seasonDayIndexForAbsoluteGameDay(absoluteGameDay: number, startAbsoluteGameDay: number, config = gameConfig): number {
  const index = absoluteGameDay - startAbsoluteGameDay;
  if (index < 0 || index >= config.seasonDays) throw new Error(`Absolute game day ${absoluteGameDay} is outside the season`);
  return index;
}

export function scheduledMatchAt(seasonStartAt: Date | number, seasonDayIndex: number, config = gameConfig): number {
  const start = seasonStartAt instanceof Date ? seasonStartAt.getTime() : seasonStartAt;
  return start + seasonDayIndex * 24 * 60 * 60 * 1000 + configuredUtcHour(config.scheduler.leagueMatchStartUtc) * 60 * 60 * 1000;
}

export function payrollDayIndices(config = gameConfig): number[] {
  return Array.from({ length: Math.floor(config.seasonDays / 7) }, (_, i) => (i + 1) * 7 - 1);
}

export function seasonSchedulePreview(config = gameConfig): SeasonScheduleEntry[] {
  const payroll = new Set(payrollDayIndices(config));
  return Array.from({ length: config.seasonDays }, (_, seasonDayIndex) => {
    const roundIndex = roundForSeasonDayIndex(seasonDayIndex, config);
    const phase = phaseForSeasonDayIndex(seasonDayIndex, config);
    return {
      seasonDayIndex,
      seasonDay: seasonDayIndex + 1,
      label: roundIndex === null
        ? phase === "POST_MATCH" ? "Post-match buffer" : phase === "INTERSEASON" ? "Inter-season / preparation" : seasonDayIndex === 0 ? "Preparation" : "Rest"
        : `Round ${roundIndex + 1}`,
      round: roundIndex === null ? null : roundIndex + 1,
      phase,
      payroll: payroll.has(seasonDayIndex),
      weeklySimulation: payroll.has(seasonDayIndex),
    };
  });
}

/** Small stateless facade used by domain services and admin previews. */
export class SeasonCalendarService {
  constructor(public readonly config: GameConfig = gameConfig) {}

  values(): CalendarValues {
    return calendarValues(this.config);
  }

  daysForSeasons(seasons: number): number {
    return daysForSeasons(seasons, this.config);
  }

  matchDayIndices(): number[] {
    return leagueMatchDayIndices(this.config);
  }

  phase(seasonDayIndex: number): SeasonPhase {
    return phaseForSeasonDayIndex(seasonDayIndex, this.config);
  }

  preview(): SeasonScheduleEntry[] {
    return seasonSchedulePreview(this.config);
  }
}

export const seasonCalendar = new SeasonCalendarService();
