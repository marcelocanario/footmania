import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Dialog } from "primereact/dialog";
import { CalendarDays, Handshake, HeartPulse, History, Landmark, ShieldAlert, Sparkles, Square, Target, Trophy, Wallet, Zap } from "lucide-react";
import { api, type PlayerHistorySeason, type PlayerHistoryView, type PlayerMatchScoreView } from "../api/client";
import { useGame } from "../store/game";
import { countryFlag } from "../countryFlags";
import { ClubNameLink } from "./ClubNameLink";
import { PlayerSkillsRadar } from "./PlayerSkillsRadar";
import { PlayerTrendSparkline } from "./PlayerTrendSparkline";
import { PlayerScoresBarChart } from "./PlayerScoresBarChart";
import { positionClass, positionLabel, positionLetter } from "../positions";
import { conditionLabel as conditionText } from "../condition";
import { money } from "../format";

/** Refresh the card while it is open so a goal scored mid-match (or the
 *  full-time commit right after) shows up without closing/reopening the dialog.
 *  The player-history endpoint bypasses the GET cache (it carries live-match
 *  deltas), so each poll reads the authoritative state. */
const CARD_REFRESH_MS = 10_000;

const seasonsOf = (days: number, seasonDays: number): string => {
  if (seasonDays <= 0) return i18n.t("playerDetails.days", { days });
  const s = Math.round(days / seasonDays);
  return i18n.t("playerDetails.seasons", { count: s });
};

export function PlayerDetailsDialog({ target, onClose }: { target: { id: number; name: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
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
    <Dialog header={t("playerDetails.title")} visible={target !== null} onHide={onClose} dismissableMask style={{ width: 520 }}>
      {!player ? (
        <div className="empty-state" style={{ padding: 20 }}>{busy ? t("playerDetails.loading") : t("playerDetails.unavailable")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`pos-tag ${positionClass(player.naturalPosition)}`} title={positionLabel(player.naturalPosition)}>{positionLetter(player.naturalPosition)}</span>
                  <span style={{ fontWeight: 800, fontSize: "1.1rem" }}>{player.displayName ?? player.name}</span>
                  {player.nickname && <span className="flag-chip" style={{ borderColor: "var(--gold-2)", color: "var(--gold-2)" }}>“{player.nickname}”</span>}
                  {player.onSale && <span className="flag-chip fc-accent" title={t("playerDetails.listedTip")}>{t("playerDetails.listed")}</span>}
                  {player.onLoan && <span className="flag-chip fc-loan" title={t("playerDetails.loanFromTip", { club: player.loanFromName ?? t("playerDetails.anotherClub") })}>{t("playerDetails.loan")}</span>}
                  {player.onLoanOut && <span className="flag-chip fc-loan" title={t("playerDetails.loanAtTip", { club: player.loanClubName ?? t("playerDetails.anotherClub") })}>{t("playerDetails.loanOut")}</span>}
                </div>
                <div style={{ color: "var(--text-2)", fontSize: "0.84rem", marginTop: 3 }}>
                  {player.clubId != null
                    ? <ClubNameLink clubId={player.clubId} name={player.clubName ?? ""} showCrest={false} />
                    : player.clubName ?? t("playerDetails.freeAgent")}
                </div>
                <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 2 }}>
                  <span title={player.country} aria-label={t("playerDetails.countryAria", { country: player.country })}>{country ? `${country} ` : ""}{player.country}</span> · {t("playerDetails.yrs", { age: player.age })} · <span title={positionLabel(player.naturalPosition)}>{player.naturalPosition}</span>
                </div>
              </div>
              <strong style={{ fontSize: "1.5rem", fontFamily: "var(--font-display)", color: "var(--grass-2)" }}>{player.overall}</strong>
            </div>

            <div className="player-card-section" style={{ marginTop: 14 }}>
              <div className="section-label">{t("playerDetails.contractMarket")}</div>
              <div className="player-facts-grid player-facts-finance">
                <div className="player-fact">
                  <span className="player-fact-icon"><Landmark size={15} /></span>
                  <span><span className="player-fact-label">{t("playerDetails.marketValue")}</span><strong>{money(player.value)}</strong></span>
                </div>
                <div className="player-fact">
                  <span className="player-fact-icon"><Wallet size={15} /></span>
                  <span><span className="player-fact-label">{t("playerDetails.salarySeason")}</span><strong>{money(player.salary)}</strong></span>
                </div>
                <div className="player-fact">
                  <span className="player-fact-icon"><CalendarDays size={15} /></span>
                  <span><span className="player-fact-label">{t("playerDetails.contract")}</span><strong>{seasonsOf(player.contractDays, seasonDays)}</strong></span>
                </div>
              </div>
            </div>

            <div className="player-card-section" style={{ marginTop: 12 }}>
              <div className="section-label">{t("playerDetails.performance")}</div>
              <div className="segmented player-performance-tabs" role="tablist" aria-label={t("playerDetails.detailsAria")}>
                <button type="button" role="tab" aria-selected={activeTab === "season"} className={activeTab === "season" ? "active" : ""} onClick={() => setActiveTab("season")}>
                  <Trophy size={14} /> {t("playerDetails.thisSeason")}
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "career"} className={activeTab === "career" ? "active" : ""} onClick={() => setActiveTab("career")}>
                  <History size={14} /> {t("playerDetails.career")} <span className="pro-tab-pill">{t("playerDetails.proPill")}</span>
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "skills"} className={activeTab === "skills" ? "active" : ""} onClick={() => setActiveTab("skills")}>
                  <Sparkles size={14} /> {t("playerDetails.skills")} {!ownTeam && <span className="pro-tab-pill">{t("playerDetails.proPill")}</span>}
                </button>
              </div>
              {activeTab === "season" ? (
                <>
                  <div className="player-facts-grid player-facts-performance">
                    <div className="player-fact">
                      <span className="player-fact-icon"><Zap size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.energyNow")}</span><strong>{Math.round(player.energy)}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><CalendarDays size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.appearances")}</span><strong>{player.seasonAppearances ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Target size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.goals")}</span><strong>{player.seasonGoals}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Handshake size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.assists")}</span><strong>{player.seasonAssists}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Trophy size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.mvp")}</span><strong>{player.seasonMvps ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><ShieldAlert size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.discipline")}</span><span className="player-stat-pair"><span className="player-card-yellow"><Square size={11} fill="currentColor" /> {t("playerDetails.yellow", { count: player.yellows })}</span><span className="player-card-red"><Square size={11} fill="currentColor" /> {t("playerDetails.red", { count: player.reds })}</span></span></span>
                    </div>
                  </div>
                  <div className="player-trend-grid">
                    <PlayerScoresBarChart
                      label={t("playerDetails.avgRatingThisSeason")}
                      points={thisSeasonScores.map((m) => ({
                        key: `m${m.matchId}`,
                        value: m.rating,
                        title: t("playerDetails.ratingTitle", { result: m.result ?? "", minutes: m.minutesPlayed ?? "?", rating: m.rating != null ? m.rating.toFixed(1) : t("playerScores.nr") }),
                      }))}
                      maxScore={10}
                      sideValue={currentSeasonAvg}
                    />
                  </div>
                  <div className="player-current-status">
                    {player.conditionLabel && (
                      <span className="chip"><Zap size={12} /> {conditionText(player.conditionLabel)}</span>
                    )}
                    {player.injuryDays > 0 && (
                      <span className="chip player-status-danger"><HeartPulse size={12} /> {t("playerDetails.injured", { days: player.injuryDays })}</span>
                    )}
                    {player.suspended && (
                      <span className="chip player-status-danger"><ShieldAlert size={12} /> {t("playerDetails.suspended", { count: player.suspendedGames })}</span>
                    )}
                  </div>
                </>
              ) : activeTab === "skills" ? (
                !canSeeSkills || !player.skills ? (
                  <div className="player-pro-gate">
                    <Sparkles size={22} />
                    <strong>{t("playerDetails.skillsProTitle")}</strong>
                    <span>{t("playerDetails.skillsProBody")}</span>
                  </div>
                ) : (
                  <PlayerSkillsRadar skills={player.skills} />
                )
              ) : !isPro ? (
                <div className="player-pro-gate">
                  <History size={22} />
                  <strong>{t("playerDetails.careerProTitle")}</strong>
                  <span>{t("playerDetails.careerProBody")}</span>
                </div>
              ) : (
                <>
                  <div className="player-facts-grid player-facts-career">
                    <div className="player-fact">
                      <span className="player-fact-icon"><Target size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.careerGoals")}</span><strong>{player.careerGoals}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Handshake size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.careerAssists")}</span><strong>{player.careerAssists}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Trophy size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.careerMvp")}</span><strong>{player.careerMvps ?? 0}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><Landmark size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.clubsRepresented")}</span><strong>{careerClubs.size}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><CalendarDays size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.seasonsCount")}</span><strong>{historySeasons.length + 1}</strong></span>
                    </div>
                    <div className="player-fact">
                      <span className="player-fact-icon"><ShieldAlert size={15} /></span>
                      <span><span className="player-fact-label">{t("playerDetails.careerDiscipline")}</span><span className="player-stat-pair"><span className="player-card-yellow"><Square size={11} fill="currentColor" /> {t("playerDetails.yellow", { count: careerYellows })}</span><span className="player-card-red"><Square size={11} fill="currentColor" /> {t("playerDetails.red", { count: careerReds })}</span></span></span>
                    </div>
                  </div>
                  <div className="player-trend-grid">
                    <PlayerTrendSparkline label={t("playerDetails.overallPerSeason")} values={overallTrend} />
                    <PlayerTrendSparkline label={t("playerDetails.valuePerSeason")} values={valueTrend} unit="money" />
                    <PlayerScoresBarChart
                      label={t("playerDetails.avgRatingPerSeason")}
                      unit="avg"
                      points={trendSeasons.map((s) => ({
                        key: s.seasonKey,
                        value: s.avgScore ?? null,
                        title: t("playerDetails.avgTitle", { key: s.seasonKey, avg: (s.avgScore ?? 0).toFixed(1) }) as string,
                      })).concat(
                        currentSeasonAvg != null ? [{ key: "current", value: currentSeasonAvg, title: t("playerDetails.thisSeasonAvgTitle", { avg: currentSeasonAvg.toFixed(1) }) as string }] : []
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
