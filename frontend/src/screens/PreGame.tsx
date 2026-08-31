import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlarmClock, ArrowRight, ClipboardList, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { TacticsBoard } from "../components/TacticsBoard";
import { ClubNameLink } from "../components/ClubNameLink";
import { directionOptions, pressingOptions, styleOptions } from "../tacticsOptions";
import { formatKickoff } from "../utils/time";
import { useIsMobile } from "../hooks/useIsMobile";

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function PreGame() {
  const { t } = useTranslation();
  const { snapshot, liveMatchId, refresh, setLiveMatch, status } = useGame();
  const pregameWindowMinutes = useSettings((s) => s.pregameWindowMinutes);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // Ticking clock drives both the countdown and the window visibility.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const club = snapshot?.club;
  const fixture = snapshot?.nextFixture ?? null;
  const kickoffAt = fixture?.kickoffAt ?? null;
  const windowMs = pregameWindowMinutes * 60_000;
  const msToKickoff = kickoffAt !== null ? kickoffAt - now : null;
  // The season pause freezes every kickoff: hold the prep window closed and
  // keep the countdown from visually expiring while the world is frozen.
  const paused = status?.paused ?? false;
  // The window includes the post-kickoff side (msToKickoff <= 0): the screen
  // then switches to "waiting for kick-off" until the live match appears.
  const windowOpen = !paused && msToKickoff !== null && msToKickoff <= windowMs;
  const awaitingKickoff = windowOpen && msToKickoff <= 0;

  // The WebSocket watcher pushes liveMatchStarted; flip into the live match.
  useEffect(() => {
    if (liveMatchId) navigate("/live-match");
  }, [liveMatchId, navigate]);

  // Fallback when the socket is unavailable: check for the live match right
  // away, then poll briefly. A deep link long after kickoff (round already
  // resolved without a live match) leaves promptly instead of polling forever.
  useEffect(() => {
    if (!awaitingKickoff) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const leaveToCompetitions = () => {
      if (timer !== undefined) window.clearInterval(timer);
      void refresh();
      navigate("/competitions");
    };
    const check = () => {
      attempts++;
      void api
        .liveMatchInfo()
        .then((res) => {
          if (cancelled) return;
          if (res.match) {
            setLiveMatch(res.match.id);
            navigate("/live-match");
            return;
          }
          if (attempts >= 36 || Date.now() - (kickoffAt ?? 0) > 5 * 60_000) leaveToCompetitions();
        })
        .catch(() => undefined);
    };
    check();
    timer = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [awaitingKickoff, kickoffAt, navigate, refresh, setLiveMatch]);

  const [tactics, setTactics] = useState(() =>
    snapshot?.club?.tactics
      ? { style: snapshot.club.tactics.style, pressing: snapshot.club.tactics.pressing, direction: snapshot.club.tactics.direction }
      : { style: 0, pressing: 0, direction: 0 },
  );
  const [tacticsBusy, setTacticsBusy] = useState(false);
  const [tacticsStatus, setTacticsStatus] = useState("");

  const saveTactics = async () => {
    setTacticsBusy(true);
    setTacticsStatus("");
    try {
      await api.setTactics({ style: tactics.style, pressing: tactics.pressing, direction: tactics.direction });
      setTacticsStatus("saved");
    } catch (e) {
      setTacticsStatus((e as Error).message);
    } finally {
      setTacticsBusy(false);
    }
  };

  if (!snapshot || !club) {
    return <div className="empty-state" style={{ paddingTop: 80 }}>{t("pregame.loading")}</div>;
  }

  // Outside the window (or no scheduled kickoff): explain when prep opens.
  if (!fixture || kickoffAt === null || !windowOpen) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{t("pregame.title")}</div>
            <h1>{t("pregame.title")}</h1>
          </div>
        </div>
        <div className="card" style={{ padding: "28px 22px" }}>
          <div className="empty-state" style={{ padding: "12px 8px" }}>
            {paused && fixture && kickoffAt !== null
              ? t("pregame.pausedFrozen")
              : pregameWindowMinutes <= 0
                ? t("pregame.disabled")
                : !fixture || kickoffAt === null
                  ? t("pregame.noFixture")
                  : t("pregame.opensIn", { count: pregameWindowMinutes })}
          </div>
          {fixture && kickoffAt !== null && (
            <div style={{ textAlign: "center", color: "var(--text-3)", fontSize: "0.9rem" }}>
              {t("pregame.nextMatch", { home: fixture.home, away: fixture.away })} · {formatKickoff(kickoffAt)}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 16 }}>
            <button className="btn" onClick={() => navigate("/squad")}><ClipboardList size={15} /> {t("pregame.squadTactics")}</button>
            <button className="btn ghost" onClick={() => navigate("/dashboard")}>{t("pregame.dashboard")} <ArrowRight size={14} /></button>
          </div>
        </div>
      </div>
    );
  }

  const badge = (
    <span className="pregame-tag">
      <ClipboardList size={11} /> {t("pregame.title")}
    </span>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
            {t("pregame.title")} · {t("common.day", { n: fixture.dayIndex })}
            {fixture.isHome ? ` ${t("pregame.home")}` : ` ${t("pregame.away")}`}
          </div>
          <h1>
            <ClubNameLink clubId={fixture.homeClubId} name={fixture.home} showCrest={false} />
            {" vs "}
            <ClubNameLink clubId={fixture.awayClubId} name={fixture.away} showCrest={false} />
          </h1>
        </div>
      </div>

      <div className="card" style={{ borderColor: "rgba(240,180,41,0.5)", marginBottom: 16, padding: "22px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <h2 className="card-title" style={{ marginBottom: 4 }}>{badge}</h2>
            <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>
              {t("pregame.readyHint", { kickoff: formatKickoff(kickoffAt) })}
            </div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--gold-2)", fontWeight: 700, whiteSpace: "nowrap" }}>
            <AlarmClock size={16} />
            {awaitingKickoff ? t("pregame.waitingKickoff") : t("pregame.kickoffIn", { time: formatCountdown(msToKickoff ?? 0) })}
          </span>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)", alignItems: "start", gap: 16 }}>
        <div className="card">
          <TacticsBoard mode="club" />
        </div>
        <div className="card">
          <h2 className="card-title"><ShieldCheck size={17} /> {t("pregame.matchStrategy")}</h2>
          <div className="form-group">
            <label htmlFor="pregame-style">{t("squad.style")}</label>
            <select id="pregame-style" className="select" value={tactics.style} disabled={tacticsBusy} onChange={(e) => setTactics({ ...tactics, style: Number(e.target.value) })}>
              {styleOptions().map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5, lineHeight: 1.5 }}>{styleOptions()[tactics.style]?.desc}</div>
          </div>
          <div className="form-group">
            <label htmlFor="pregame-press">{t("squad.pressing")}</label>
            <select id="pregame-press" className="select" value={tactics.pressing} disabled={tacticsBusy} onChange={(e) => setTactics({ ...tactics, pressing: Number(e.target.value) })}>
              {pressingOptions().map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5, lineHeight: 1.5 }}>{pressingOptions()[tactics.pressing]?.desc}</div>
          </div>
          <div className="form-group">
            <label htmlFor="pregame-dir">{t("squad.direction")}</label>
            <select id="pregame-dir" className="select" value={tactics.direction} disabled={tacticsBusy} onChange={(e) => setTactics({ ...tactics, direction: Number(e.target.value) })}>
              {directionOptions().map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5, lineHeight: 1.5 }}>{directionOptions()[tactics.direction]?.desc}</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={() => void saveTactics()} disabled={tacticsBusy} style={{ flex: 1 }}>
              {t("common.save")}
            </button>
            {tacticsStatus === "saved" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--grass-2)", fontWeight: 700, fontSize: "0.9rem", whiteSpace: "nowrap" }}>
                <ShieldCheck size={15} /> {t("pregame.saved")}
              </span>
            )}
            {tacticsStatus !== "" && tacticsStatus !== "saved" && (
              <span style={{ color: "var(--red-2)", fontSize: "0.85rem" }}>{tacticsStatus}</span>
            )}
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 10, lineHeight: 1.5 }}>
            {t("pregame.strategyNote")}
          </div>
        </div>
      </div>
    </div>
  );
}
