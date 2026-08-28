import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { CalendarDays, Handshake, HeartPulse, History, Landmark, ShieldAlert, Sparkles, Square, Target, Trophy, Wallet, Zap } from "lucide-react";
import { api, type PlayerHistorySeason, type PlayerHistoryView, type PlayerMatchScoreView } from "../api/client";
import { useGame } from "../store/game";
import { countryFlag } from "../countryFlags";
import { ClubNameLink } from "./ClubNameLink";
import { PlayerSkillsRadar } from "./PlayerSkillsRadar";
import { PlayerTrendSparkline } from "./PlayerTrendSparkline";
import { PlayerScoresBarChart } from "./PlayerScoresBarChart";
import { POSITION_CLASS, POSITION_LETTER, positionTitle } from "./PlayerName";
import { money } from "../format";

/** Refresh the card while it is open so a goal scored mid-match (or the
 *  full-time commit right after) shows up without closing/reopening the dialog.
 *  The player-history endpoint bypasses the GET cache (it carries live-match
 *  deltas), so each poll reads the authoritative state. */
const CARD_REFRESH_MS = 10_000;

const seasonsOf = (days: number, seasonDays: number): string => {
  if (seasonDays <= 0) return `${days}d`;
  const s = Math.round(days / seasonDays);
  return `${s} season${s === 1 ? "" : "s"}`;
};

export function PlayerDetailsDialog({ target, onClose }: { target: { id: number; name: string } | null; onClose: () => void }) {
  const [player, setPlayer] = useState<PlayerHistoryView | null>(null);
  const [historySeasons, setHistorySeasons] = useState<PlayerHistorySeason[]>([]);
  const [matchScores, setMatchScores] = useState<PlayerMatchScoreView[]>([]);
  const [currentSeasonAvg, setCurrentSeasonAvg] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"season" | "career" | "skills">("season");
  const [busy, setBusy] = useState(false);
  const user = useGame((state) => state.user);
  const seasonDays = useGame((state) => state.snapshot?.save.seasonDays ?? 30);

  useEffect(() => {
    if (!target) {
      setPlayer(null);
      setHistorySeasons([]);
      setMatchScores([]);
      setCurrentSeasonAvg(null);
      setActiveTab("season");
      return;
    }
    let alive = true;
    setBusy(true);
    setPlayer(null);
    setHistorySeasons([]);
    setMatchScores([]);
    setCurrentSeasonAvg(null);
    setActiveTab("season");
    const load = () =>
      api.playerHistory(target.id)
        .then((result) => {
          if (alive) {
            setPlayer(result.player);
            setHistorySeasons(result.seasons);
            setMatchScores(result.matchScores ?? []);
            setCurrentSeasonAvg(result.currentSeasonAvg ?? null);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setBusy(false);
        });
    void load();
    const interval = setInterval(load, CARD_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [target]);

  const ownTeam = player?.isOwnTeam ?? false;
  const isPro = Boolean(user?.isPro);
  const canSeeSkills = Boolean(player?.skills) && (ownTeam || Boolean(user?.isPro));
  // Scores for the current world season only (career history lives in the
  // season-average chart and the Squad history tab).
  const thisSeasonScores = matchScores.filter((m) => m.currentSeason);
  const country = player ? countryFlag(player.country) : null;
  const careerYellows = (player?.yellows ?? 0) + historySeasons.reduce((total, season) => total + season.yellows, 0);
  const careerReds = (player?.reds ?? 0) + historySeasons.reduce((total, season) => total + season.reds, 0);
  const careerClubs = new Set([
    ...historySeasons.map((season) => season.clubName),
    ...(player?.clubName ? [player.clubName] : []),
  ].filter(Boolean));
  // End-of-season snapshots plus the live current season as the newest point,
  // oldest first so the trend renders left→right.
  const trendSeasons = [...historySeasons].sort((a, b) => a.seasonId - b.seasonId);
  const overallTrend = player
    ? [...trendSeasons.map((s) => s.overall), player.overall]
    : trendSeasons.map((s) => s.overall);
  const valueTrend = player
    ? [...trendSeasons.map((s) => s.value), player.value]
    : trendSeasons.map((s) => s.value);

  return (
    <Dialog header="Player details" visible={target !== null} onHide={onClose} dismissableMask style={{ width: 520 }}>
      {!player ? (
        <div className="empty-state" style={{ padding: 20 }}>{busy ? "Loading…" : "Player details unavailable."}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`pos-tag ${POSITION_CLASS[player.position] ?? ""}`} title={positionTitle(player.position)}>{POSITION_LETTER[player.position] ?? "?"}</span>
                  <span style={{ fontWeight: 800, fontSize: "1.1rem" }}>{player.displayName ?? player.name}</span>
                  {player.nickname && <span className="flag-chip" style={{ borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>“{player.nickname}”</span>}
                  {player.onSale && <span className="flag-chip fc-accent" title="Listed on the transfer market">Listed</span>}
                  {player.onLoan && <span className="flag-chip fc-loan" title={`On loan from ${player.loanFromName ?? "another club"}`}>LOAN</span>}
                  {player.onLoanOut && <span className="flag-chip fc-loan" title={`On loan at ${player.loanClubName ?? "another club"}`}>LOAN OUT</span>}
                </div>
                <div style={{ color: "var(--text-2)", fontSize: "0.84rem", marginTop: 3 }}>
                  {player.clubId != null
                    ? <ClubNameLink clubId={player.clubId} name={player.clubName ?? ""} showCrest={false} />
                    : player.clubName ?? "Free agent"}
                </div>
                <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 2 }}>
                  <span title={player.country} aria-label={`Country: ${player.country}`}>{country ? `${country} ` : ""}{player.country}</span> · {player.age} yrs · <span title={positionTitle(player.position)}>{player.positionName}</span>
                </div>
              </div>
              <strong style={{ fontSize: "1.5rem", fontFamily: "var(--font-display)", color: "var(--grass-2)" }}>{player.overall}</strong>
            </div>

            <div className="player-card-section" style={{ marginTop: 14 }}>
              <div className="section-label">Contract & market</div>
              <div className="player-facts-grid player-facts-finance">
                <div className="player-fact">
                  <span className="player-fact-icon"><Landmark size={15} /></span>
                  <span><span className="player-fact-label">Market value</span><strong>{money(player.value)}</strong></span>
                </div>
                <div className="player-fact">
                  <span className="player-fact-icon"><Wallet size={15} /></span>
                  <span><span className="player-fact-label">Salary / season</span><strong>{money(player.salary)}</strong></span>
                </div>
                <div className="player-fact">
                  <span className="player-fact-icon"><CalendarDays size={15} /></span>
                  <span><span className="player-fact-label">Contract</span><strong>{seasonsOf(player.contractDays, seasonDays)}</strong></span>
                </div>
              </div>
            </div>

            <div className="player-card-section" style={{ marginTop: 12 }}>
              <div className="section-label">Performance</div>
              <div className="segmented player-performance-tabs" role="tablist" aria-label="Player details">
                <button type="button" role="tab" aria-selected={activeTab === "season"} className={activeTab === "season" ? "active" : ""} onClick={() => setActiveTab("season")}>
                  <Trophy size={14} /> This season
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "career"} className={activeTab === "career" ? "active" : ""} onClick={() => setActiveTab("career")}>
                  <History size={14} /> Career <span className="pro-tab-pill">PRO</span>
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "skills"} className={activeTab === "skills" ? "active" : ""} onClick={() => setActiveTab("skills")}>
                  <Sparkles size={14} /> Skills {!ownTeam && <span className="pro-tab-pill">PRO</span>}
                </button>
              </div>
              {activeTab === "season" ? (
                <>
                  <div className="player-facts-grid player-facts-performance">
                    <div className="player-fact">
                      <span className="player-fact-icon"><Zap size={15} /></span>
                      <span><span className="player-fact-label">Energy now</span><strong>{Math.round(player.energy)}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><CalendarDays size={15} /></span>
                      <span><span className="player-fact-label">Appearances</span><strong>{player.seasonAppearances ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Target size={15} /></span>
                      <span><span className="player-fact-label">Goals</span><strong>{player.seasonGoals}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Handshake size={15} /></span>
                      <span><span className="player-fact-label">Assists</span><strong>{player.seasonAssists}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Trophy size={15} /></span>
                      <span><span className="player-fact-label">MVP</span><strong>{player.seasonMvps ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><ShieldAlert size={15} /></span>
                      <span><span className="player-fact-label">Discipline</span><span className="player-stat-pair"><span className="player-card-yellow"><Square size={11} fill="currentColor" /> {player.yellows} yellow</span><span className="player-card-red"><Square size={11} fill="currentColor" /> {player.reds} red</span></span></span>
                    </div>
                  </div>
                  <div className="player-trend-grid">
                    <PlayerScoresBarChart
                      label="Avg rating · this season"
                      points={thisSeasonScores.map((m) => ({
                        key: `m${m.matchId}`,
                        value: m.rating,
                        title: `${m.result ?? ""} · ${m.minutesPlayed ?? "?"}' · rating ${m.rating != null ? m.rating.toFixed(1) : "NR"}`,
                      }))}
                      maxScore={10}
                      sideValue={currentSeasonAvg}
                    />
                  </div>
                  <div className="player-current-status">
                    {player.conditionLabel && (
                      <span className="chip"><Zap size={12} /> {player.conditionLabel}</span>
                    )}
                    {player.injuryDays > 0 && (
                      <span className="chip player-status-danger"><HeartPulse size={12} /> Injured · {player.injuryDays}d</span>
                    )}
                    {player.suspended && (
                      <span className="chip player-status-danger"><ShieldAlert size={12} /> Suspended {player.suspendedGames}</span>
                    )}
                  </div>
                </>
              ) : activeTab === "skills" ? (
                !canSeeSkills || !player.skills ? (
                  <div className="player-pro-gate">
                    <Sparkles size={22} />
                    <strong>Player skills are a Pro feature</strong>
                    <span>Skill profiles of other clubs' players are available to Pro managers.</span>
                  </div>
                ) : (
                  <PlayerSkillsRadar skills={player.skills} />
                )
              ) : !isPro ? (
                <div className="player-pro-gate">
                  <History size={22} />
                  <strong>Career performance is a Pro feature</strong>
                  <span>Historical season records, career totals, and discipline history are available to Pro managers.</span>
                </div>
              ) : (
                <>
                  <div className="player-facts-grid player-facts-career">
                    <div className="player-fact">
                      <span className="player-fact-icon"><Target size={15} /></span>
                      <span><span className="player-fact-label">Career goals</span><strong>{player.careerGoals}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Handshake size={15} /></span>
                      <span><span className="player-fact-label">Career assists</span><strong>{player.careerAssists}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Trophy size={15} /></span>
                      <span><span className="player-fact-label">Career MVP</span><strong>{player.careerMvps ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Landmark size={15} /></span>
                      <span><span className="player-fact-label">Clubs represented</span><strong>{careerClubs.size}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><CalendarDays size={15} /></span>
                      <span><span className="player-fact-label">Seasons</span><strong>{historySeasons.length + 1}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><ShieldAlert size={15} /></span>
                      <span><span className="player-fact-label">Career discipline</span><span className="player-stat-pair"><span className="player-card-yellow"><Square size={11} fill="currentColor" /> {careerYellows} yellow</span><span className="player-card-red"><Square size={11} fill="currentColor" /> {careerReds} red</span></span></span>
                    </div>
                  </div>
                  <div className="player-trend-grid">
                    <PlayerTrendSparkline label="Overall per season" values={overallTrend} />
                    <PlayerTrendSparkline label="Market value per season" values={valueTrend} unit="money" />
                    <PlayerScoresBarChart
                      label="Avg rating per season"
                      unit="avg"
                      points={trendSeasons.map((s) => ({
                        key: s.seasonKey,
                        value: s.avgScore ?? null,
                        title: `${s.seasonKey} · avg ${(s.avgScore ?? 0).toFixed(1)}`,
                      })).concat(
                        currentSeasonAvg != null ? [{ key: "current", value: currentSeasonAvg, title: `This season · avg ${currentSeasonAvg.toFixed(1)}` }] : []
                      )}
                      maxScore={10}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
