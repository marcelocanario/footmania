import { ELO_CONFIG } from "../config";
import type { Club, Match, World } from "./types";

export interface EloChange {
  expectedHome: number;
  expectedAway: number;
  deltaHome: number;
  deltaAway: number;
  actualHome: number;
  actualAway: number;
}

export function calculateEloChange(homeRating: number, awayRating: number, homeScore: number, awayScore: number): EloChange {
  const expectedHome = 1 / (1 + Math.pow(10, (awayRating - (homeRating + ELO_CONFIG.homeAdvantage)) / ELO_CONFIG.scale));
  const expectedAway = 1 - expectedHome;
  const actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  const actualAway = 1 - actualHome;
  return {
    expectedHome,
    expectedAway,
    deltaHome: ELO_CONFIG.kFactor * (actualHome - expectedHome),
    deltaAway: ELO_CONFIG.kFactor * (actualAway - expectedAway),
    actualHome,
    actualAway,
  };
}

/** Apply one completed official senior human-v-human match exactly once. */
export function applyMatchElo(world: World, match: Match): boolean {
  if (match.eloProcessed) return false;
  match.eloProcessed = true;
  if (match.homeWasHuman !== true || match.awayWasHuman !== true) return false;

  const home = world.clubs.find((club) => club.id === match.homeClubId);
  const away = world.clubs.find((club) => club.id === match.awayClubId);
  if (!home || !away) return false;

  const change = calculateEloChange(home.eloRating ?? ELO_CONFIG.initial, away.eloRating ?? ELO_CONFIG.initial, match.homeScore, match.awayScore);
  const homeBefore = home.eloRating ?? ELO_CONFIG.initial;
  const awayBefore = away.eloRating ?? ELO_CONFIG.initial;
  home.eloRating = homeBefore + change.deltaHome;
  away.eloRating = awayBefore + change.deltaAway;
  home.eloRatedMatches = (home.eloRatedMatches ?? 0) + 1;
  away.eloRatedMatches = (away.eloRatedMatches ?? 0) + 1;
  const createdAt = Date.now();
  (world.clubEloEvents ??= []).push(
    {
      id: world.nextId++, matchId: match.id, clubId: home.id, opponentClubId: away.id,
      ratingBefore: homeBefore, ratingAfter: homeBefore + change.deltaHome, delta: change.deltaHome,
      expectedScore: change.expectedHome, actualScore: change.actualHome, createdAt,
    },
    {
      id: world.nextId++, matchId: match.id, clubId: away.id, opponentClubId: home.id,
      ratingBefore: awayBefore, ratingAfter: awayBefore + change.deltaAway, delta: change.deltaAway,
      expectedScore: change.expectedAway, actualScore: change.actualAway, createdAt,
    },
  );
  return true;
}

export function applySeasonalEloRegression(world: World): void {
  for (const club of world.clubs) {
    if (club.ownerUserId === null) continue;
    club.eloRating = ELO_CONFIG.initial + ELO_CONFIG.seasonRetention * ((club.eloRating ?? ELO_CONFIG.initial) - ELO_CONFIG.initial);
  }
}

export function eloRatings(world: World): ReadonlyMap<number, number> {
  return new Map(world.clubs.map((club) => [club.id, club.eloRating ?? ELO_CONFIG.initial]));
}

export function displayElo(club: Club): number {
  return Math.round(club.eloRating ?? ELO_CONFIG.initial);
}
