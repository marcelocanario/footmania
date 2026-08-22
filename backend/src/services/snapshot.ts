import type { Competition, World } from "../game/types";
import { multiplayerDayLabel, weekdayName } from "../game/calendar";
import { sortedStandings, getPosition } from "../game/league";
import { eloRatings } from "../game/elo";
import { FORMATION_NAMES, POSITION_NAMES, STYLE_NAMES, PRESSING_NAMES, DIRECTION_NAMES, TACTICAL_POSITION_NAMES } from "../game/constants";
import { gameConfig } from "../config";
import { getCommitmentTotals, financialState, remainingSeasonFraction } from "../game/finance";
import { resolveClubKits } from "../game/kits";
import { calendarValues, phaseForSeasonDayIndex } from "./seasonCalendar";
import { seasonKey } from "../game/clock";

export function playerView(p: World["players"][number], loan?: { onLoan: boolean; onLoanOut: boolean; loanClubName: string | null; loanFromName: string | null }) {
  const nick = (p.nickname ?? "").trim();
  return {
    id: p.id,
    name: p.name,
    nickname: p.nickname ?? null,
    displayName: nick.length > 0 ? nick : p.name,
    age: p.age,
    country: p.country,
    position: p.position,
    positionName: POSITION_NAMES[p.position],
    tacPos: p.tacPos,
    tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "",
    overall: p.overall,
    skills: p.skills,
    energy: p.energy,
    value: p.value,
    salary: p.salary,
    contractDays: p.contractDays,
    injuryDays: p.injuryDays,
    isYouth: p.isYouth,
    seasonGoals: p.seasonGoals,
    seasonAssists: p.seasonAssists,
    careerGoals: p.careerGoals,
    careerAssists: p.careerAssists,
    yellows: p.yellows,
    reds: p.reds,
    onSale: p.onSale,
    suspended: p.suspendedGames > 0,
    suspendedGames: p.suspendedGames,
    loanId: p.loanId,
    releaseClause: p.releaseClause,
    onLoan: loan?.onLoan ?? false,
    onLoanOut: loan?.onLoanOut ?? false,
    loanClubName: loan?.loanClubName ?? null,
    loanFromName: loan?.loanFromName ?? null,
  };
}

/** Loan context for a player relative to a club, or neutral defaults. */
function loanInfo(world: World, p: World["players"][number], clubId: number) {
  if (p.loanId === null) {
    return { onLoan: false, onLoanOut: false, loanClubName: null as string | null, loanFromName: null as string | null };
  }
  const loan = world.loans.find((l) => l.id === p.loanId);
  if (!loan || loan.recalled || loan.toClubId === null) {
    return { onLoan: false, onLoanOut: false, loanClubName: null as string | null, loanFromName: null as string | null };
  }
  return {
    onLoan: p.clubId === clubId && loan.fromClubId !== clubId,
    onLoanOut: loan.fromClubId === clubId && p.clubId !== clubId,
    loanClubName: world.clubs.find((c) => c.id === loan.toClubId)?.name ?? null,
    loanFromName: world.clubs.find((c) => c.id === loan.fromClubId)?.name ?? null,
  };
}

export function buildSnapshot(world: World, clubId: number) {
  const club = world.clubs.find((c) => c.id === clubId);
  const dayLabel = (day: number) => multiplayerDayLabel(day);
  const currentDateLabel = multiplayerDayLabel(world.dayIndex);
  const currentDayOfWeek = new Date(Date.UTC(world.mp.seasonYear, world.mp.seasonMonth - 1, Math.max(1, world.dayIndex))).getUTCDay();
  const calendar = calendarValues();
  const seasonDayIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  const currentSeasonDivisions = new Set(
    world.competitions
      .filter((c) => c.kind === "division" && c.seasonId === world.mp.seasonId)
      .map((c) => c.id),
  );
  const nextFixture = world.fixtures
    .filter((f) => !f.played && currentSeasonDivisions.has(f.competitionId) && f.dayIndex >= world.dayIndex && (f.homeClubId === clubId || f.awayClubId === clubId))
    .sort((a, b) => a.dayIndex - b.dayIndex)[0];

  const competitions = world.competitions
    .filter((c) => c.kind !== "division" || c.seasonId === world.mp.seasonId)
    .map((c) => {
    const position = c.kind === "league" || c.kind === "division" ? getPosition(c, clubId, eloRatings(world)) : 0;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      stage: c.stage,
      round: c.round,
      position,
      winnerId: c.winners[0] ?? null,
    };
    });

  const squad = world.players
    .filter((p) => p.clubId === clubId && !p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId)));
  const juniors = world.players
    .filter((p) => p.clubId === clubId && p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId)));
  // Players the club owns but that are away on loan, so the ceding club can
  // still see them in its roster.
  const loanedOut = world.players
    .filter((p) => p.clubId !== clubId && p.loanId !== null && world.loans.some((l) => l.id === p.loanId && l.fromClubId === clubId && l.toClubId !== null && !l.recalled))
    .sort((a, b) => b.overall - a.overall)
    .map((p) => playerView(p, loanInfo(world, p, clubId)));
  // Loaned-out players appear in the senior roster (greyed out in the UI).
  const squadAll = [...squad, ...loanedOut].sort((a, b) => b.overall - a.overall);

  const news = world.news
    .slice(-30)
    .reverse()
    .map((n) => ({ dayIndex: n.dayIndex, dayLabel: dayLabel(n.dayIndex), text: n.text, kind: n.kind }));

  const auctions = world.transferAuctions
    .filter((a) => a.status === "ACTIVE")
    .map((a) => {
      const p = world.players.find((x) => x.id === a.playerId);
      const myBid = clubId !== null ? world.marketBids.find((b) => b.listingId === a.id && b.clubId === clubId) : undefined;
      return {
        id: a.id,
        playerId: a.playerId,
        playerName: p?.name ?? "",
        overall: p?.overall ?? 0,
        position: p?.position ?? 0,
        age: p?.age ?? 0,
        salary: p?.salary ?? 0,
        skills: p?.skills ?? { gol: 0, vel: 0, tec: 0, pas: 0, des: 0, arm: 0, fin: 0 },
        value: p?.value ?? 0,
        openingPrice: a.openingPrice,
        currentPrice: a.currentPrice,
        bidIncrement: a.bidIncrement,
        bidderCount: world.marketBids.filter((b) => b.listingId === a.id).length,
        sellerClubId: a.sellerClubId,
        sellerName: world.clubs.find((c) => c.id === a.sellerClubId)?.name ?? "",
        deadline: a.deadline,
        status: a.status,
        myMaxBid: myBid?.maxBid ?? null,
        amILeading: a.leadingClubId === clubId,
      };
    });

  // Free agents with an active market listing (Phase 7). Raw clubId === null
  // players without a listing are not market-visible yet.
  const listedPlayerIds = new Set(
    world.freeAgentListings.filter((l) => l.status === "ACTIVE").map((l) => l.playerId)
  );
  const freeAgents = world.players
    .filter((p) => p.clubId === null && listedPlayerIds.has(p.id))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 30)
    .map((p) => playerView(p));

  return {
    save: {
      year: world.year,
      dayIndex: world.dayIndex,
       dateLabel: currentDateLabel,
       dayOfWeek: weekdayName(currentDayOfWeek),
       seasonDays: calendar.seasonDays,
       seasonDayIndex,
       phase: world.mp.phase ?? phaseForSeasonDayIndex(seasonDayIndex),
       interseasonAfterMatchDays: calendar.interseasonAfterMatchDays,
       interseasonBeforeNextSeasonDays: calendar.interseasonBeforeNextSeasonDays,
       lastLeagueMatchDayIndex: calendar.lastLeagueMatchDayIndex,
       interseasonStartIndex: calendar.interseasonStartIndex,
       preparationStartIndex: calendar.preparationStartIndex,
    },
    seasonSummary: world.seasonSummary
      ? {
          leagueChampion: world.seasonSummary.leagueChampionId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.leagueChampionId)?.name ?? null : null,
          leagueRunnerUp: world.seasonSummary.leagueRunnerUpId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.leagueRunnerUpId)?.name ?? null : null,
        }
      : null,
    club: club
      ? {
          id: club.id,
          name: club.name,
          shortName: club.shortName,
          country: club.country,
          highestDivision: club.highestDivision,
          cash: club.cash,
          stadiumName: club.stadiumName,
          primaryColor: club.primaryColor,
          secondaryColor: club.secondaryColor,
          kits: resolveClubKits(club),
          logoVariant: club.logoVariant ?? 0,
          hasCustomLogo: Boolean(club.customLogo && club.customLogo.status === "ACTIVE"),
          coachName: club.coachName,
          coachEditAllowed:
            !club.coachNameChangedSeasonKey ||
            club.coachNameChangedSeasonKey !== seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }),
          trainingFocus: club.trainingFocus,
          competitionState: club.competitionState,
          // Financial snapshot (financial-control §55): the derived cushion and
          // warning state, computed authoritatively on the server.
          finance: (() => {
            const totals = getCommitmentTotals(world, club);
            return {
              activeBidCommitments: totals.activeBidCommitments,
              remainingSalaryCommitments: totals.remainingSalaryCommitments,
              contingentSalary: totals.contingentSalary,
              immediateAvailableCash: totals.immediateAvailableCash,
              remainingSeasonFraction: club.competitionState === "PROVISIONAL" ? 1 : remainingSeasonFraction(world),
              financialCushion: totals.financialCushion,
              status: financialState(world, club),
            };
          })(),
          tactics: club.tactics
            ? {
                formation: club.tactics.formation,
                style: club.tactics.style,
                pressing: club.tactics.pressing,
                direction: club.tactics.direction,
                formationName: FORMATION_NAMES[club.tactics.formation] ?? "",
                styleName: STYLE_NAMES[club.tactics.style] ?? "",
                pressingName: PRESSING_NAMES[club.tactics.pressing] ?? "",
                directionName: DIRECTION_NAMES[club.tactics.direction] ?? "",
              }
            : null,
          trophies: club.trophies,
          ledger: {
            income: club.ledger.income.slice(-20).reverse(),
            expense: club.ledger.expense.slice(-20).reverse(),
          },
        }
      : null,
    nextFixture: nextFixture
      ? {
          id: nextFixture.id,
          home: world.clubs.find((c) => c.id === nextFixture.homeClubId)?.name ?? "",
          away: world.clubs.find((c) => c.id === nextFixture.awayClubId)?.name ?? "",
          dayLabel: dayLabel(nextFixture.dayIndex),
          dayIndex: nextFixture.dayIndex,
          isHome: nextFixture.homeClubId === clubId,
        }
      : null,
    competitions,
    squad: squadAll,
    juniors,
    loanedOut,
    news,
    auctions,
    freeAgents,
    records: world.records,
    seasonAwards: world.seasonAwards.slice(-40).reverse(),
  };
}

export function competitionTable(world: World, competition: Competition, myClubId: number | null = null) {
  const rows = sortedStandings(competition, eloRatings(world));
  return rows.map((r) => {
    const club = world.clubs.find((c) => c.id === r.clubId);
    const kits = club ? resolveClubKits(club) : null;
    return {
      ...r,
      clubName: club?.name ?? "",
      clubShort: club?.shortName ?? "",
      colors: {
        primary: club?.primaryColor ?? "",
        secondary: club?.secondaryColor ?? "",
      },
      // Kit Lab: pattern + trim for jersey-style badges in tables (null when
      // the club is missing, which cannot happen in practice).
      kit: kits ? { primary: kits.home.primary, secondary: kits.home.secondary, accent: kits.home.accent, numberColor: kits.home.numberColor, pattern: kits.home.pattern } : null,
      isHuman: r.clubId === myClubId,
    };
  });
}
