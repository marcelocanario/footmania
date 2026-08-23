import type { PrismaClient } from "@prisma/client";
import type { Competition, SeasonHistoryEntry, World } from "../game/types";
import { seasonKey } from "../game/clock";
import { calendarValues, phaseForSeasonDayIndex, seasonSchedulePreview } from "./seasonCalendar";
import { preferredHoursFromClubRow } from "./saveService";
import { resolveClubKits } from "../game/kits";
import { standingsTiebreak } from "../game/league";
import { compDivisionName, divisionsInSeason, groupIndexOf, tierOf } from "../game/multiplayer";
import { POSITION_NAMES, TACTICAL_POSITION_NAMES } from "../game/constants";

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
      friendGroupingOptIn: true,
      preferredHoursJson: true,
      // Read with the legacy marker so read paths can apply the same one-time
      // local→UTC slot conversion as rebuildWorld (plan 9).
      timezone: true,
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

  // The stored completed-round counter is only advanced by the admin manual
  // clock; live matchdays never touch it. Derive the real value from the
  // highest played round in the current season's divisions so the UI reflects
  // actual progress after every match.
  const divisionRows = mp.seasonId
    ? await prisma.competition.findMany({ where: { saveId: save.id, kind: "division", seasonId: mp.seasonId }, select: { id: true } })
    : [];
  let playedRoundsCount = 0;
  if (divisionRows.length > 0) {
    const playedAgg = await prisma.fixture.aggregate({
      where: { saveId: save.id, played: true, competitionId: { in: divisionRows.map((c) => c.id) } },
      _max: { round: true },
    });
    playedRoundsCount = (playedAgg._max.round ?? -1) + 1;
  }

  // Season calendar popover data: the authoritative per-day schedule plus the
  // user's own fixtures (with results) keyed by season day index.
  const schedule = seasonSchedulePreview();
  const myFixtureRows = club
    ? await prisma.fixture.findMany({
        where: { saveId: save.id, OR: [{ homeClubId: club.id }, { awayClubId: club.id }] },
        select: { id: true, round: true, dayIndex: true, homeClubId: true, awayClubId: true, played: true },
      })
    : [];
  const myMatchRows = myFixtureRows.length
    ? await prisma.match.findMany({
        where: { saveId: save.id, fixtureId: { in: myFixtureRows.map((f) => f.id) } },
        select: { fixtureId: true, homeScore: true, awayScore: true },
      })
    : [];
  const opponentIds = [...new Set(myFixtureRows.map((f) => (f.homeClubId === club!.id ? f.awayClubId : f.homeClubId)))];
  const opponents = opponentIds.length
    ? await prisma.club.findMany({ where: { saveId: save.id, id: { in: opponentIds } }, select: { id: true, shortName: true, name: true } })
    : [];
  const opponentName = new Map(opponents.map((c) => [c.id, c.shortName || c.name]));
  const scoreByFixture = new Map(myMatchRows.map((m) => [m.fixtureId, m]));
  const myMatches = myFixtureRows
    .slice()
    .sort((a, b) => a.dayIndex - b.dayIndex)
    .map((f) => {
      const isHome = f.homeClubId === club!.id;
      const score = scoreByFixture.get(f.id);
      return {
        fixtureId: f.id,
        dayIndex: f.dayIndex,
        round: f.round + 1,
        opponent: opponentName.get(isHome ? f.awayClubId : f.homeClubId) ?? "",
        // ID so clients can link the opponent to the team screen.
        opponentClubId: isHome ? f.awayClubId : f.homeClubId,
        isHome,
        played: f.played,
        goalsFor: score ? (isHome ? score.homeScore : score.awayScore) : null,
        goalsAgainst: score ? (isHome ? score.awayScore : score.homeScore) : null,
      };
    });

  return {
    ready: true as const,
    saveId: save.id,
    season: {
      seasonNumber: mp.seasonNumber ?? 1,
      key: seasonKey({ year, month }),
      year,
      month,
      status: mp.seasonStatus ?? "ACTIVE",
      completedRounds: Math.max(mp.completedRounds ?? 0, playedRoundsCount),
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
    calendar: {
      today: seasonDayIndex,
      days: schedule.map((d) => ({ day: d.seasonDay, phase: d.phase, label: d.label })),
    },
    myMatches,
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
          friendGroupingOptIn: club.friendGroupingOptIn !== false,
          preferredHours: preferredHoursFromClubRow(club.timezone, club.preferredHoursJson),
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

// ---------------------------------------------------------------------------
// Team-screen read models (pure World views; no DB access so they are
// unit-testable and shared between routes).
// ---------------------------------------------------------------------------

/** Standings rows for a division competition, shaped for the shared
 *  StandingsTable UI (Competitions screen and the team screen). */
export function divisionStandingsView(world: World, comp: Competition, viewerUserId?: number | null) {
  const clubById = new Map(world.clubs.map((club) => [club.id, club]));
  const seasonByClubId = new Map(
    world.mpClubSeasons
      .filter((entry) => entry.seasonId === world.mp.seasonId && entry.divisionId === comp.id)
      .map((entry) => [entry.clubId, entry]),
  );
  return standingsTiebreak(Object.values(comp.standings)).map((row) => {
    const club = clubById.get(row.clubId);
    const seasonEntry = seasonByClubId.get(row.clubId);
    return {
      ...row,
      clubId: row.clubId,
      clubName: club?.name ?? "",
      clubShort: club?.shortName ?? "",
      colors: { primary: club?.primaryColor ?? "", secondary: club?.secondaryColor ?? "" },
      // Identity badge data: home jersey design + custom-logo flag.
      kit: club ? resolveClubKits(club).home : null,
      hasCustomLogo: Boolean(club?.customLogo && club.customLogo.status === "ACTIVE"),
      isHuman: club?.ownerUserId !== null,
      clubType: club?.ownerUserId !== null ? "HUMAN" : "AI",
      isMine: club?.ownerUserId === viewerUserId,
      promotionStatus: seasonEntry?.promotionStatus ?? "NONE",
      relegationStatus: seasonEntry?.relegationStatus ?? "NONE",
    };
  });
}

/** Fixture views for one division (client FixtureView shape). `viewerClubId`
 *  marks which club sees the `isHuman` involvement flag; live matches are
 *  surfaced so spectators can jump in. */
export function divisionFixturesView(world: World, comp: Competition, viewerClubId: number | null) {
  const clubById = new Map(world.clubs.map((club) => [club.id, club]));
  const matchByFixtureId = new Map(world.matches.map((match) => [match.fixtureId, match]));
  return world.fixtures
    .filter((f) => f.competitionId === comp.id)
    .sort((a, b) => a.round - b.round)
    .map((f) => {
      const home = clubById.get(f.homeClubId);
      const away = clubById.get(f.awayClubId);
      const m = matchByFixtureId.get(f.id);
      // Live right now? Spectators can jump into any in-progress match.
      const liveMatch = world.liveMatches.find((s) => s.fixtureId === f.id);
      return {
        id: f.id,
        round: f.round,
        home: home?.name ?? "",
        away: away?.name ?? "",
        homeClubId: f.homeClubId,
        awayClubId: f.awayClubId,
        // Fixture jerseys: the home side wears its home design, the away
        // side wears its away design.
        homeKit: home ? resolveClubKits(home).home : null,
        awayKit: away ? resolveClubKits(away).away : null,
        homeHasCustomLogo: Boolean(home?.customLogo && home.customLogo.status === "ACTIVE"),
        awayHasCustomLogo: Boolean(away?.customLogo && away.customLogo.status === "ACTIVE"),
        // Venue: the home club's ground.
        venue: home?.stadiumName ?? "",
        kickoffAt: f.kickoffAt ?? null,
        played: f.played,
        matchId: m?.id ?? null,
        liveMatchId: liveMatch && !liveMatch.ended ? liveMatch.matchId : null,
        homeScore: liveMatch && !liveMatch.ended ? liveMatch.scores[0] : m?.homeScore ?? null,
        awayScore: liveMatch && !liveMatch.ended ? liveMatch.scores[1] : m?.awayScore ?? null,
        isHuman: viewerClubId !== null && (f.homeClubId === viewerClubId || f.awayClubId === viewerClubId),
      };
    });
}

/** One archived-season row for a single club's history timeline. Movement
 *  flags compare consecutive recorded seasons (tier 1 is strongest, so a
 *  lower tier number next season means promoted). */
export interface TeamSeasonHistoryRow {
  seasonKey: string;
  divisionName: string;
  tier: number;
  position: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  champion: boolean;
  promoted: boolean;
  relegated: boolean;
}

/**
 * Public team profile behind GET /api/mp/clubs/:id — identity, current
 * division snapshot, fixtures and immutable season history for any club.
 * Privacy: public identity + competitive results only; never cash, ledger
 * or Elo ratings of another manager's club.
 */
export function buildTeamProfile(world: World, clubId: number) {
  const club = world.clubs.find((c) => c.id === clubId);
  if (!club) return null;

  // Current-season division membership (null for PROVISIONAL/DORMANT clubs).
  const divisions = divisionsInSeason(world, world.mp.seasonId).filter((c) => c.status !== "ARCHIVED");
  const currentDivision = divisions.find((d) => d.standings[clubId] !== undefined) ?? null;

  // Season-by-season history from the write-once rollover snapshots, oldest
  // first. A club that joined later simply has fewer rows.
  const history: TeamSeasonHistoryRow[] = [];
  let previousTier: number | null = null;
  for (const entry of [...world.seasonHistory].sort((a, b) => a.seasonId - b.seasonId)) {
    const divIndex = entry.divisions.findIndex((div) => div.standings.some((row) => row.clubId === clubId));
    if (divIndex < 0) continue;
    const div = entry.divisions[divIndex];
    const position = div.standings.findIndex((row) => row.clubId === clubId) + 1;
    const row = div.standings[position - 1];
    history.push({
      seasonKey: entry.seasonKey,
      divisionName: div.divisionName,
      tier: div.tier,
      position,
      played: row.played,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      points: row.points,
      champion: position === 1,
      promoted: previousTier !== null && div.tier < previousTier,
      relegated: previousTier !== null && div.tier > previousTier,
    });
    previousTier = div.tier;
  }

  const seasonRow = currentDivision?.standings[clubId];
  const seasonTable = currentDivision ? standingsTiebreak(Object.values(currentDivision.standings)) : [];
  const seasonPosition = currentDivision ? seasonTable.findIndex((r) => r.clubId === clubId) + 1 : 0;

  // Squad digest for the simple players list: identity + market value signals
  // only. Salaries, contracts and skills stay private to the owning manager.
  // Ordering for the timeline list: first-team before youth, then pitch
  // position, then name; the client renders any nickname in quotes.
  const squad = world.players.filter((p) => p.clubId === clubId);
  const players = squad
    .slice()
    .sort((a, b) => {
      if (a.isYouth !== b.isYouth) return a.isYouth ? 1 : -1;
      if (a.position !== b.position) return a.position - b.position;
      return a.name.localeCompare(b.name);
    })
    .map((p) => ({
      id: p.id,
      name: p.name,
      nickname: p.nickname ?? null,
      position: p.position,
      positionName: POSITION_NAMES[p.position] ?? "",
      tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "",
      overall: p.overall,
      age: p.age,
      country: p.country,
      isYouth: p.isYouth,
    }));
  // Total team value: full squad market value plus the cash balance.
  const totalValue = squad.reduce((sum, p) => sum + p.value, 0) + club.cash;

  return {
    club: {
      id: club.id,
      name: club.name,
      shortName: club.shortName,
      country: club.country,
      stadiumName: club.stadiumName,
      primaryColor: club.primaryColor,
      secondaryColor: club.secondaryColor,
      kits: resolveClubKits(club),
      logoVariant: club.logoVariant ?? 0,
      hasCustomLogo: Boolean(club.customLogo && club.customLogo.status === "ACTIVE"),
      coachName: club.coachName,
      isHuman: club.ownerUserId !== null,
      competitionState: club.competitionState,
    },
    trophies: club.trophies,
    totalValue,
    players,
    season:
      currentDivision && seasonRow
        ? {
            seasonNumber: world.mp.seasonNumber ?? null,
            division: {
              id: currentDivision.id,
              name: compDivisionName(currentDivision),
              tier: tierOf(currentDivision),
              groupIndex: groupIndexOf(currentDivision),
            },
            position: seasonPosition > 0 ? seasonPosition : null,
            played: seasonRow.played,
            wins: seasonRow.wins,
            draws: seasonRow.draws,
            losses: seasonRow.losses,
            goalsFor: seasonRow.goalsFor,
            goalsAgainst: seasonRow.goalsAgainst,
            points: seasonRow.points,
          }
        : null,
    standings: currentDivision ? divisionStandingsView(world, currentDivision) : [],
    fixtures: currentDivision ? divisionFixturesView(world, currentDivision, clubId) : [],
    history,
  };
}
