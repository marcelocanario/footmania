import type { PrismaClient } from "@prisma/client";
import type { SeasonHistoryEntry } from "../game/types";
import { seasonKey } from "../game/clock";
import { calendarValues, phaseForSeasonDayIndex } from "./seasonCalendar";

type MpStateView = {
  seasonId?: number;
  seasonYear?: number;
  seasonMonth?: number;
  seasonNumber?: number;
  seasonStatus?: string;
  completedRounds?: number;
  joinLockRound?: number;
  joinState?: "OPEN" | "LOCKED";
  seasonDayIndex?: number;
  phase?: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function globalSave(prisma: PrismaClient) {
  return prisma.save.findFirst({
    where: { isGlobal: true },
    select: { id: true, revision: true, year: true, dayIndex: true, mpStateJson: true },
  });
}

/** Build the small status response without rebuilding the global World. */
export async function readMpStatus(prisma: PrismaClient, userId: number) {
  const save = await globalSave(prisma);
  if (!save) return { ready: false as const, saveId: null };

  const mp = parseJson<MpStateView>(save.mpStateJson, {});
  const seasonDayIndex = mp.seasonDayIndex ?? save.dayIndex;
  const club = await prisma.club.findFirst({
    where: { saveId: save.id, ownerUserId: userId },
    select: {
      id: true,
      name: true,
      shortName: true,
      country: true,
      highestDivision: true,
      cash: true,
      competitionState: true,
      timezone: true,
      preferredHoursJson: true,
      abandonmentEligibleAt: true,
    },
  });
  const reservedAllocation = club
    ? await prisma.mpAllocation.findFirst({
        where: { clubId: club.id, seasonId: { gt: mp.seasonId ?? 0 }, type: "PROVISIONAL_NEXT_SEASON" },
        orderBy: { seasonId: "asc" },
        select: { seasonId: true, amount: true, issuedAt: true },
      })
    : null;
  const calendar = calendarValues();
  const year = mp.seasonYear ?? save.year;
  const month = mp.seasonMonth ?? 1;

  return {
    ready: true as const,
    saveId: save.id,
    season: {
      seasonNumber: mp.seasonNumber ?? 1,
      key: seasonKey({ year, month }),
      year,
      month,
      status: mp.seasonStatus ?? "ACTIVE",
      completedRounds: mp.completedRounds ?? 0,
      joinLockRound: mp.joinLockRound ?? 0,
      joinState: mp.joinState ?? "OPEN",
      seasonDayIndex,
      seasonDay: seasonDayIndex + 1,
      seasonDays: calendar.seasonDays,
      phase: mp.phase ?? phaseForSeasonDayIndex(seasonDayIndex),
      interseasonAfterMatchDays: calendar.interseasonAfterMatchDays,
      interseasonBeforeNextSeasonDays: calendar.interseasonBeforeNextSeasonDays,
      lastLeagueMatchDayIndex: calendar.lastLeagueMatchDayIndex,
      interseasonStartIndex: calendar.interseasonStartIndex,
      preparationStartIndex: calendar.preparationStartIndex,
    },
    userClubId: club?.id ?? null,
    club: club
      ? {
          id: club.id,
          name: club.name,
          shortName: club.shortName,
          country: club.country,
          highestDivision: club.highestDivision,
          cash: club.cash,
          competitionState: club.competitionState,
          timezone: club.timezone,
          preferredHours: parseJson<number[] | null>(club.preferredHoursJson, null),
          reservedNextSeasonAllocation: reservedAllocation
            ? { seasonId: reservedAllocation.seasonId, amount: reservedAllocation.amount, issuedAt: reservedAllocation.issuedAt.getTime() }
            : null,
          inactivity: {
            eligible: club.abandonmentEligibleAt !== null,
            removedAtRollover: club.abandonmentEligibleAt !== null,
            note: club.abandonmentEligibleAt !== null
              ? "Your club may lose its league position at the end of the season if inactivity continues."
              : null,
          },
        }
      : null,
  };
}

/** Return only the requesting user's active live match. */
export async function readUserLiveMatch(prisma: PrismaClient, userId: number) {
  const save = await globalSave(prisma);
  if (!save) return null;
  const club = await prisma.club.findFirst({
    where: { saveId: save.id, ownerUserId: userId },
    select: { id: true },
  });
  if (!club) return { match: null };

  const live = await prisma.liveMatch.findFirst({
    where: { saveId: save.id, OR: [{ homeClubId: club.id }, { awayClubId: club.id }] },
    select: { matchId: true, homeClubId: true, awayClubId: true, stateJson: true },
  });
  if (!live?.homeClubId || !live.awayClubId) return { match: null };

  const clubs = await prisma.club.findMany({
    where: { saveId: save.id, id: { in: [live.homeClubId, live.awayClubId] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(clubs.map((item) => [item.id, item.name]));
  return {
    match: {
       id: live.matchId,
       home: nameById.get(live.homeClubId) ?? "",
       away: nameById.get(live.awayClubId) ?? "",
    },
  };
}

/** Read immutable season history without rebuilding the global World. */
export async function readSeasonHistory(prisma: PrismaClient, userId: number, limit: number) {
  const save = await prisma.save.findFirst({
    where: { isGlobal: true },
    select: { id: true, seasonHistoryJson: true },
  });
  if (!save) return null;
  const club = await prisma.club.findFirst({ where: { saveId: save.id, ownerUserId: userId }, select: { id: true } });
  const history = parseJson<SeasonHistoryEntry[]>(save.seasonHistoryJson, []);
  const seasons = history.slice(-limit).reverse().map((season) => ({
    ...season,
    divisions: season.divisions.map((division) => ({
      ...division,
      standings: division.standings.map((row) => ({ ...row, isMine: row.clubId === club?.id })),
    })),
  }));
  return { seasons };
}
