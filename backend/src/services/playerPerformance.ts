import { EVENT_CODES, GOAL_SUBTYPES } from "../game/constants";
import type { PlayerMatchRatingEntry, World } from "../game/types";

/** Display-ready match facts for one persisted player rating. The rating row
 * keeps the player's club at match time, which is essential after transfers. */
export function playerMatchScoreView(world: World, rating: PlayerMatchRatingEntry) {
  const match = world.matches.find((candidate) => candidate.id === rating.matchId);
  const events = match?.events ?? [];
  const goals = events.filter((event) =>
    event.type === EVENT_CODES.GOAL
    && event.goalType !== GOAL_SUBTYPES.PENALTY
    && event.playerId === rating.playerId,
  ).length;
  const assists = events.filter((event) =>
    event.type === EVENT_CODES.GOAL
    && event.goalType !== GOAL_SUBTYPES.PENALTY
    && event.player2Id === rating.playerId,
  ).length;
  const won = match
    ? (rating.clubId === match.homeClubId
      ? match.homeScore > match.awayScore
      : rating.clubId === match.awayClubId && match.awayScore > match.homeScore)
    : false;

  return {
    matchId: rating.matchId,
    score: rating.ratingExact ?? 0,
    rating: rating.ratingExact,
    goals,
    assists,
    won,
    result: match ? `${match.homeScore}-${match.awayScore}` : null,
    seasonId: rating.seasonId,
    minutesPlayed: rating.minutesPlayed,
    role: rating.primaryRole,
  };
}
