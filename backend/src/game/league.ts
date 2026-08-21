import type { Club, Competition, Fixture, RngState, StandingsRow, World } from "./types";
import { shuffle } from "./rng";
import { MP_CONFIG } from "../config";

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
        scheduledSeasonDayIndex: day,
        played: false,
      });
    }
  });
  return fixtures;
}

/** Validate the structural guarantees of a complete even-team double round robin. */
export function validateDoubleRoundRobinFixtures(fixtures: Fixture[], clubIds: number[], turns = 2): void {
  if (clubIds.length < 4 || clubIds.length % 2 !== 0) throw new Error("A division must contain an even number of at least four clubs");
  const rounds = turns * (clubIds.length - 1);
  const byRound = new Map<number, Fixture[]>();
  for (const fixture of fixtures) {
    const round = byRound.get(fixture.round) ?? [];
    round.push(fixture);
    byRound.set(fixture.round, round);
  }
  if (byRound.size !== rounds) throw new Error(`Expected ${rounds} rounds, got ${byRound.size}`);
  if (fixtures.length !== rounds * clubIds.length / 2) throw new Error("Fixture count does not form a complete round robin");

  const counts = new Map<number, { total: number; home: number; away: number }>();
  for (const id of clubIds) counts.set(id, { total: 0, home: 0, away: 0 });
  const pairs = new Map<string, { home: number; away: number }[]>();
  for (const fixture of fixtures) {
    const home = counts.get(fixture.homeClubId);
    const away = counts.get(fixture.awayClubId);
    if (!home || !away || fixture.homeClubId === fixture.awayClubId) throw new Error("Fixture contains an invalid club");
    home.total += 1;
    home.home += 1;
    away.total += 1;
    away.away += 1;
    const key = [fixture.homeClubId, fixture.awayClubId].sort((a, b) => a - b).join(":");
    const pair = pairs.get(key) ?? [];
    pair.push({ home: fixture.homeClubId, away: fixture.awayClubId });
    pairs.set(key, pair);
  }
  for (const value of counts.values()) {
    if (value.total !== rounds || value.home !== rounds / 2 || value.away !== rounds / 2) throw new Error("Club home/away balance is invalid");
  }
  if (pairs.size !== clubIds.length * (clubIds.length - 1) / 2 || [...pairs.values()].some((pair) => pair.length !== turns || new Set(pair.map((leg) => `${leg.home}:${leg.away}`)).size !== 2)) {
    throw new Error("Every pair must meet once at home and once away");
  }
}

export function emptyStandingsRow(clubId: number): StandingsRow {
  return { clubId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

export function standingsTiebreak(rows: StandingsRow[], eloRatings?: ReadonlyMap<number, number>): StandingsRow[] {
  return [...rows].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.wins !== b.wins) return b.wins - a.wins;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdA !== gdB) return gdB - gdA;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    const eloA = eloRatings?.get(a.clubId) ?? 0;
    const eloB = eloRatings?.get(b.clubId) ?? 0;
    if (eloA !== eloB) return eloB - eloA;
    return a.clubId - b.clubId;
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

export function sortedStandings(competition: Competition, eloRatings?: ReadonlyMap<number, number>): StandingsRow[] {
  const rows = Object.values(competition.standings);
  return standingsTiebreak(rows, eloRatings);
}

export function getPosition(competition: Competition, clubId: number, eloRatings?: ReadonlyMap<number, number>): number {
  const rows = sortedStandings(competition, eloRatings);
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

// ---------------------------------------------------------------------------
// New-club sell lock (anti-funnel / anti-farm)
// ---------------------------------------------------------------------------

/**
 * League matches actually played by a club in the current season, counted from
 * played fixtures — deliberately NOT from StandingsRow.played /
 * MpClubSeason.played, which a mid-season joiner inherits from the replaced AI
 * club. Historical fixtures keep the retired AI's id, so fixture counting
 * correctly yields 0 for the joining club.
 */
export function matchesPlayedByClub(world: World, clubId: number): number {
  const activeDivisionIds = new Set(
    world.competitions
      .filter((c) => c.kind === "division" && c.status !== "ARCHIVED" && c.seasonId === world.mp.seasonId)
      .map((c) => c.id)
  );
  let played = 0;
  for (const f of world.fixtures) {
    if (!f.played || !activeDivisionIds.has(f.competitionId)) continue;
    if (f.homeClubId === clubId || f.awayClubId === clubId) played++;
  }
  return played;
}

/**
 * Outbound-market lock for fresh HUMAN clubs: a club may buy players and
 * release players immediately, but may not list players for transfer auction
 * or loan until it has played the configured number of its OWN league matches.
 * Filler AI clubs are exempt — they are ephemeral market supply, not
 * funnel participants. Returns an error string while locked, else null.
 */
export function newClubSellLockError(world: World, clubId: number): string | null {
  const club = world.clubs.find((c) => c.id === clubId);
  if (!club || club.ownerUserId === null) return null;
  const required = MP_CONFIG.newClubSellLockMatches;
  const played = matchesPlayedByClub(world, clubId);
  if (played >= required) return null;
  return `New clubs can sell or loan out players after ${required} played matches (${required - played} more to go)`;
}
