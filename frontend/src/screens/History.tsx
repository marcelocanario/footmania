import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Award, History as HistoryIcon, Medal, Trophy } from "lucide-react";
import { api, type SeasonAward, type SeasonHistoryView, type TeamProfile } from "../api/client";
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

/**
 * Per-club history (/history/:clubId) in the world-archive layout: the viewed
 * club's journey, the global record book / awards / ranking, and the
 * season-by-season archive with the viewed club's rows highlighted. Bare
 * /history redirects to the viewer's own club, so this screen always has a
 * target club. Reached from the History tab of /team/:clubId.
 */
export function History() {
  const { t } = useTranslation();
  const { clubId } = useParams();
  const targetClubId = Number(clubId);
  const targetValid = Number.isInteger(targetClubId) && targetClubId > 0;
  const [seasons, setSeasons] = useState<SeasonHistoryView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [profile, setProfile] = useState<TeamProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [ranking, setRanking] = useState<Awaited<ReturnType<typeof api.footmaniaRanking>> | null>(null);
  const [rankingError, setRankingError] = useState<string | null>(null);
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);
  const snapshot = useGame((state) => state.snapshot);
  const status = useGame((state) => state.status);
  const ownClubId = status?.userClubId ?? snapshot?.club?.id ?? null;
  const load = useCallback(() => {
    setHistoryError(null);
    return api.history().then((res) => setSeasons(res.seasons)).catch((e) => setHistoryError((e as Error).message));
  }, []);
  const loadRanking = useCallback(() => {
    setRankingError(null);
    return api.footmaniaRanking().then(setRanking).catch((e) => setRankingError((e as Error).message));
  }, []);
  const loadProfile = useCallback(() => {
    if (!targetValid) return;
    setProfile(null);
    setProfileError(null);
    return api.teamProfile(targetClubId).then(setProfile).catch((e) => setProfileError((e as Error).message));
  }, [targetClubId, targetValid]);

  useEffect(() => {
    void load();
    void loadRanking();
    return api.cache.subscribe((scope) => {
       if (scope === "mp" || scope === "history" || scope === "background:history") void load();
       if (scope === "mp" || scope === "background:mp" || scope === "background:club") void loadRanking();
    });
  }, [load, loadRanking]);

  useEffect(() => {
    void loadProfile();
    return api.cache.subscribe((scope) => {
      if (scope === "mp" || scope === "background:mp") void loadProfile();
    });
  }, [loadProfile]);

  if (!targetValid) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("team.unknown")}</div>;
  if (historyError) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("history.loadFailed", { error: historyError })}</div>;
  if (profileError) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("team.unknown")}</div>;
  if (!seasons || !profile) return <div className="empty-state" style={{ paddingTop: 80 }}>{t("history.loadingDots")}</div>;

  const isOwn = ownClubId !== null && targetClubId === ownClubId;
  const clubName = profile.club.name;
  const records = snapshot?.records ?? [];
  const awards = snapshot?.seasonAwards ?? [];
  const clubRows = seasons.flatMap((season) => season.divisions.flatMap((division) => division.standings.filter((row) => row.clubId === targetClubId)));
  const clubFinishes = seasons.flatMap((season) => season.divisions.flatMap((division) => {
    const position = division.standings.findIndex((row) => row.clubId === targetClubId);
    return position >= 0 ? [position + 1] : [];
  }));
  const clubDivisionCount = seasons.reduce((total, season) => total + season.divisions.filter((division) => division.standings.some((row) => row.clubId === targetClubId)).length, 0);
  const bestFinish = clubFinishes.length > 0 ? Math.min(...clubFinishes) : null;
  const titles = seasons.reduce((total, season) => total + season.divisions.filter((division) => division.standings[0]?.clubId === targetClubId).length, 0);

  return (
    <div className="history-page">
      <div style={{ marginBottom: 12 }}>
        <Link to={`/team/${targetClubId}`} className="btn ghost btn-xs" style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
          <ArrowLeft size={13} /> {t("history.backToTeam")}
        </Link>
      </div>
      <section className="history-hero">
        <div className="history-hero-floodlights" aria-hidden />
        <div className="history-hero-stripes" aria-hidden />
        <div className="history-hero-copy">
          <div className="kicker"><HistoryIcon size={14} /> {t("history.clubHistory")}</div>
          <h1>{isOwn ? t("history.theArchive") : t("history.archiveFor", { club: clubName })}</h1>
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
              <div className="kicker">{isOwn ? t("history.yourFootprint") : t("history.footprintFor", { club: clubName })}</div>
              <h2>{isOwn ? t("history.yourJourney") : t("history.journeyFor", { club: clubName })}</h2>
            </div>
            <span className="history-section-note">{clubRows.length ? t("history.recordedCampaigns", { count: clubRows.length }) : t("history.noArchivedCampaigns")}</span>
          </div>
          <div className="history-stat-grid">
            <div className="history-stat-card"><span>{t("history.seasons")}</span><b>{clubRows.length}</b></div>
            <div className="history-stat-card"><span>{t("history.yourDivisions")}</span><b>{clubDivisionCount}</b></div>
            <div className="history-stat-card"><span>{t("history.leagueTitles")}</span><b>{titles}</b></div>
            <div className="history-stat-card"><span>{t("history.bestFinish")}</span><b>{bestFinish === null ? "—" : `#${bestFinish}`}</b></div>
          </div>
          {clubRows.length === 0 && <div className="history-callout">{isOwn ? t("history.firstSeasonNote") : t("history.firstSeasonNoteFor", { club: clubName })}</div>}
          {clubRows.length > 0 && <div className="history-callout good">{isOwn ? t("history.rowsHighlighted") : t("history.rowsHighlightedFor", { club: clubName })}</div>}
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
            {seasons.map((season, index) => <ArchivedSeasonCard key={season.seasonId} season={season} initialOpen={index === 0} highlightClubId={targetClubId} />)}
          </div>
        )}
      </section>

      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}
