import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FastForward, Flag, Play, RefreshCw, Subscript } from "lucide-react";
import { api, type LiveEvent, type LivePlayer, type LiveState } from "../api/client";
import { useGame } from "../store/game";
import { LineupPicker } from "../components/LineupPicker";

const EVENT_LABELS: Record<number, string> = {
  1: "Goal!",
  2: "Yellow card",
  3: "Red card",
  5: "Injury",
  6: "Substitution",
  7: "Missed penalty",
  8: "Assist",
};

const PHASE_LABEL: Record<string, string> = {
  pregame: "Lineups",
  first: "1st half",
  halftime: "Half-time",
  second: "2nd half",
  et1: "Extra time · 1st period",
  et2: "Extra time · 2nd period",
  shootout: "Penalty shootout",
  fulltime: "Full time",
};

function EventIcon({ type, subtype }: { type: number; subtype: number }) {
  let cls = "event-ico event-miss";
  let glyph = "⚽";
  if (type === 1) { cls = "event-ico event-goal"; glyph = subtype === 2 ? "🥅" : "⚽"; }
  else if (type === 2) { cls = "event-ico event-yellow"; glyph = "🟨"; }
  else if (type === 3) { cls = "event-ico event-red"; glyph = "🟥"; }
  else if (type === 5) { cls = "event-ico event-inj"; glyph = "🩹"; }
  else if (type === 6) { cls = "event-ico event-sub"; glyph = "🔄"; }
  else if (type === 7) { cls = "event-ico event-miss"; glyph = "❌"; }
  return <span className={cls}>{glyph}</span>;
}

interface WsMessage {
  type: string;
  events?: LiveEvent[];
  event?: LiveEvent | null;
  state?: LiveState;
  dayResult?: unknown;
  message?: string;
  error?: string;
}

export function LiveMatch() {
  const { saveId, dayResult, refresh, setDayResult } = useGame();
  const navigate = useNavigate();
  const [state, setState] = useState<LiveState | null>(null);
  const [wsMode, setWsMode] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [fast, setFast] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [subOut, setSubOut] = useState<LivePlayer | null>(null);
  const [subIn, setSubIn] = useState<LivePlayer | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [tickBusy, setTickBusy] = useState(false);
  const [noLive, setNoLive] = useState(false);
  const [liveId, setLiveId] = useState<number | null>(dayResult?.humanMatch?.id ?? null);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<LiveState | null>(null);
  const fastRef = useRef(false);
  fastRef.current = fast;

  const matchId = liveId;

  useEffect(() => {
    if (noLive) navigate("/matchday");
  }, [noLive, navigate]);

  useEffect(() => {
    if (!saveId) return;
    if (dayResult?.humanMatch?.id) {
      setLiveId(dayResult.humanMatch.id);
      return;
    }
    api
      .liveMatchInfo(saveId)
      .then((res) => {
        if (res.match) setLiveId(res.match.id);
        else setNoLive(true);
      })
      .catch(() => setNoLive(true));
  }, [saveId, dayResult]);

  const applyState = useCallback((s: LiveState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const send = useCallback(
    (msg: unknown) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    []
  );

  const tick = useCallback(async () => {
    if (!saveId || !matchId) return;
    if (tickBusy) return;
    const minutes = fastRef.current ? 3 : 1;
    const atHalfTime = stateRef.current?.phase === "halftime";
    if (send({ type: "tick", minutes, resume: atHalfTime })) return;
    setTickBusy(true);
    try {
      const res = await api.liveTick(saveId, matchId, minutes, atHalfTime);
      applyState(res.state);
    } catch {
      /* keep retrying */
    } finally {
      setTickBusy(false);
    }
  }, [saveId, matchId, send, applyState, tickBusy]);

  const connectWs = useCallback(() => {
    if (!saveId || !matchId) return;
    setReconnecting(true);
    const ws = new WebSocket(api.liveWsUrl(saveId, matchId));
    wsRef.current = ws;
    ws.onopen = () => {
      setReconnecting(false);
      setWsMode(true);
      ws.send(JSON.stringify({ type: "state" }));
    };
    ws.onmessage = (ev) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === "state" && msg.state) {
        setWsMode(true);
        setReconnecting(false);
        applyState(msg.state);
      } else if (msg.type === "tick" && msg.state) {
        applyState(msg.state);
      } else if (msg.type === "sub" && msg.state) {
        applyState(msg.state);
        setSubBusy(false);
        if (msg.error) {
          setSubOut(null);
          setSubIn(null);
        } else {
          setShowSubs(false);
          setSubOut(null);
          setSubIn(null);
        }
      } else if (msg.type === "finished" && msg.dayResult) {
        handleFinished(msg.dayResult);
      } else if (msg.type === "error") {
        setReconnecting(false);
        setWsMode(false);
        if (String(msg.message ?? "").includes("No live match")) setNoLive(true);
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      setWsMode(false);
      setReconnecting(false);
    };
    ws.onerror = () => {
      ws.close();
    };
  }, [saveId, matchId, applyState]);

  const handleFinished = useCallback(
    (result?: unknown) => {
      if (result) setDayResult(result as Parameters<typeof setDayResult>[0]);
      void (async () => {
        await refresh();
        navigate("/dashboard");
      })();
    },
    [refresh, navigate, setDayResult]
  );

  const finish = useCallback(async () => {
    if (!saveId || !matchId) return;
    if (send({ type: "finish" })) return;
    try {
      const res = await api.liveFinish(saveId, matchId);
      setDayResult(res.dayResult);
      if (res.dayResult.seasonEnded) navigate("/season-end");
      else await handleFinished();
    } catch (e) {
      console.error(e);
    }
  }, [saveId, matchId, send, navigate, handleFinished, setDayResult]);

  useEffect(() => {
    if (!saveId || !matchId) return;
    connectWs();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [saveId, matchId, connectWs]);

  useEffect(() => {
    if (!saveId || !matchId) return;
    if (!stateRef.current) {
      api
        .liveState(saveId, matchId)
        .then((res) => applyState(res.state))
        .catch((e) => {
          if ((e as Error).message.includes("No live match")) setNoLive(true);
        });
    }
    const iv = setInterval(() => {
      const st = stateRef.current;
      if (!st) return;
      if (st.phase === "halftime" || st.phase === "pregame") return;
      if (st.ended) return;
      if (!wsMode && !wsRef.current && !reconnecting) {
        void tick();
        return;
      }
      if (wsMode) {
        void tick();
      }
    }, wsMode ? 800 : 1200);
    return () => clearInterval(iv);
  }, [saveId, matchId, applyState, tick, wsMode, reconnecting]);

  useEffect(() => {
    if (!wsMode && !reconnecting && stateRef.current && !stateRef.current.ended) {
      const t = setTimeout(connectWs, 3000);
      return () => clearTimeout(t);
    }
  }, [wsMode, reconnecting, connectWs]);

  const doSub = async () => {
    if (!saveId || !matchId || !subOut || !subIn || subBusy) return;
    setSubBusy(true);
    try {
      if (send({ type: "sub", outId: subOut.id, inId: subIn.id })) return;
      const res = await api.liveSub(saveId, matchId, subOut.id, subIn.id);
      applyState(res.state);
      setShowSubs(false);
      setSubOut(null);
      setSubIn(null);
    } catch (e) {
      console.error(e);
    } finally {
      setSubBusy(false);
    }
  };

  const humanSide = state?.humanSide ?? 1;
  const onPitch = humanSide === 0 ? state?.homeOn ?? [] : state?.awayOn ?? [];
  const bench = humanSide === 0 ? state?.homeBench ?? [] : state?.awayBench ?? [];
  const usedSubs = state ? state.usedSubs[humanSide] : 0;
  const subsLeft = 5 - usedSubs;

  const visibleEvents = useMemo(() => {
    if (!state) return [];
    return state.events
      .slice()
      .sort((a, b) => a.minute - b.minute || a.type - b.type)
      .filter((e) => e.type !== 8);
  }, [state?.events]);

  if (!state) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">Matchday</div>
            <h1>Kickoff</h1>
          </div>
        </div>
        <div className="empty-state" style={{ paddingTop: 70 }}>
          {reconnecting ? "Connecting to the stadium..." : "Loading..."}
        </div>
      </div>
    );
  }

  const stats = state.stats;
  const isDone = state.ended;
  const scoreKey = `${state.homeScore}-${state.awayScore}`;

  const barRow = (label: string, h: number, a: number) => {
    const total = h + a || 1;
    const hp = (h / total) * 100;
    return (
      <div className="stat-bar">
        <span className="side-num">{h}</span>
        <div className="track">
          <div className="fill-h" style={{ width: `${hp}%` }} />
          <div className="fill-a" style={{ width: `${100 - hp}%` }} />
        </div>
        <span className="side-num right">{a}</span>
        <span className="bar-label">{label}</span>
      </div>
    );
  };

  const phaseLabel = PHASE_LABEL[state.phase] ?? state.phase;

  if (state.phase === "pregame") {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{state.competitionName || "Matchday"}</div>
            <h1>{state.home} vs {state.away}</h1>
          </div>
        </div>
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.4)", marginBottom: 16, padding: "22px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <h2 className="card-title" style={{ marginBottom: 4 }}>
                <span className="live-tag" style={{ fontSize: "0.7rem", padding: "3px 10px" }}>
                  {wsMode && !reconnecting ? <><span className="pulse-dot" /> Live</> : <><RefreshCw size={11} /> {reconnecting ? "Reconnecting" : "Fallback"}</>}
                </span>{" "}
                Match lineup
              </h2>
              <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>
                Set your starting eleven and bench before kickoff. Changes are saved instantly.
              </div>
            </div>
            <button className="btn gold" style={{ fontSize: "1.05rem", padding: "12px 28px" }} onClick={() => void tick()}>
              <Play size={17} /> Kick off
            </button>
          </div>
          <LineupPicker mode="match" matchId={state.matchId} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{state.competitionName || "Matchday"}</div>
          <h1>{state.home} vs {state.away}</h1>
        </div>
      </div>

      <div className="scoreboard" style={{ marginBottom: 16 }}>
        <div className="floodlights" />
        {isDone ? (
          <span className="live-minute">{state.shootout ? "Penalties decided it" : PHASE_LABEL.fulltime}</span>
        ) : (
          <span className="live-tag">
            <span className="pulse-dot" /> {phaseLabel}
            {state.phase !== "halftime" && ` · ${state.minute}'`}
          </span>
        )}

        <div className="live-score" key={scoreKey}>
          <span className="score-num">{state.homeScore}</span>
          <span className="sep">—</span>
          <span className="score-num">{state.awayScore}</span>
        </div>
        {state.shootout && (
          <div style={{ color: "var(--gold-2)", fontWeight: 700, marginBottom: 6 }}>
            Pens {state.shootout.scores[0]} - {state.shootout.scores[1]} · {state.shootout.winner} win
          </div>
        )}
        <div className="live-teams">
          <span>{state.home} <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>{state.homeFormation}</span></span>
          <span style={{ color: "var(--text-3)" }}>vs</span>
          <span>{state.away} <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>{state.awayFormation}</span></span>
        </div>

        <div className="stat-bars">
          {barRow("Possession", stats.possession[0], stats.possession[1])}
          {barRow("Shots", stats.shots[0], stats.shots[1])}
          {barRow("On target", stats.onGoal[0], stats.onGoal[1])}
        </div>
      </div>

      {state.phase === "halftime" && (
        <div className="card" style={{ borderColor: "rgba(240,180,41,0.4)", marginBottom: 16, textAlign: "center", padding: "18px 14px" }}>
          <h2 style={{ fontSize: "1.3rem", marginBottom: 6 }}>Interval</h2>
          <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 12 }}>
            You may make substitutions ({subsLeft} left).
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="btn" onClick={() => setShowSubs(true)} disabled={subsLeft <= 0}>
              <Subscript size={15} /> Substitutions
            </button>
            <button className="btn gold" onClick={() => void tick()}>Resume</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="card-title">
          <span className="live-tag" style={{ fontSize: "0.72rem", padding: "3px 10px" }}>
            {wsMode && !reconnecting ? <><span className="pulse-dot" /> Live</> : <><RefreshCw size={11} /> {reconnecting ? "Reconnecting" : "Fallback"}</>}
          </span>{" "}
          Events
        </h2>
        <div className="event-feed">
          {visibleEvents.length === 0 && (
            <div className="empty-state" style={{ padding: 14 }}>
              {isDone ? "No goals, cards or injuries to report." : "The match is about to start..."}
            </div>
          )}
          {visibleEvents.map((e, i) => (
            <div className="event-row" key={i}>
              <span className="min">{e.minute}'</span>
              <EventIcon type={e.type} subtype={e.subtype} />
              {e.type === 1 && e.subtype !== 2 && e.player2 ? (
                <>
                  <span className="ev-label">{EVENT_LABELS[e.type]}</span>
                  <span className="ev-name">{e.player}</span>
                  <span className="ev-label">assist {e.player2}</span>
                </>
              ) : e.type === 6 ? (
                <>
                  <span className="ev-label">{EVENT_LABELS[e.type]}</span>
                  <span className="ev-name">{e.player}</span>
                  <span className="ev-label">↔ {e.player2}</span>
                </>
              ) : (
                <>
                  <span className="ev-label">{EVENT_LABELS[e.type] ?? "Event"}</span>
                  <span className="ev-name">{e.player}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Match stats</h2>
        {barRow("Fouls", stats.fouls[0], stats.fouls[1])}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <span className="chip">🟨 {stats.yellows[0]} : {stats.yellows[1]}</span>
          <span className="chip">🟥 {stats.reds[0]} : {stats.reds[1]}</span>
          <span className="chip">Subs {state.usedSubs[0]} : {state.usedSubs[1]}</span>
        </div>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        {isDone ? (
          <button className="btn gold" onClick={() => void finish()}>
            <Flag size={15} /> Finish match
          </button>
        ) : (
          state.phase !== "halftime" && (
            <>
              <button className="btn ghost" onClick={() => setFast((f) => !f)}>
                <FastForward size={15} /> {fast ? "Normal" : "Fast"}
              </button>
              <button className="btn ghost" onClick={() => setShowSubs(true)} disabled={subsLeft <= 0}>
                <Subscript size={15} /> Subs ({subsLeft})
              </button>
            </>
          )
        )}
      </div>

      {showSubs && (
        <div className="modal-overlay" onClick={() => setShowSubs(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 4 }}>Substitutions</h3>
            <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 12 }}>
              {subsLeft} substitution{subsLeft === 1 ? "" : "s"} remaining · pick who comes off and who comes on
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div className="card-title" style={{ marginBottom: 6 }}>On the pitch</div>
                <div className="sub-list">
                  {onPitch.map((p) => (
                    <button
                      key={p.id}
                      className={`sub-row${subOut?.id === p.id ? " sel" : ""}`}
                      onClick={() => setSubOut(p)}
                    >
                      <span className="pos-tag">{p.tacPos}</span>
                      <span style={{ flex: 1, textAlign: "left" }}>{p.name}</span>
                      <span style={{ color: "var(--text-3)" }}>{Math.round(p.energy)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="card-title" style={{ marginBottom: 6 }}>Bench</div>
                <div className="sub-list">
                  {bench.map((p) => (
                    <button
                      key={p.id}
                      className={`sub-row${subIn?.id === p.id ? " sel" : ""}`}
                      onClick={() => setSubIn(p)}
                      disabled={p.injuryDays > 0 || p.suspended}
                    >
                      <span className="pos-tag">{p.position === 0 ? "GK" : ""}</span>
                      <span style={{ flex: 1, textAlign: "left" }}>{p.name}</span>
                      <span style={{ color: "var(--text-3)" }}>{p.overall}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowSubs(false)}>Close</button>
              <button className="btn" style={{ flex: 1 }} onClick={() => void doSub()} disabled={!subOut || !subIn || subBusy}>
                Confirm sub
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
