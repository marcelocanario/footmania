import { MIN_RATED_MINUTES, balancedZ, ratingFromBalancedZ, coarseRole, type CoarseRole } from "./player-rating";
import type { PlayerRatingAccum } from "./ratingObserver";
import type { Match, Player, RoleCalibrationEntry, PlayerMatchRatingEntry } from "./types";

/**
 * Match-finalization rating logic (plan §16/§18). Converts a live match's
 * per-player rating accumulator into durable PlayerMatchRating rows, applying
 * the season-frozen positional calibration and the 3.0–10.0 conversion.
 *
 * Pure + deterministic: identical accumulators produce identical rows, and no
 * RNG is consumed. Callers (finalizeLiveMatch, instant simulation) own the
 * persistence boundary.
 */

export interface MatchRatingsInput {
  match: Match;
  seasonId: number;
  tier: number;
  /** Season-frozen calibration per coarse role (may be empty for a fresh
   *  season — then Z_raw is used as-is per plan §10.2). */
  calibration: Record<string, RoleCalibrationEntry> | undefined;
  /** Accumulator from the live state (playerId -> accum). */
  accum: Record<number, PlayerRatingAccum> | undefined;
  /** Player roster to resolve club ids and deployed roles. */
  players: Player[];
}

export interface MatchRatingRow extends PlayerMatchRatingEntry {}

/** Primary role for calibration: the fine role with the most seconds
 *  (plan §10.1), mapped to its coarse group. Ties break to the earlier role
 *  (insertion order = appearance order). */
export function primaryCoarseRole(accum: PlayerRatingAccum): CoarseRole {
  // Strictly-greater wins, so equal seconds keep the earlier-seen role
  // (insertion order = appearance order). An empty accumulator has no fine
  // role at all and falls back to the neutral central-midfield group.
  let bestRole: string | null = null;
  let bestSeconds = -1;
  for (const [role, secs] of Object.entries(accum.roleSeconds)) {
    if (secs > bestSeconds) {
      bestRole = role;
      bestSeconds = secs;
    }
  }
  return bestRole === null ? "MID" : coarseRole(bestRole);
}

/** Compute the rating rows for a finalized match. Deterministic. */
export function computeMatchRatingRows(input: MatchRatingsInput): MatchRatingRow[] {
  const { match, seasonId, tier, calibration, accum, players } = input;
  if (!accum) return [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const rows: MatchRatingRow[] = [];
  for (const accumRow of Object.values(accum)) {
    const player = byId.get(accumRow.playerId);
    if (!player) continue;
    const minutes = Math.round(accumRow.roleSecondsTotal / 60);
    const role = primaryCoarseRole(accumRow);
    const rawZ = accumRow.rawVariance > 0 ? accumRow.rawImpact / Math.sqrt(accumRow.rawVariance) : 0;
    const cal = calibration?.[role];
    const balanced = balancedZ(rawZ, cal ? { role, zRaws: cal.zRaws, usable: cal.zRaws.length >= 2 } : undefined);
    const rating = minutes >= MIN_RATED_MINUTES ? ratingFromBalancedZ(balanced) : null;
    rows.push({
      matchId: match.id,
      playerId: accumRow.playerId,
      clubId: accumRow.clubId,
      seasonId,
      tier,
      primaryRole: role,
      minutesPlayed: minutes,
      rawImpact: accumRow.rawImpact,
      rawVariance: accumRow.rawVariance,
      rawZ,
      balancedZ: balanced,
      ratingExact: rating,
      shootingImpact: accumRow.categoryImpacts["shooting"] ?? 0,
      passingImpact: accumRow.categoryImpacts["passing"] ?? 0,
      dribblingImpact: accumRow.categoryImpacts["dribbling"] ?? 0,
      defendingImpact: accumRow.categoryImpacts["defending"] ?? 0,
      goalkeepingImpact: accumRow.categoryImpacts["goalkeeping"] ?? 0,
    });
  }
  return rows;
}

/** MVP from ratings (user directive): the player with the highest rating on
 *  the winning team who played at least MIN_RATED_MINUTES. Draws pick from
 *  both sides; no rated performer yields no MVP. */
export function mvpFromRatings(rows: MatchRatingRow[], match: Match): { playerId: number; clubId: number } | null {
  const rated = rows.filter((r) => r.ratingExact !== null && r.minutesPlayed >= MIN_RATED_MINUTES);
  if (rated.length === 0) return null;
  const homeWon = match.homeScore > match.awayScore;
  const awayWon = match.awayScore > match.homeScore;
  const draw = !homeWon && !awayWon;
  const eligible = draw ? rated : rated.filter((r) => (r.clubId === match.homeClubId ? homeWon : awayWon));
  if (eligible.length === 0) return null;
  let best = eligible[0];
  for (const r of eligible) {
    if ((r.ratingExact ?? 0) > (best.ratingExact ?? 0)) best = r;
  }
  return { playerId: best.playerId, clubId: best.clubId };
}

/** Live (in-progress) rating for one accumulator entry (plan §17): the raw
 *  standardized score with the season-frozen role calibration applied, shown
 *  on the 3.0–10.0 scale. Null before the player has 10 match-minutes. */
export function liveRatingFromAccum(
  accum: PlayerRatingAccum,
  calibration: Record<string, RoleCalibrationEntry> | undefined,
): number | null {
  if (accum.roleSecondsTotal / 60 < MIN_RATED_MINUTES) return null;
  const role = primaryCoarseRole(accum);
  const rawZ = accum.rawVariance > 0 ? accum.rawImpact / Math.sqrt(accum.rawVariance) : 0;
  const cal = calibration?.[role];
  const balanced = balancedZ(rawZ, cal ? { role, zRaws: cal.zRaws, usable: cal.zRaws.length >= 2 } : undefined);
  return ratingFromBalancedZ(balanced);
}
