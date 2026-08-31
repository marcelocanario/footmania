import type { LivePlayerScore } from "../api/client";
import { useTranslation } from "react-i18next";

/**
 * Per-player rating scoreboard (plan §17): live 3.0–10.0 ratings during the
 * match and persisted ratings after full time. The MVP is the highest-rated
 * player on the winning team. NR = under 10 minutes (not rated).
 */
export function PlayerScoresTable({
  scores,
  homeClubId,
  onPlayerClick,
  emptyText,
}: {
  scores: LivePlayerScore[];
  homeClubId: number;
  onPlayerClick?: (id: number, name: string) => void;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const empty = emptyText ?? t("playerScores.emptyDefault");
  if (scores.length === 0) {
    return <div className="empty-state" style={{ padding: 14 }}>{empty}</div>;
  }
  const displayRating = (s: LivePlayerScore) => (s.rating != null ? s.rating.toFixed(1) : t("playerScores.nr"));
  return (
    <div className="player-scores-table">
      {scores.map((s) => {
        const home = s.clubId === homeClubId;
        return (
          <div className={`player-score-row${s.won ? " won" : ""}`} key={s.playerId}>
            <span className={`ps-side ${home ? "ps-home" : "ps-away"}`}>{home ? t("playerScores.home") : t("playerScores.away")}</span>
            {onPlayerClick && s.name ? (
              <button type="button" className="event-player-link ps-name" onClick={(e) => { e.stopPropagation(); onPlayerClick(s.playerId, s.name ?? t("playerScores.fallbackId", { id: s.playerId })); }}>{s.name}</button>
            ) : (
              <span className="ps-name">{s.name ?? t("playerScores.fallbackId", { id: s.playerId })}</span>
            )}
            <span className="ps-detail">{s.role ?? ""}</span>
            <span className={`ps-score${s.rating == null ? " nr" : ""}`}>{displayRating(s)}</span>
          </div>
        );
      })}
    </div>
  );
}
