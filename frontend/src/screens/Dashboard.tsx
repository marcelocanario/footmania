import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ClipboardList, Radio, TrendingUp, Wallet, CalendarDays, Activity, Users, Trophy, ArrowRight, ChartNoAxesColumn, Clock, Hourglass, AlertTriangle, ChevronRight, Newspaper } from "lucide-react";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { useLiveMatch } from "../hooks/useAdvanceDay";
import { money } from "../format";
import { ClubCrest } from "../components/ClubCrest";
import { ClubNameLink } from "../components/ClubNameLink";
import { formatKickoff } from "../utils/time";
import { useNews } from "../i18n/news";

const NEWS_KIND_COLORS: Record<string, string> = {
  season: "var(--gold)",
  mp: "var(--gold)",
  contract: "var(--grass-2)",
  loan: "var(--grass-2)",
  injury: "var(--red-2)",
  finance: "var(--red-2)",
  tactics: "var(--blue)",
  academy: "var(--blue)",
  motd: "var(--gold-2)",
};

const PHASE_KEY: Record<string, "active" | "postMatch" | "interseason"> = { ACTIVE: "active", POST_MATCH: "postMatch", INTERSEASON: "interseason" };

export function Dashboard() {
  const { t } = useTranslation();
  const { snapshot, status, liveMatchId } = useGame();
  const navigate = useNavigate();
  const { busy, run } = useLiveMatch();
  const pregameWindowMinutes = useSettings((s) => s.pregameWindowMinutes);

  // Re-evaluate the pre-game prep window periodically so the amber banner
  // appears without waiting for a data refresh.
  const [now, setNow] = useState(() => Date.now());
  const news = useNews();
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const club = snapshot?.club;
  const provisional = club?.competitionState === "PROVISIONAL";
  const inactive = status?.club?.inactivity?.eligible;

  if (!snapshot || !club) {
    return (
      <div>
        <div className="empty-state" style={{ paddingTop: 80 }}>{t("common.loading")}</div>
      </div>
    );
  }

  const league = snapshot.competitions.find((c) => c.kind === "division" || c.kind === "league");
  const position = league?.position ?? null;
  const posClass = position !== null ? (position === 1 ? "gold" : "") : "";
  const season = status?.season;
  // Browser-local kickoff rendering, shared with every other screen (plan 9).
const nextKickoff = snapshot.nextFixture ? formatKickoff(snapshot.nextFixture.kickoffAt) : "";

  const nextKickoffAt = snapshot.nextFixture?.kickoffAt ?? null;
  const msToKickoff = nextKickoffAt !== null ? nextKickoffAt - now : null;
  // The live banner wins once a match is actually in progress. A paused
  // season freezes every kickoff, so the prep banner must not open.
  const prepOpen = !liveMatchId && !status?.paused && msToKickoff !== null && msToKickoff > 0 && msToKickoff <= pregameWindowMinutes * 60_000;
  const phaseKey = season ? (PHASE_KEY[season.phase] ?? "active") : "active";

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
            {t("common.season")} {season?.seasonNumber ?? ""}
            {season && ` · ${t("dashboard.round", { round: season.completedRounds })}`}
            {season?.joinState === "OPEN" ? ` · ${t("dashboard.joinOpen")}` : ` · ${t("dashboard.joinLocked")}`}
            {season && ` · ${t("dashboard.dayProgress", { day: season.seasonDay, days: season.seasonDays })} · ${t(`dashboard.phase.${phaseKey}`)}`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 4 }}>
            <ClubCrest name={club.name} primary={club.primaryColor} secondary={club.secondaryColor} kit={club.kits?.home ?? null} size={48} clubId={club.id} hasCustomLogo={club.hasCustomLogo} />
            <h1>{club.name}</h1>
          </div>
<div className="head-chips">
            {league?.tier != null ? (
              <span className="chip">{t("dashboard.divisionGroup", { tier: league.tier, group: (league.groupIndex ?? 0) + 1 })}</span>
            ) : (
              <span className="chip">{t("team.country")} {club.country}</span>
            )}
          </div>
        </div>
      </div>

      {provisional && (
        <div className="card" style={{ borderColor: "rgba(240,180,41,0.5)", marginBottom: 16, padding: "22px 18px" }}>
          <h2 className="card-title" style={{ color: "var(--gold-2)" }}>
            <Hourglass size={17} /> {t("dashboard.provisionalTitle")}
          </h2>
          <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.55 }}>
            {t("dashboard.provisionalBody")}
          </div>
          <div style={{ color: "var(--gold-2)", fontSize: "0.9rem", marginTop: 8 }}>
            {t("dashboard.budgetReserved")}
            {status?.club?.reservedNextSeasonAllocation && ` ${t("dashboard.reservedAmount", { amount: money(status.club.reservedNextSeasonAllocation.amount) })}`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => navigate("/squad")}><Users size={14} /> {t("dashboard.squadBtn")}</button>
            <button className="btn sm ghost" onClick={() => navigate("/transfers")}><ArrowRight size={14} /> {t("dashboard.transfersBtn")}</button>
            <button className="btn sm ghost" onClick={() => navigate("/competitions")}><CalendarDays size={14} /> {t("dashboard.matchesBtn")}</button>
          </div>
        </div>
      )}

      {inactive && (
        <div className="card" style={{ borderColor: "rgba(220,120,60,0.5)", marginBottom: 16, padding: "18px 16px" }}>
          <h2 className="card-title" style={{ color: "var(--red-2)" }}>
            <Activity size={17} /> {t("dashboard.inactivityTitle")}
          </h2>
          <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
            {t("dashboard.inactivityBody")}
          </div>
        </div>
      )}

      {club.finance && club.finance.status !== "SAFE" && (
        <div className="card" style={{ borderColor: club.finance.status === "NEGATIVE_CASH" ? "rgba(220,80,80,0.5)" : "rgba(240,180,41,0.5)", marginBottom: 16, padding: "18px 16px" }}>
          <h2 className="card-title" style={{ color: club.finance.status === "NEGATIVE_CASH" ? "var(--red-2)" : "var(--gold-2)" }}>
            <AlertTriangle size={17} /> {club.finance.status === "NEGATIVE_CASH" ? t("dashboard.financeEmergency") : t("dashboard.financeWarning")}
          </h2>
          {provisional ? (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              {t("dashboard.financeProvisional", { cushion: money(club.finance.financialCushion) })}
            </div>
          ) : club.finance.status === "NEGATIVE_CASH" ? (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              {t("dashboard.financeNegative", { cash: money(club.cash) })}
            </div>
          ) : (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              {t("dashboard.financeWarningBody", { cushion: money(club.finance.financialCushion) })}
            </div>
          )}
          <button className="btn sm ghost" style={{ marginTop: 12 }} onClick={() => navigate("/finances")}>
            <Wallet size={14} /> {t("dashboard.viewFinances")}
          </button>
        </div>
      )}

      {prepOpen && (
        <div className="live-match-alert pregame" role="status" aria-labelledby="pregame-alert-title">
          <div className="live-match-alert-icon" aria-hidden="true">
            <ClipboardList size={22} />
          </div>
          <div className="live-match-alert-copy">
            <div className="live-match-alert-eyebrow">{t("dashboard.pregame")}</div>
            <h2 id="pregame-alert-title">{t("dashboard.pregameBannerTitle")}</h2>
            <p>{t("dashboard.pregameBannerHint")} Kick-off {nextKickoff}.</p>
          </div>
          <button className="btn gold live-match-alert-action" onClick={() => navigate("/pregame")}>
            <ClipboardList size={16} /> {t("dashboard.goToPregame")} <ArrowRight size={15} />
          </button>
        </div>
      )}

      {liveMatchId && (
        <div className="live-match-alert" role="status" aria-labelledby="live-match-alert-title">
          <div className="live-match-alert-icon" aria-hidden="true">
            <Radio size={22} />
          </div>
          <div className="live-match-alert-copy">
            <div className="live-match-alert-eyebrow">
              <span className="pulse-dot" /> {t("dashboard.liveMatch")}
            </div>
            <h2 id="live-match-alert-title">{t("dashboard.matchUnderway")}</h2>
            <p>{t("dashboard.liveMatchHint")}</p>
          </div>
          <button className="btn gold live-match-alert-action" onClick={() => void run()} disabled={busy}>
            <Radio size={16} /> {t("dashboard.goToMatch")} <ArrowRight size={15} />
          </button>
        </div>
      )}

      <div className="grid cols-3 stagger">
        <div className="card hoverable" role="link" tabIndex={0} onClick={() => navigate("/competitions")}
          onKeyDown={(e) => { if (e.key === "Enter") navigate("/competitions"); }}>
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><TrendingUp size={12} /> {t("dashboard.position")}</div>
            <div className="value" style={{ fontSize: "2.6rem", color: posClass === "gold" ? "var(--gold-2)" : undefined }}>
              {position ? `#${position}` : "—"}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", color: "var(--text-3)", marginTop: 8 }}>
            <ChevronRight size={14} />
          </div>
        </div>

        <div className="card hoverable" role="link" tabIndex={0} onClick={() => navigate("/finances")}
          onKeyDown={(e) => { if (e.key === "Enter") navigate("/finances"); }}>
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><Wallet size={12} /> {t("dashboard.cash")}</div>
            <div className="value" style={{ color: (club.cash ?? 0) >= 0 ? "var(--grass-2)" : "var(--red-2)" }}>{money(club.cash ?? 0)}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", color: "var(--text-3)", marginTop: 8 }}>
            <ChevronRight size={14} />
          </div>
        </div>

        <div className="card hoverable" role="link" tabIndex={0} onClick={() => navigate("/competitions")}
          onKeyDown={(e) => { if (e.key === "Enter") navigate("/competitions"); }}>
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><CalendarDays size={12} /> {t("dashboard.nextFixture")}</div>
            <div className="value" style={{ fontSize: "1.15rem" }}>
              {snapshot.nextFixture ? (
                <>
                  <ClubNameLink clubId={snapshot.nextFixture.homeClubId} name={snapshot.nextFixture.home} showCrest={false} />
                  {" vs "}
                  <ClubNameLink clubId={snapshot.nextFixture.awayClubId} name={snapshot.nextFixture.away} showCrest={false} />
                </>
              ) : (
                t("dashboard.noNextFixture")
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {snapshot.nextFixture && <Clock size={12} />} {snapshot.nextFixture && t("common.day", { n: snapshot.nextFixture.dayIndex })}
              {nextKickoff && <span style={{ color: "var(--gold-2)", fontWeight: 600 }}>· {nextKickoff}</span>}
            </span>
            {snapshot.nextFixture && <ChevronRight size={14} />}
          </div>
        </div>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <h2 className="card-title" style={{ marginBottom: 0 }}><Newspaper size={17} /> {t("dashboard.news")}</h2>
<span style={{ color: "var(--text-3)", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              {snapshot.news.length > 0 ? t("dashboard.lastN", { count: Math.min(12, snapshot.news.length) }) : ""}
            </span>
          </div>
          {snapshot.news.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 10px" }}>{t("dashboard.noNews")}</div>
          ) : (
            <div className="news-feed">
              {snapshot.news.slice(0, 12).map((n, i) => (
                <div className="news-feed-item" key={n.id ?? `i-${i}`}>
                  <span className="kind-dot" style={{ background: NEWS_KIND_COLORS[n.kind] ?? "var(--text-3)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
{n.kind === "motd" && <span className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)", marginRight: 6, fontSize: "0.68rem", padding: "1px 6px" }}>{t("dashboard.admin")}</span>}
                    {news.headline(n.headline) && <div style={{ fontWeight: 800 }}>{news.headline(n.headline)}</div>}
                    {news.body(n)}
                  </div>
                  <span className="day">{t("common.day", { n: n.dayIndex })}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h2 className="card-title"><Users size={17} /> {t("squad.title")}</h2>
            <div className="stats-row">
              <div className="stat">
                <div className="label">{t("dashboard.seniors")}</div>
                <div className="value" style={{ fontSize: "1.5rem" }}>{snapshot.squad.length}</div>
              </div>
              <div className="stat">
                <div className="label">{t("dashboard.youth")}</div>
                <div className="value" style={{ fontSize: "1.5rem" }}>{snapshot.juniors.length}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => navigate("/squad")}>
                <Users size={14} /> {t("squad.title")} <ArrowRight size={13} />
              </button>
              <button className="btn sm ghost" onClick={() => navigate("/competitions")}>
                <ChartNoAxesColumn size={14} /> {t("competitions.title")} <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title"><Trophy size={17} /> {t("dashboard.trophyCabinet", { name: club.shortName })}</h2>
            {Object.keys(club.trophies).length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>
                {t("dashboard.trophyEmpty")}
              </div>
            ) : (
              <div className="news-list">
                {Object.entries(club.trophies).map(([name, count]) => (
                  <div className="news-item" key={name}>
                    <span className="day" style={{ color: "var(--gold-2)" }}>🏆 {count}×</span>
                    {name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
