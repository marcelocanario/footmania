import { useCallback, useEffect, useState } from "react";
import { Award, History as HistoryIcon, Medal, Trophy } from "lucide-react";
import { api, type SeasonAward, type SeasonHistoryView } from "../api/client";
import { ArchivedSeasonCard } from "../components/ArchivedSeasonCard";
import { FootmaniaRankingPanel } from "../components/FootmaniaRanking";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";
import { bestXiEntries } from "../utils/awards";
import { useGame } from "../store/game";

const RECORD_LABELS: Record<string, string> = {
  all_time_goals: "All-time top scorer",
  all_time_top_scorer: "All-time top scorer",
  most_goals_in_season: "Most goals in a season",
  most_titles: "Most league titles",
  most_league_titles: "Most league titles",
  longest_unbeaten: "Longest unbeaten run",
};

const AWARD_LABELS: Record<string, string> = {
  top_scorer: "Top scorer",
  top_assists: "Top assists",
  player_of_season: "Player of the season",
  best_xi: "Best XI",
};

/** Best XI members; only players still in the world are clickable. */
function AwardDetail({ award, onPlayerClick }: { award: SeasonAward; onPlayerClick?: (id: number, name: string) => void }) {
  const entries = bestXiEntries(award);
  if (!entries) return <strong>{award.detail ?? ""}</strong>;
  return (
    <strong style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", justifyContent: "flex-end" }}>
      {entries.map((entry, index) => (
        <span key={`${entry.id ?? entry.name}-${index}`} style={{ whiteSpace: "nowrap" }}>
          {entry.active && entry.id !== null && onPlayerClick ? (
            <button type="button" className="event-player-link" onClick={() => onPlayerClick(entry.id as number, entry.name)}>{entry.name}</button>
          ) : (
            <span title={entry.active ? undefined : "Retired"}>{entry.name}</span>
          )}
        </span>
      ))}
    </strong>
  );
}

export function History() {
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

  if (historyError) return <div className="empty-state" style={{ paddingTop: 80 }}>Could not load history: {historyError}</div>;
  if (!seasons) return <div className="empty-state" style={{ paddingTop: 80 }}>Loading…</div>;

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
          <div className="kicker"><HistoryIcon size={14} /> Club history</div>
          <h1>The archive</h1>
          <p>Every campaign, every division, every club that helped build the Footmania pyramid.</p>
        </div>
        <div className="history-hero-seal">
          <Trophy size={28} />
          <span>World football<br /><b>since kickoff</b></span>
        </div>
      </section>

      <div className="history-overview-grid">
        <section className="card history-journey-card">
          <div className="history-section-head">
            <div>
              <div className="kicker">Your footprint</div>
              <h2>Your journey</h2>
            </div>
            <span className="history-section-note">{myRows.length ? `${myRows.length} recorded campaigns` : "No archived campaigns"}</span>
          </div>
          <div className="history-stat-grid">
            <div className="history-stat-card"><span>Seasons</span><b>{myRows.length}</b></div>
            <div className="history-stat-card"><span>Your divisions</span><b>{myDivisionCount}</b></div>
            <div className="history-stat-card"><span>League titles</span><b>{titles}</b></div>
            <div className="history-stat-card"><span>Best finish</span><b>{bestFinish === null ? "—" : `#${bestFinish}`}</b></div>
          </div>
          {myRows.length === 0 && <div className="history-callout">Your club will appear here after its first completed season.</div>}
          {myRows.length > 0 && <div className="history-callout good">Your rows are highlighted throughout the world archive.</div>}
        </section>
        {ranking ? (
          <FootmaniaRankingPanel rankings={ranking.rankings} totalRanked={ranking.totalRanked} viewerRank={ranking.viewerRank} />
        ) : (
          <section className="card footmania-ranking-panel"><div className="history-section-head"><div><div className="kicker">World ranking</div><h2>Footmania ranking</h2></div></div><div className="empty-state" style={{ padding: "28px 10px" }}>{rankingError ?? "Loading ranking…"}</div></section>
        )}
      </div>

      <div className="history-hall-grid">
        <section className="card history-records-card">
          <div className="history-section-head">
            <div><div className="kicker">The record book</div><h2><Trophy size={18} /> Career records</h2></div>
            <span className="history-section-note">All clubs</span>
          </div>
          {records.length === 0 ? <div className="empty-state">Records will appear after the first season.</div> : (
            <div className="history-record-list">
              {records.map((record) => (
                <div className="history-record" key={record.category}>
                  <span className="history-record-value">{record.value}</span>
                  <span className="history-record-label">{RECORD_LABELS[record.category] ?? record.category}</span>
                  <b>{record.holderName}</b>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card history-awards-card">
          <div className="history-section-head">
            <div><div className="kicker">Season honours</div><h2><Medal size={18} /> Recent awards</h2></div>
            <span className="history-section-note">Latest 20</span>
          </div>
          {awards.length === 0 ? <div className="empty-state">Season awards will appear at rollover.</div> : (
            <div className="history-award-list">
              {awards.slice(0, 20).map((award, index) => (
                <div className="history-award" key={`${award.season}-${award.category}-${award.competitionId}-${index}`}>
                  <span className="history-award-icon"><Award size={15} /></span>
                  <div><b>{AWARD_LABELS[award.category] ?? award.category.replaceAll("_", " ")}</b><span>Season {award.season} · {award.playerNameSnapshot ?? "Club honour"}</span></div>
                  <AwardDetail award={award} onPlayerClick={(id, name) => setPlayerTarget({ id, name })} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="history-seasons-section">
        <div className="history-section-head history-seasons-head">
          <div><div className="kicker">The pyramid archive</div><h2>Season by season</h2></div>
          <span className="history-section-note">{seasons.length} completed {seasons.length === 1 ? "season" : "seasons"}</span>
        </div>
        {seasons.length === 0 ? (
          <div className="card empty-state"><HistoryIcon size={30} /><span>No completed seasons yet. History appears after the first season rollover.</span></div>
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
