import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Award, History as HistoryIcon, Medal, Trophy } from "lucide-react";
import { api, type SeasonAward, type SeasonHistoryView } from "../api/client";
import { bestXiEntries, individualAwardDetail } from "../utils/awards";
import { ArchivedSeasonCard } from "../components/ArchivedSeasonCard";
import { FootmaniaRankingPanel } from "../components/FootmaniaRanking";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";
import { useGame } from "../store/game";

const RECORD_LABELS: Record<string, string> = {
  all_time_goals: "history.recordAllTimeScorer",
  all_time_top_scorer: "history.recordAllTimeScorer",
  most_goals_in_season: "history.recordMostGoalsSeason",
  most_titles: "history.recordMostTitles",
  most_league_titles: "history.recordMostTitles",
  longest_unbeaten: "history.recordLongestUnbeaten",
};

const AWARD_LABELS: Record<string, string> = {
  top_scorer: "awards.categoryTopScorer",
  top_assists: "awards.categoryTopAssists",
  player_of_season: "awards.categoryPlayerOfSeason",
  best_xi: "awards.categoryBestXi",
};

/** Best XI members; only players still in the world are clickable. */
function AwardDetail({ award, onPlayerClick }: { award: SeasonAward; onPlayerClick?: (id: number, name: string) => void }) {
  const { t } = useTranslation();
  const entries = bestXiEntries(award);
  if (!entries) return <strong>{individualAwardDetail(award)}</strong>;
  return (
    <strong style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", justifyContent: "flex-end" }}>
      {entries.map((entry, index) => (
        <span key={`${entry.id ?? entry.name}-${index}`} style={{ whiteSpace: "nowrap" }}>
          {entry.active && entry.id !== null && onPlayerClick ? (
            <button type="button" className="event-player-link" onClick={() => onPlayerClick(entry.id as number, entry.name)}>{entry.name}</button>
          ) : (
            <span title={entry.active ? undefined : t("history.retired")}>{entry.name}</span>
          )}
        </span>
      ))}
    </strong>
  );
}

export function History() {
  const { t } = useTranslation();
  const [seasons, setSeasons] = useState<SeasonHistoryView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [ranking, setRanking] = useState<Awaited<ReturnType<typeof api.footmaniaRanking>> | null>(null);
  const [rankingError, setRankingError] = useState<string | null>(null);
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);
  const snapshot = useGame((state) => state.snapshot);
  const load = useCallback(() => {
    setHistoryError(null);
    return api.history().then((res) => setSeasons(res.seasons)).catch((e) => setHistoryError((e as Error).message));
  }, []);
  const loadRanking = useCallback(() => {
    setRankingError(null);
    return api.footmaniaRanking().then(setRanking).catch((e) => setRankingError((e as Error).message));
  }, []);

  useEffect(() => {
    void load();
    void loadRanking();
    return api.cache.subscribe((scope) => {
       if (scope === "mp" || scope === "history" || scope === "background:history") void load();
       if (scope === "mp" || scope === "background:mp" || scope === "background:club") void loadRanking();
    });
  }, [load, loadRanking]);

  if (historyError) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("history.loadFailed", { error: historyError })}</div>;
  if (!seasons) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("history.loadingDots")}</div>;

  const records = snapshot?.records ?? [];
  const awards = snapshot?.seasonAwards ?? [];
  const myRows = seasons.flatMap((season) => season.divisions.flatMap((division) => division.standings.filter((row) => row.isMine)));
  const myFinishes = seasons.flatMap((season) => season.divisions.flatMap((division) => {
    const position = division.standings.findIndex((row) => row.isMine);
    return position >= 0 ? [position + 1] : [];
  }));
  const myDivisionCount = seasons.reduce((total, season) => total + season.divisions.filter((division) => division.standings.some((row) => row.isMine)).length, 0);
  const bestFinish = myFinishes.length > 0 ? Math.min(...myFinishes) : null;
  const titles = seasons.reduce((total, season) => total + season.divisions.filter((division) => division.standings[0]?.isMine).length, 0);

  return (
    <div className="history-page">
      <section className="history-hero">
        <div className="history-hero-floodlights" aria-hidden />
        <div className="history-hero-stripes" aria-hidden />
        <div className="history-hero-copy">
          <div className="kicker"><HistoryIcon size={14} /> {t("history.clubHistory")}</div>
          <h1>{t("history.theArchive")}</h1>
          <p>{t("history.heroIntro")}</p>
        </div>
        <div className="history-hero-seal">
          <Trophy size={28} />
          <span>{t("history.worldFootball")}<br /><b>{t("history.sinceKickoff")}</b></span>
        </div>
      </section>

      <div className="history-overview-grid">
        <section className="card history-journey-card">
          <div className="history-section-head">
            <div>
              <div className="kicker">{t("history.yourFootprint")}</div>
              <h2>{t("history.yourJourney")}</h2>
            </div>
            <span className="history-section-note">{myRows.length ? t("history.recordedCampaigns", { count: myRows.length }) : t("history.noArchivedCampaigns")}</span>
          </div>
          <div className="history-stat-grid">
            <div className="history-stat-card"><span>{t("history.seasons")}</span><b>{myRows.length}</b></div>
            <div className="history-stat-card"><span>{t("history.yourDivisions")}</span><b>{myDivisionCount}</b></div>
            <div className="history-stat-card"><span>{t("history.leagueTitles")}</span><b>{titles}</b></div>
            <div className="history-stat-card"><span>{t("history.bestFinish")}</span><b>{bestFinish === null ? "—" : `#${bestFinish}`}</b></div>
          </div>
          {myRows.length === 0 && <div className="history-callout">{t("history.firstSeasonNote")}</div>}
          {myRows.length > 0 && <div className="history-callout good">{t("history.rowsHighlighted")}</div>}
        </section>
        {ranking ? (
          <FootmaniaRankingPanel rankings={ranking.rankings} totalRanked={ranking.totalRanked} viewerRank={ranking.viewerRank} />
        ) : (
          <section className="card footmania-ranking-panel"><div className="history-section-head"><div><div className="kicker">{t("history.worldRanking")}</div><h2>{t("history.footmaniaRanking")}</h2></div></div><div className="empty-state" style={{ padding: "28px 10px" }}>{rankingError ?? t("history.loadingRanking")}</div></section>
        )}
      </div>

      <div className="history-hall-grid">
        <section className="card history-records-card">
          <div className="history-section-head">
            <div><div className="kicker">{t("history.recordBook")}</div><h2><Trophy size={18} /> {t("history.careerRecords")}</h2></div>
            <span className="history-section-note">{t("history.allClubs")}</span>
          </div>
          {records.length === 0 ? <div className="empty-state">{t("history.recordsEmpty")}</div> : (
            <div className="history-record-list">
              {records.map((record) => (
                <div className="history-record" key={record.category}>
                  <span className="history-record-value">{record.value}</span>
                  <span className="history-record-label">{(t as unknown as (k: string) => string)(RECORD_LABELS[record.category] ?? record.category)}</span>
                  <b>{record.holderName}</b>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card history-awards-card">
          <div className="history-section-head">
            <div><div className="kicker">{t("history.seasonHonours")}</div><h2><Medal size={18} /> {t("history.recentAwards")}</h2></div>
            <span className="history-section-note">{t("history.latest20")}</span>
          </div>
          {awards.length === 0 ? <div className="empty-state">{t("history.awardsEmpty")}</div> : (
            <div className="history-award-list">
              {awards.slice(0, 20).map((award, index) => (
                <div className="history-award" key={`${award.season}-${award.category}-${award.competitionId}-${index}`}>
                  <span className="history-award-icon"><Award size={15} /></span>
                  <div><b>{(t as unknown as (k: string) => string)(AWARD_LABELS[award.category] ?? award.category.replaceAll("_", " "))}</b><span>{t("history.seasonLabel", { season: award.season })} · {award.playerNameSnapshot ?? t("history.clubHonour")}</span></div>
                  <AwardDetail award={award} onPlayerClick={(id, name) => setPlayerTarget({ id, name })} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="history-seasons-section">
        <div className="history-section-head history-seasons-head">
          <div><div className="kicker">{t("history.pyramidArchive")}</div><h2>{t("history.seasonBySeason")}</h2></div>
          <span className="history-section-note">{seasons.length === 1 ? t("history.completedSeasons", { count: 1 }) : t("history.completedSeasonsOther", { count: seasons.length })}</span>
        </div>
        {seasons.length === 0 ? (
          <div className="card empty-state"><HistoryIcon size={30} /><span>{t("history.noCompletedSeasons")}</span></div>
        ) : (
          <div className="archive-season-list">
            {seasons.map((season, index) => <ArchivedSeasonCard key={season.seasonId} season={season} initialOpen={index === 0} />)}
          </div>
        )}
      </section>

      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}
