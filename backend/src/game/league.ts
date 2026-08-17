import type { Club, Competition, Fixture, RngState, StandingsRow } from "./types";
import { shuffle } from "./rng";

export function circleSchedule(rng: RngState, clubIds: number[]): [number, number][][] {
  const teams = shuffle(rng, clubIds);
  const n = teams.length;
  const rounds: [number, number][][] = [];
  const isOdd = n % 2 === 1;
  const arr = isOdd ? [...teams, -1] : [...teams];
  const m = arr.length;
  const half = m / 2;
  for (let r = 0; r < m - 1; r++) {
    const round: [number, number][] = [];
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[m - 1 - i];
      if (home !== -1 && away !== -1) {
        if (r % 2 === 0) round.push([home, away]);
        else round.push([away, home]);
      } else if (home !== -1) {
        round.push([home, -1]);
      } else if (away !== -1) {
        round.push([away, -1]);
      }
    }
    rounds.push(round);
    const last = arr.pop()!;
    arr.splice(1, 0, last);
  }
  const fullRounds: [number, number][][] = [];
  for (const round of rounds) {
    fullRounds.push(round.map(([h, a]) => [h, a] as [number, number]));
  }
  for (const round of rounds) {
    fullRounds.push(round.map(([h, a]) => [a, h] as [number, number]));
  }
  return fullRounds;
}

export function createLeagueFixtures(
  rng: RngState,
  competitionId: number,
  clubIds: number[],
  startDay: number,
  daysBetween: number
): Fixture[] {
  const rounds = circleSchedule(rng, clubIds);
  const fixtures: Fixture[] = [];
  let id = 0;
  rounds.forEach((round, r) => {
    const day = startDay + r * daysBetween;
    for (const [home, away] of round) {
      if (home === -1 || away === -1) continue;
      fixtures.push({
        id: id++,
        competitionId,
        round: r,
        homeClubId: home,
        awayClubId: away,
        dayIndex: day,
        played: false,
      });
    }
  });
  return fixtures;
}

export function emptyStandingsRow(clubId: number): StandingsRow {
  return { clubId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

export function standingsTiebreak(rows: StandingsRow[]): StandingsRow[] {
  return [...rows].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.wins !== b.wins) return b.wins - a.wins;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdA !== gdB) return gdB - gdA;
    return b.goalsFor - a.goalsFor;
  });
}

export function updateStandings(competition: Competition, homeId: number, awayId: number, hs: number, as: number) {
  if (competition.kind === "cup") return;
  const row = (id: number) => {
    competition.standings[id] ??= emptyStandingsRow(id);
    return competition.standings[id];
  };
  const hr = row(homeId);
  const ar = row(awayId);
  hr.played++;
  ar.played++;
  hr.goalsFor += hs;
  hr.goalsAgainst += as;
  ar.goalsFor += as;
  ar.goalsAgainst += hs;
  if (hs > as) {
    hr.wins++;
    hr.points += 3;
    ar.losses++;
  } else if (hs < as) {
    ar.wins++;
    ar.points += 3;
    hr.losses++;
  } else {
    hr.draws++;
    ar.draws++;
    hr.points++;
    ar.points++;
  }
}

export function sortedStandings(competition: Competition): StandingsRow[] {
  const rows = Object.values(competition.standings);
  return standingsTiebreak(rows);
}

export function getPosition(competition: Competition, clubId: number): number {
  const rows = sortedStandings(competition);
  const idx = rows.findIndex((r) => r.clubId === clubId);
  return idx < 0 ? 0 : idx + 1;
}

export function isLeagueFinished(competition: Competition, fixtures: Fixture[]): boolean {
  const clubs = competition.config.clubs;
  if (clubs.length === 0) return false;
  const maxRounds = competition.config.turns * (clubs.length - 1);
  const compFixtures = fixtures.filter((f) => f.competitionId === competition.id);
  const maxPlayed = Math.max(0, ...compFixtures.map((f) => (f.played ? f.round : -1)));
  return maxPlayed + 1 >= maxRounds;
}
