import type { Competition, Fixture, GroupStandings, Match, RngState, StandingsRow } from "./types";
import { createKnockoutBracket, Tie, tieWinners } from "./knockout";
import { circleSchedule, emptyStandingsRow, standingsTiebreak, updateStandings } from "./league";
import { shuffle } from "./rng";

export function createStateChampionship(
  rng: RngState,
  id: number,
  name: string,
  stateCode: string,
  teams: number[],
  groupSize = 4
): Competition {
  const shuffled = shuffle(rng, teams);
  const groups: number[][] = [];
  for (let i = 0; i < shuffled.length; i += groupSize) {
    groups.push(shuffled.slice(i, i + groupSize));
  }
  const groupStandings: GroupStandings[] = groups.map((g, gi) => ({
    groupName: String.fromCharCode(65 + gi),
    rows: Object.fromEntries(g.map((clubId) => [clubId, emptyStandingsRow(clubId)])),
  }));
  return {
    id,
    kind: "state",
    division: 0,
    stateCode,
    name,
    round: 0,
    stage: "group",
    config: {
      clubs: teams,
      turns: 1,
      groups,
      bracket: [],
      promoted: 0,
      relegated: 2,
      groupQualifiers: 2,
    },
    standings: {},
    groupStandings,
    winners: [],
    knockouts: [],
  };
}

export function createStateGroupFixtures(
  rng: RngState,
  competition: Competition,
  startDay: number,
  daysBetween: number
): Fixture[] {
  const fixtures: Fixture[] = [];
  let id = 0;
  for (const group of competition.config.groups) {
    const rounds = circleSchedule(rng, group).slice(0, competition.config.turns * (group.length - 1));
    rounds.forEach((round, r) => {
      const day = startDay + r * daysBetween;
      for (const [home, away] of round) {
        if (home === -1 || away === -1) continue;
        fixtures.push({
          id: id++,
          competitionId: competition.id,
          round: r,
          homeClubId: home,
          awayClubId: away,
          dayIndex: day,
          played: false,
        });
      }
    });
  }
  return fixtures;
}

export function groupStandingsFor(clubId: number, competition: Competition): StandingsRow | null {
  for (const g of competition.groupStandings) {
    if (g.rows[clubId]) return g.rows[clubId];
  }
  return null;
}

export function updateGroupStandings(competition: Competition, homeId: number, awayId: number, hs: number, as: number) {
  const gh = groupStandingsFor(homeId, competition);
  const ga = groupStandingsFor(awayId, competition);
  if (!gh || !ga) return;
  const apply = (row: StandingsRow, gf: number, ga2: number) => {
    row.played++;
    row.goalsFor += gf;
    row.goalsAgainst += ga2;
  };
  apply(gh, hs, as);
  apply(ga, as, hs);
  if (hs > as) {
    gh.wins++;
    gh.points += 3;
    ga.losses++;
  } else if (hs < as) {
    ga.wins++;
    ga.points += 3;
    gh.losses++;
  } else {
    gh.draws++;
    ga.draws++;
    gh.points++;
    ga.points++;
  }
}

export function groupDone(competition: Competition): boolean {
  const rows = competition.groupStandings.flatMap((g) => Object.values(g.rows));
  return rows.length > 0 && rows.every((r) => r.played >= competition.config.groups[0].length - 1);
}

export function startStateKnockout(rng: RngState, competition: Competition): void {
  const qualifiers: number[] = [];
  for (const g of competition.groupStandings) {
    const sorted = standingsTiebreak(Object.values(g.rows));
    for (let i = 0; i < Math.min(competition.config.groupQualifiers, sorted.length); i++) {
      qualifiers.push(sorted[i].clubId);
    }
  }
  competition.knockouts = createKnockoutBracket(rng, qualifiers);
  competition.round = 100;
  competition.stage = "knockout";
}

export function scheduleStateKnockoutRound(
  rng: RngState,
  competition: Competition,
  round: number,
  startDay: number,
  legGap: number
): Fixture[] {
  const roundIndex = round - 100;
  const ties = competition.knockouts[roundIndex];
  if (!ties) return [];
  const fixtures: Fixture[] = [];
  let id = 0;
  for (let i = 0; i < ties.length; i++) {
    const tie = ties[i];
    if (tie.h === null || tie.h === undefined || tie.a === null || tie.a === undefined) continue;
    fixtures.push({
      id: id++,
      competitionId: competition.id,
      round,
      homeClubId: tie.h,
      awayClubId: tie.a,
      dayIndex: startDay,
      played: false,
      leg: 1,
      tie: i,
    });
    if (ties.length > 1) {
      fixtures.push({
        id: id++,
        competitionId: competition.id,
        round,
        homeClubId: tie.a,
        awayClubId: tie.h,
        dayIndex: startDay + legGap,
        played: false,
        leg: 2,
        tie: i,
      });
    }
  }
  return fixtures;
}

export function advanceStateKnockout(rng: RngState, competition: Competition, fixtures: Fixture[], matches: Match[]): Fixture[] {
  const round = competition.round;
  const roundIndex = round - 100;
  const ties = competition.knockouts[roundIndex];
  if (!ties) return [];
  const roundFixtures = fixtures.filter((f) => f.competitionId === competition.id && f.round === round);
  const allPlayed = roundFixtures.length > 0 && roundFixtures.every((f) => f.played);
  if (!allPlayed) return [];
  const winners: number[] = [];
  for (let ti = 0; ti < ties.length; ti++) {
    const tie = ties[ti];
    const leg1 = roundFixtures.find((f) => f.tie === ti && f.leg === 1);
    const leg2 = roundFixtures.find((f) => f.tie === ti && f.leg === 2);
    if (leg1 && leg1.played) {
      const m = matches.find((x) => x.fixtureId === leg1.id);
      tie.leg1 = { hs: m?.homeScore ?? 0, as: m?.awayScore ?? 0 };
      if (m?.penaltyWinnerId != null && m.penaltyScore) {
        tie.pen = { hs: m.penaltyScore[0], as: m.penaltyScore[1], winner: m.penaltyWinnerId };
      }
    }
    if (leg2 && leg2.played) {
      const m = matches.find((x) => x.fixtureId === leg2.id);
      tie.leg2 = { hs: m?.homeScore ?? 0, as: m?.awayScore ?? 0 };
      if (m?.penaltyWinnerId != null && m.penaltyScore) {
        tie.pen = { hs: m.penaltyScore[0], as: m.penaltyScore[1], winner: m.penaltyWinnerId };
      }
    }
    const w = tieWinners(rng, tie);
    if (w !== null) winners.push(w);
  }
  if (winners.length !== ties.length) return [];
  const nextRoundIndex = roundIndex + 1;
  const nextTies = competition.knockouts[nextRoundIndex];
  if (!nextTies) {
    if (winners.length === 1) {
      competition.winners = winners;
      competition.stage = "finished";
    }
    return [];
  }
  for (let i = 0; i < nextTies.length; i++) {
    nextTies[i].h = winners[i * 2];
    nextTies[i].a = winners[i * 2 + 1];
  }
  competition.round = 100 + nextRoundIndex;
  return [];
}
