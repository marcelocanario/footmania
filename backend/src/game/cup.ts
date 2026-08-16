import type { Competition, Fixture, Match, RngState } from "./types";
import { createKnockoutBracket, tieWinners, Tie } from "./knockout";

export function createCup(
  rng: RngState,
  id: number,
  name: string,
  teams: number[],
  knockoutDays?: number[]
): Competition {
  const bracket = createKnockoutBracket(rng, teams);
  return {
    id,
    kind: "cup",
    division: 0,
    stateCode: "",
    name,
    round: 0,
    stage: "knockout",
    config: {
      clubs: teams,
      turns: 0,
      groups: [],
      bracket: [],
      promoted: 0,
      relegated: 0,
      groupQualifiers: 0,
    },
    standings: {},
    groupStandings: [],
    winners: [],
    knockouts: bracket,
  };
}

export function scheduleCupRound(
  rng: RngState,
  competition: Competition,
  round: number,
  startDay: number,
  legGap: number
): Fixture[] {
  const ties = competition.knockouts[round];
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

export function advanceCupRound(rng: RngState, competition: Competition, fixtures: Fixture[], matches: Match[]): Fixture[] {
  const round = competition.round;
  const ties = competition.knockouts[round];
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
  const nextRound = round + 1;
  const nextTies = competition.knockouts[nextRound];
  if (!nextTies) {
    if (winners.length === 1) {
      competition.winners = winners;
      competition.stage = "finished";
      competition.round = nextRound;
    }
    return [];
  }
  for (let i = 0; i < nextTies.length; i++) {
    const t = nextTies[i];
    t.h = winners[i * 2];
    t.a = winners[i * 2 + 1];
  }
  competition.round = nextRound;
  return [];
}

export function findCupWinner(competition: Competition): number | null {
  return competition.winners.length > 0 ? competition.winners[competition.winners.length - 1] : null;
}
