import type { Competition, World } from "../game/types";
import { dayInfo, weekdayName } from "../game/calendar";
import { sortedStandings, getPosition } from "../game/league";
import { findCupWinner } from "../game/cup";
import { groupStandingsFor } from "../game/stateChampionship";
import { FORMATION_NAMES, POSITION_NAMES, STYLE_NAMES, PRESSING_NAMES, DIRECTION_NAMES, TACTICAL_POSITION_NAMES } from "../game/constants";

export function playerView(p: World["players"][number]) {
  return {
    id: p.id,
    name: p.name,
    age: p.age,
    country: p.country,
    position: p.position,
    positionName: POSITION_NAMES[p.position],
    tacPos: p.tacPos,
    tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "",
    overall: p.overall,
    potential: p.potential,
    tier: p.tier,
    skills: p.skills,
    energy: p.energy,
    value: p.value,
    salary: p.salary,
    contractDays: p.contractDays,
    injuryDays: p.injuryDays,
    isYouth: p.isYouth,
    isStar: p.isStar,
    worldClass: p.worldClass,
    seasonGoals: p.seasonGoals,
    seasonAssists: p.seasonAssists,
    careerGoals: p.careerGoals,
    careerAssists: p.careerAssists,
    yellows: p.yellows,
    reds: p.reds,
    characteristic1: p.characteristic1,
    characteristic2: p.characteristic2,
    onSale: p.onSale,
    salePrice: p.salePrice,
    suspended: p.suspended,
    releaseClause: p.releaseClause,
  };
}

export function buildSnapshot(world: World, clubId: number) {
  const club = world.clubs.find((c) => c.id === clubId);
  const info = dayInfo(world.dayIndex);
  const nextFixture = world.fixtures
    .filter((f) => !f.played && f.dayIndex >= world.dayIndex && (f.homeClubId === clubId || f.awayClubId === clubId))
    .sort((a, b) => a.dayIndex - b.dayIndex)[0];

  const competitions = world.competitions.map((c) => {
    const position = c.kind === "league" ? getPosition(c, clubId) : 0;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      stage: c.stage,
      round: c.round,
      division: c.division,
      position,
      winnerId: c.kind === "cup" ? findCupWinner(c) : c.winners[0] ?? null,
    };
  });

  const squad = world.players
    .filter((p) => p.clubId === clubId && !p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map(playerView);
  const juniors = world.players
    .filter((p) => p.clubId === clubId && p.isYouth)
    .sort((a, b) => b.overall - a.overall)
    .map(playerView);

  const news = world.news
    .slice(-30)
    .reverse()
    .map((n) => ({ dayIndex: n.dayIndex, dayLabel: dayInfo(n.dayIndex).label, text: n.text, kind: n.kind }));

  const auctions = world.auctions.map((a) => {
    const p = world.players.find((x) => x.id === a.playerId);
    return {
      id: a.id,
      playerId: a.playerId,
      playerName: p?.name ?? "",
      overall: p?.overall ?? 0,
      position: p?.position ?? 0,
      minBid: a.minBid,
      deadlineDay: a.deadlineDay,
      deadlineLabel: dayInfo(a.deadlineDay).label,
      currentBid: a.bids.length > 0 ? Math.max(...a.bids.map((b) => b.amount)) : 0,
      sellerClubId: a.sellerClubId,
      myBid: a.bids.find((b) => b.clubId === clubId)?.amount ?? 0,
    };
  });

  const freeAgents = world.players
    .filter((p) => p.clubId === null)
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 30)
    .map(playerView);

  return {
    save: {
      year: world.year,
      dayIndex: world.dayIndex,
      dateLabel: info.label,
      dayOfWeek: weekdayName(info.dayOfWeek),
    },
    seasonSummary: world.seasonSummary
      ? {
          leagueChampion: world.seasonSummary.leagueChampionId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.leagueChampionId)?.name ?? null : null,
          leagueRunnerUp: world.seasonSummary.leagueRunnerUpId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.leagueRunnerUpId)?.name ?? null : null,
          cupChampion: world.seasonSummary.cupChampionId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.cupChampionId)?.name ?? null : null,
          stateChampion: world.seasonSummary.stateChampionId !== null ? world.clubs.find((c) => c.id === world.seasonSummary!.stateChampionId)?.name ?? null : null,
          promoted: world.seasonSummary.promoted.map((id) => world.clubs.find((c) => c.id === id)?.name ?? ""),
          relegated: world.seasonSummary.relegated.map((id) => world.clubs.find((c) => c.id === id)?.name ?? ""),
        }
      : null,
    club: club
      ? {
          id: club.id,
          name: club.name,
          shortName: club.shortName,
          stateCode: club.stateCode,
          division: club.division,
          reputation: club.reputation,
          level: club.level,
          cash: club.cash,
          loanBalance: club.loanBalance,
          stadiumName: club.stadiumName,
          stadiumCapacity: club.stadiumCapacity,
          primaryColor: club.primaryColor,
          secondaryColor: club.secondaryColor,
          coachName: club.coachName,
          boardConfidence: club.boardConfidence,
          fanConfidence: club.fanConfidence,
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
          dayLabel: dayInfo(nextFixture.dayIndex).label,
          dayIndex: nextFixture.dayIndex,
          isHome: nextFixture.homeClubId === clubId,
        }
      : null,
    competitions,
    squad,
    juniors,
    news,
    auctions,
    freeAgents,
  };
}

export function competitionTable(world: World, competition: Competition) {
  if (competition.kind === "state" && competition.groupStandings.length > 0) {
    return competition.groupStandings.map((g) => ({
      groupName: g.groupName,
      rows: Object.values(g.rows)
        .sort((a, b) => b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst))
        .map((r) => ({
          ...r,
          clubName: world.clubs.find((c) => c.id === r.clubId)?.name ?? "",
          clubShort: world.clubs.find((c) => c.id === r.clubId)?.shortName ?? "",
          colors: {
            primary: world.clubs.find((c) => c.id === r.clubId)?.primaryColor ?? "",
            secondary: world.clubs.find((c) => c.id === r.clubId)?.secondaryColor ?? "",
          },
          isHuman: r.clubId === world.humanClubId,
        })),
    }));
  }
  const rows = sortedStandings(competition);
  return rows.map((r) => ({
    ...r,
    clubName: world.clubs.find((c) => c.id === r.clubId)?.name ?? "",
    clubShort: world.clubs.find((c) => c.id === r.clubId)?.shortName ?? "",
    colors: {
      primary: world.clubs.find((c) => c.id === r.clubId)?.primaryColor ?? "",
      secondary: world.clubs.find((c) => c.id === r.clubId)?.secondaryColor ?? "",
    },
    isHuman: r.clubId === world.humanClubId,
  }));
}

export function bracketView(world: World, competition: Competition) {
  return competition.knockouts.map((round, ri) => ({
    round: ri,
    ties: round.map((tie) => ({
      home: world.clubs.find((c) => c.id === tie.h)?.name ?? "TBD",
      away: world.clubs.find((c) => c.id === tie.a)?.name ?? "TBD",
      leg1: tie.leg1 ? `${tie.leg1.hs} - ${tie.leg1.as}` : null,
      leg2: tie.leg2 ? `${tie.leg2.hs} - ${tie.leg2.as}` : null,
      pen: tie.pen ? `${tie.pen.hs} - ${tie.pen.as}` : null,
      winner: tie.winner !== null ? world.clubs.find((c) => c.id === tie.winner)?.name ?? "" : "",
      played: tie.played,
    })),
  }));
}
