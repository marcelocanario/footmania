import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Flag, RefreshCw, Subscript, Users, Volume2, VolumeX } from "lucide-react";
import { api, type LiveEvent, type LivePlayer, type LiveState, type LiveStateDelta } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { useIsMobile } from "../hooks/useIsMobile";
import { TacticsBoard } from "../components/TacticsBoard";
import { MatchPitch } from "../components/MatchPitch";
import { eventKey, hasPitchCue } from "../components/matchPitchUtils";
import { enqueueKickoffWhistle, enqueueMatchEventSounds, preloadMatchSounds, setSoundsMuted, stopMatchSounds } from "../components/matchSounds";
import { ClubNameLink } from "../components/ClubNameLink";
import { MatchHistory } from "../components/MatchHistory";
import { PlayerScoresTable } from "../components/PlayerScoresTable";
import { MatchStatsPanel } from "../components/MatchStatsPanel";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";
import { FamiliarityBar } from "../components/FamiliarityBar";
import { NaturalPosition, POSITION_ORDER, positionClass, positionLabel } from "../positions";
import { directionOptions, pressingOptions, styleOptions } from "../tacticsOptions";
import { automationReasonKey } from "../automation";

/** Natural (squad) position label: what position the player actually plays
 *  (their base position), used for the bench list in the substitution panel. */
function naturalPosition(player: LivePlayer): string {
  return player.naturalPosition ?? "PLAYER";
}

/** i18next's t() is typed against the literal key union derived from en.ts;
 *  a runtime-computed key (automationReasonKey's result) needs this escape
 *  hatch, matching MatchHistory.tsx's eventLabel/tDynamic pattern. */
function tDynamic(key: string): string {
  return (i18n.t as unknown as (k: string) => string)(key);
}

function matchContextLabel(state: LiveState, t: (k: string, o?: object) => string): string {
  const parts: string[] = [];
  if (state.seasonNumber !== null) parts.push(t("live.season", { season: state.seasonNumber }));
  if (state.divisionTier !== null) {
    parts.push(t("live.division", { tier: state.divisionTier }));
    if (state.groupNumber !== null) parts.push(t("live.group", { group: state.groupNumber }));
  } else if (state.competitionName) {
    parts.push(state.competitionName);
  }
  if (state.roundNumber !== null) parts.push(t("live.round", { round: state.roundNumber }));
  if (state.stadiumName) parts.push(state.stadiumName);
  return parts.join(" · ") || t("live.matchday");
}

interface WsMessage {
  type: string;
  events?: LiveEvent[];
  event?: LiveEvent | null;
  state?: LiveState;
  delta?: LiveStateDelta;
  dayResult?: unknown;
  message?: string;
  error?: string;
}

export function LiveMatch() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const refresh = useGame((s) => s.refresh);
  const setLiveMatch = useGame((s) => s.setLiveMatch);
  const snapshot = useGame((s) => s.snapshot);
  const pregameWindowMinutes = useSettings((s) => s.pregameWindowMinutes);
  const soundMuted = useSettings((s) => s.soundMuted);
  const toggleSoundMuted = useSettings((s) => s.toggleSoundMuted);
  const navigate = useNavigate();
  // Spectator entry: /live-match/:matchId watches any match, not just our own.
  const routeMatchId = Number(useParams().matchId ?? "");
  const [state, setState] = useState<LiveState | null>(null);
  const [wsMode, setWsMode] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [showLineup, setShowLineup] = useState(false);
  const [subOut, setSubOut] = useState<LivePlayer | null>(null);
  const [subIn, setSubIn] = useState<LivePlayer | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [noLive, setNoLive] = useState(false);
  const [liveId, setLiveId] = useState<number | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [halftimeBusy, setHalftimeBusy] = useState(false);
  const [sideTab, setSideTab] = useState<"events" | "scores" | "stats" | "tactics">("events");
  const [tacticDraft, setTacticDraft] = useState({ style: 0, pressing: 0, direction: 0 });
  const [tacticsBusy, setTacticsBusy] = useState(false);
  const [tacticsStatus, setTacticsStatus] = useState("");
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<LiveState | null>(null);
  // Goal/card/save/… rows in the sidebar must appear in step with the pitch
  // actually animating them, not the instant they arrive over the wire —
  // otherwise the sidebar can report a goal seconds before (or, if the pitch
  // ever drops a stale cue, without) the pitch showing anything for it.
  // MatchPitch calls this exactly when it starts (or gives up on) each cue.
  const revealedKeysRef = useRef<Set<string>>(new Set());
  // Sounds follow the same "only live moments" rule as pitch cues: the first
  // snapshot for a match adopts its history silently (reconnects and spectator
  // switches must not replay old goals), and arrivals older than the freshness
  // window are skipped inside the sound module.
  const lastSoundedSeqRef = useRef<number>(-1);
  // Previous live phase, for edge-triggered transitions (kick-off whistle).
  const prevPhaseRef = useRef<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const markRevealed = useCallback((event: LiveEvent) => {
    const key = eventKey(event);
    if (!revealedKeysRef.current.has(key)) {
      revealedKeysRef.current.add(key);
      setRevealTick((tick) => tick + 1);
    }
  }, []);
  const historyEvents = useMemo(() => {
    if (!state) return [];
    // Once the match is over there's no ongoing pitch animation left to sync
    // with, and nothing should be able to stay hidden past full time.
    if (state.ended) return state.events;
    return state.events.filter((event) => !hasPitchCue(event.type) || revealedKeysRef.current.has(eventKey(event)));
  }, [state?.events, state?.ended, revealTick]);

  // Stable PitchTeam objects for MatchPitch (React.memo'd): rebuilding these
  // literals on every render would defeat memoization even when nothing the
  // pitch cares about changed.
  const home = useMemo(() => {
    if (!state) return null;
    return { clubId: state.homeClubId, name: state.home, kit: state.homeKit, gkKit: state.homeGkKit, players: state.homeOn, formationId: state.homeFormationId, formationName: state.homeFormation, formationSlots: (state as unknown as { homeFormationSlots?: Array<{ x: number; y: number }> }).homeFormationSlots };
  }, [state?.homeClubId, state?.home, state?.homeKit, state?.homeGkKit, state?.homeOn, state?.homeFormationId, (state as unknown as { homeFormationSlots?: unknown })?.homeFormationSlots]);
  const away = useMemo(() => {
    if (!state) return null;
    return { clubId: state.awayClubId, name: state.away, kit: state.awayKit, gkKit: state.awayGkKit, players: state.awayOn, formationId: state.awayFormationId, formationName: state.awayFormation, formationSlots: (state as unknown as { awayFormationSlots?: Array<{ x: number; y: number }> }).awayFormationSlots };
  }, [state?.awayClubId, state?.away, state?.awayKit, state?.awayGkKit, state?.awayOn, state?.awayFormationId, (state as unknown as { awayFormationSlots?: unknown })?.awayFormationSlots]);

  const liveTactics = state ? (state.humanSide === 0 ? state.homeTactics : state.awayTactics) : null;
  // Live-match tactics lock (server-enforced): match-minutes left until this
  // side may change style/pressing/direction again.
  const tacticsCooldownMinutes = state
    ? state.humanSide === 0
      ? state.homeTacticsCooldownMinutes ?? 0
      : state.awayTacticsCooldownMinutes ?? 0
    : 0;
  // plans/6 §17: show the side's in-match familiarity and, while the draft
  // differs from the applied setup, the projected post-switch value (the
  // switch penalty is server-computed; applying it lowers this bar).
  const draftMatchesLive =
    !!liveTactics &&
    tacticDraft.style === liveTactics.style &&
    tacticDraft.pressing === liveTactics.pressing &&
    tacticDraft.direction === liveTactics.direction;
  const draftProjection = liveTactics?.projections?.find(
    (p) => p.style === tacticDraft.style && p.pressing === tacticDraft.pressing && p.direction === tacticDraft.direction
  )?.familiarity ?? null;

  useEffect(() => {
    if (liveTactics) setTacticDraft(liveTactics);
  }, [liveTactics?.style, liveTactics?.pressing, liveTactics?.direction]);

  const matchId = liveId;

  // A spectator can switch which match they're watching without this
  // component remounting — the reveal set must not carry over.
  useEffect(() => {
    revealedKeysRef.current = new Set();
    lastSoundedSeqRef.current = -1;
    prevPhaseRef.current = null;
    setRevealTick(0);
  }, [matchId]);

  // Preload clips once; keep the module's mute flag in sync with the stored
  // preference (muting mid-playback also drops the pending queue).
  useEffect(() => {
    preloadMatchSounds();
  }, []);

  useEffect(() => {
    setSoundsMuted(soundMuted);
  }, [soundMuted]);

  useEffect(() => () => stopMatchSounds(), []);

  useEffect(() => {
    if (noLive) {
      // Clear a stale "live" flag first: otherwise PreGame would bounce users
      // straight back here (its liveMatchId effect) and the two screens would
      // ping-pong, and the Dashboard prep banner would stay hidden.
      setLiveMatch(null);
      // Idle link but the pre-game prep window is open for the next fixture:
      // route to prep instead of bouncing out to the competitions screen.
      const kickoffAt = snapshot?.nextFixture?.kickoffAt ?? null;
      const msToKickoff = kickoffAt !== null ? kickoffAt - Date.now() : null;
      if (msToKickoff !== null && msToKickoff > 0 && msToKickoff <= pregameWindowMinutes * 60_000) {
        navigate("/pregame");
        return;
      }
      void refresh();
      navigate("/competitions");
    }
  }, [noLive, navigate, refresh, setLiveMatch, snapshot, pregameWindowMinutes]);

  useEffect(() => {
    // Direct link to a specific match (spectating): skip the own-match lookup.
    if (Number.isFinite(routeMatchId) && routeMatchId > 0) {
      setLiveId(routeMatchId);
      return;
    }
    api
      .liveMatchInfo()
      .then((res) => {
        if (res.match) setLiveId(res.match.id);
        else setNoLive(true);
      })
      .catch(() => setNoLive(true));
  }, [routeMatchId]);

  const applyState = useCallback((s: LiveState) => {
    stateRef.current = s;
    setState(s);
    // Kick-off whistle: fires on the live transition into the first half
    // (after the coin toss, which ships inside the match state itself). The
    // first snapshot only anchors prevPhaseRef — a viewer joining mid-match
    // must not hear it — and reconnects never replay it because this
    // component survives socket drops with the previous phase intact.
    if (prevPhaseRef.current !== null && prevPhaseRef.current !== s.phase && s.phase === "first") {
      enqueueKickoffWhistle();
    }
    prevPhaseRef.current = s.phase;
    // Single sound entry point: every path that replaces the whole state (WS
    // snapshot, delta merge, polling fallback, sub/tactics responses) funnels
    // through here, so newly arrived events are detected uniformly. The very
    // first snapshot for this match only initializes the watermark — history
    // must not replay.
    const seqs = s.events.map((e) => e.sequence).filter((n): n is number => typeof n === "number");
    if (seqs.length === 0) return;
    const maxSeq = Math.max(...seqs);
    if (lastSoundedSeqRef.current < 0 || maxSeq <= lastSoundedSeqRef.current) {
      lastSoundedSeqRef.current = Math.max(lastSoundedSeqRef.current, maxSeq);
      return;
    }
    const fresh = s.events.filter((e) => e.sequence !== undefined && e.sequence > lastSoundedSeqRef.current);
    lastSoundedSeqRef.current = maxSeq;
    enqueueMatchEventSounds({ events: fresh, homeClubId: s.homeClubId, displayMinute: s.minute, phase: s.phase });
  }, []);

  const applyDelta = useCallback((delta: LiveStateDelta) => {
    const current = stateRef.current;
    if (!current || current.matchId !== delta.matchId) return;
    // Only allocate a new events array when there is actually something new
    // to append — a delta with no unseen events should let the component
    // reuse the existing array reference (avoids downstream re-renders/memo
    // invalidations keyed on `events` identity).
    let events = current.events;
    if (delta.newEvents.length > 0) {
      const known = new Set(current.events.map((event) => event.sequence));
      const unseen = delta.newEvents.filter((event) => event.sequence === undefined || !known.has(event.sequence));
      if (unseen.length > 0) events = [...current.events, ...unseen];
    }
    applyState({
      ...current,
      minute: delta.minute,
      half: delta.half,
      phase: delta.phase,
      homeScore: delta.homeScore,
      awayScore: delta.awayScore,
      stats: delta.stats,
      events,
      scores: delta.scores ?? current.scores,
      homeOn: delta.homeOn,
      awayOn: delta.awayOn,
      homeBench: delta.homeBench,
      awayBench: delta.awayBench,
      usedSubs: delta.usedSubs,
      automationFiredCount: delta.automationFiredCount,
      automationLog: delta.automationLog,
      progressPct: delta.progressPct,
      currentAddedTime: delta.currentAddedTime,
      homeTacticsCooldownMinutes: delta.homeTacticsCooldownMinutes,
      awayTacticsCooldownMinutes: delta.awayTacticsCooldownMinutes,
      missingPlayers: delta.missingPlayers ?? current.missingPlayers,
      ball: delta.ball ?? current.ball,
    });
  }, [applyState]);

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

  const refreshLiveState = useCallback(async () => {
    if (!matchId) return;
    if (refreshBusy) return;
    if (send({ type: "state" })) return;
    setRefreshBusy(true);
    try {
      const res = await api.liveState(matchId);
      applyState(res.state);
      if (res.state.ended) setNoLive(true);
    } catch (e) {
      if ((e as Error).message.includes("No live match")) setNoLive(true);
    } finally {
      setRefreshBusy(false);
    }
  }, [matchId, send, applyState, refreshBusy]);

  const connectWs = useCallback(() => {
    if (!matchId) return;
    setReconnecting(true);
    const ws = new WebSocket(api.liveWsUrl(matchId));
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
      } else if (msg.type === "delta" && msg.delta) {
        setWsMode(true);
        setReconnecting(false);
        applyDelta(msg.delta);
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
      } else if (msg.type === "tactics" && msg.state) {
        applyState(msg.state);
        setTacticsBusy(false);
        setTacticsStatus(msg.error ?? "Tactics updated");
      } else if (msg.type === "automation" && msg.state) {
        applyState(msg.state);
        setAutoBusy(false);
      } else if (msg.type === "halftimeReady" && msg.state) {
        applyState(msg.state);
        setHalftimeBusy(false);
      } else if (msg.type === "finished") {
        setNoLive(true);
      } else if (msg.type === "error") {
        setReconnecting(false);
        setWsMode(false);
        setTacticsBusy(false);
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
  }, [matchId, applyState, applyDelta]);

  // Matches advance only on the server clock; when the live state is done the
  // client simply returns to the dashboard.
  const backToDashboard = useCallback(() => {
    setLiveMatch(null);
    void (async () => {
      await refresh();
      navigate("/dashboard");
    })();
  }, [refresh, navigate, setLiveMatch]);

  useEffect(() => {
    if (!matchId) return;
    connectWs();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [matchId, connectWs]);

  useEffect(() => {
    if (!matchId) return;
    if (!stateRef.current) void refreshLiveState();
  }, [matchId, refreshLiveState]);

  useEffect(() => {
    if (!wsMode && !reconnecting && stateRef.current && !stateRef.current.ended) {
      const t = setTimeout(connectWs, 3000);
      return () => clearTimeout(t);
    }
  }, [wsMode, reconnecting, connectWs]);

  // Halftime countdown ticker
  useEffect(() => {
    if (!state || state.phase !== "halftime") return;
    const iv = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [state?.phase]);

  const doHalftimeReady = async () => {
    if (!matchId || halftimeBusy) return;
    setHalftimeBusy(true);
    try {
      if (send({ type: "halftimeReady" })) return;
      const res = await api.halftimeReady(matchId);
      applyState(res.state);
    } catch (e) {
      console.error(e);
    } finally {
      setHalftimeBusy(false);
    }
  };

  const doSub = async () => {
    if (!matchId || !subOut || !subIn || subBusy) return;
    setSubBusy(true);
    try {
      if (send({ type: "sub", outId: subOut.id, inId: subIn.id })) return;
      const res = await api.liveSub(matchId, subOut.id, subIn.id);
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

  const doTactics = async () => {
    if (!matchId || tacticsBusy || state?.isParticipant === false || state?.ended) return;
    setTacticsBusy(true);
    setTacticsStatus("");
    try {
      if (send({ type: "tactics", ...tacticDraft })) return;
      const res = await api.liveTactics(matchId, tacticDraft);
      applyState(res.state);
      setTacticsStatus("Tactics updated");
    } catch (e) {
      setTacticsStatus((e as Error).message);
    } finally {
      setTacticsBusy(false);
    }
  };

  const humanSide = state?.humanSide ?? 1;
  // Spectator: watching someone else's match — read-only UI.
  const isSpectator = state?.isParticipant === false;
  const onPitch = humanSide === 0 ? state?.homeOn ?? [] : state?.awayOn ?? [];
  const bench = humanSide === 0 ? state?.homeBench ?? [] : state?.awayBench ?? [];
  const usedSubs = state ? state.usedSubs[humanSide] : 0;
  const subsLeft = 5 - usedSubs;

  if (!state) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{t("live.matchday")}</div>
            <h1>{t("live.kickoff")}</h1>
          </div>
        </div>
        <div className="empty-state" style={{ paddingTop: 70 }}>
          {reconnecting ? t("live.connecting") : t("live.loading")}
        </div>
      </div>
    );
  }

  const isDone = state.ended;
  const scoreKey = `${state.homeScore}-${state.awayScore}`;

  const phaseLabel = t(`live.phase.${state.phase}`) || state.phase;
  const canChangeTactics = !isSpectator && !isDone && state.phase !== "shootout" && tacticsCooldownMinutes <= 0;

  if (state.phase === "pregame") {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{matchContextLabel(state, t as unknown as (k: string, o?: object) => string)}</div>
            <h1><ClubNameLink clubId={state.homeClubId} name={state.home} showCrest={false} /> {t("team.vs")} <ClubNameLink clubId={state.awayClubId} name={state.away} showCrest={false} /></h1>
          </div>
        </div>
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.4)", marginBottom: 16, padding: "22px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <h2 className="card-title" style={{ marginBottom: 4 }}>
                <span className="live-tag" style={{ fontSize: "0.7rem", padding: "3px 10px" }}>
                  {wsMode && !reconnecting ? <><span className="pulse-dot" /> {t("live.live")}</> : <><RefreshCw size={11} /> {reconnecting ? t("live.reconnecting") : t("live.fallback")}</>}
                </span>{" "}
                {isSpectator ? t("live.phase.pregame") : t("live.matchLineup")}
              </h2>
              <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>
                {isSpectator ? t("live.spectatorPregame") : t("live.participantPregame")}
              </div>
            </div>
            {!isSpectator && (
              <button className="btn gold" style={{ fontSize: "1.05rem", padding: "12px 28px" }} onClick={() => void refreshLiveState()}>
                <RefreshCw size={17} /> {t("live.refresh")}
              </button>
            )}
          </div>
          {/* Lineup editing is for participants only; spectators just see the pitch. */}
          {!isSpectator && <TacticsBoard mode="match" matchId={state.matchId} liveState={state} />}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
             {matchContextLabel(state, t as unknown as (k: string, o?: object) => string)}
            {isSpectator ? t("live.watchingSpectator") : ""}
          </div>
          <h1><ClubNameLink clubId={state.homeClubId} name={state.home} showCrest={false} /> {t("team.vs")} <ClubNameLink clubId={state.awayClubId} name={state.away} showCrest={false} /></h1>
        </div>
      </div>

      <div className="scoreboard" style={{ marginBottom: 16 }}>
        <div className="floodlights" />
        <button
          type="button"
          className="sound-toggle"
          onClick={toggleSoundMuted}
          title={soundMuted ? t("live.unmute") : t("live.mute")}
          aria-label={soundMuted ? t("live.unmute") : t("live.mute")}
        >
          {soundMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        {isDone ? (
          <span className="live-minute">{state.shootout ? t("live.penaltiesDecided") : t("live.phase.fulltime")}</span>
        ) : (
          <span className="live-tag">
            <span className="pulse-dot" /> {phaseLabel}
            {state.phase !== "halftime" && ` · ${state.currentAddedTime ? `${state.minute}+${state.currentAddedTime}'` : `${state.minute}'`}`}
            {state.phase === "halftime" && state.firstHalfAddedMinutes > 0 && ` · 45+${state.firstHalfAddedMinutes}'`}
          </span>
        )}

        <div className="live-score" key={scoreKey}>
          <span className="score-team"><ClubNameLink clubId={state.homeClubId} name={state.home} showCrest={false} /></span>
          <span className="score-num">{state.homeScore}</span>
          <span className="sep">—</span>
          <span className="score-num">{state.awayScore}</span>
          <span className="score-team"><ClubNameLink clubId={state.awayClubId} name={state.away} showCrest={false} /></span>
        </div>
        {state.shootout && (
          <div style={{ color: "var(--gold-2)", fontWeight: 700, marginBottom: 6 }}>
            {t("live.pens", { home: state.shootout.scores[0], away: state.shootout.scores[1], winner: state.shootout.winner })}
          </div>
        )}
      </div>

      {/* Match progress 0–90 (clamped, not stretched by added time) */}
      <div className="match-progress" aria-label={t("live.matchProgress", { pct: Math.round(state.progressPct) })} style={{ marginBottom: 16, height: 6, background: "rgba(255,255,255,0.12)", borderRadius: 999, overflow: "hidden" }}>
        <div className="match-progress-fill" style={{ width: `${Math.min(100, state.progressPct)}%`, height: "100%", background: "linear-gradient(90deg, var(--grass), var(--grass-2))", transition: "width 0.6s ease" }} />
      </div>

      <div className="live-columns">
        <div className="live-pitch-column">
          <MatchPitch
            home={home!}
            away={away!}
            missing={state.missingPlayers ?? []}
            events={state.events}
            phase={state.phase}
            minute={state.minute}
            addedTime={state.currentAddedTime ?? null}
            ball={state.ball ?? null}
            onEventRevealed={markRevealed}
            onPlayerClick={(id, name) => setPlayerTarget({ id, name })}
          />
        </div>
        <aside className="card live-side">
          <div className="live-side-head">
            <span className="live-tag" style={{ fontSize: "0.68rem", padding: "3px 9px" }}>
              {wsMode && !reconnecting ? <><span className="pulse-dot" /> {t("live.live")}</> : <><RefreshCw size={10} /> {reconnecting ? t("live.reconnecting") : t("live.fallback")}</>}
            </span>
            <div className="live-side-tabs" role="tablist" aria-label={t("live.matchHistory")}>
              {(["events", "scores", "stats", "tactics"] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={sideTab === tab} className={`live-side-tab${sideTab === tab ? " active" : ""}`} onClick={() => setSideTab(tab)}>
                  {(t as unknown as (k: string) => string)(`live.side${tab[0].toUpperCase()}${tab.slice(1)}`)}
                </button>
              ))}
            </div>
          </div>

          {sideTab === "events" && (
            <div className="live-side-content">
              <MatchHistory events={historyEvents} homeClubId={state.homeClubId} homeName={state.home} awayName={state.away} emptyText={isDone ? t("live.noEvents") : t("live.matchStarting")} onPlayerClick={(id, name) => setPlayerTarget({ id, name })} />
            </div>
          )}

          {sideTab === "scores" && (
            <div className="live-side-content">
              <PlayerScoresTable scores={state.scores ?? []} homeClubId={state.homeClubId} onPlayerClick={(id, name) => setPlayerTarget({ id, name })} />
            </div>
          )}

          {sideTab === "stats" && (
            <div className="live-side-content live-stats">
              <MatchStatsPanel stats={state.stats} usedSubs={state.usedSubs} />
            </div>
          )}

          {sideTab === "tactics" && (
            <div className="live-side-content live-tactics">
              <div className="live-tactics-hint">
                {isSpectator ? t("live.spectatorTactics") : t("live.participantTactics")}
              </div>
              {!isSpectator && tacticsCooldownMinutes > 0 && (
                <div className="live-tactics-hint" style={{ color: "var(--gold-2)" }}>
                  {tacticsCooldownMinutes === 1 ? t("live.tacticsLocked", { count: 1 }) : t("live.tacticsLockedOther", { count: tacticsCooldownMinutes })}
                </div>
              )}
              <label><span>Style</span><select className="select" value={tacticDraft.style} disabled={!canChangeTactics || tacticsBusy} onChange={(event) => setTacticDraft({ ...tacticDraft, style: Number(event.target.value) })}>{styleOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <div className="live-tactics-hint">{styleOptions()[tacticDraft.style]?.desc}</div></label>
              <label><span>Pressing</span><select className="select" value={tacticDraft.pressing} disabled={!canChangeTactics || tacticsBusy} onChange={(event) => setTacticDraft({ ...tacticDraft, pressing: Number(event.target.value) })}>{pressingOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <div className="live-tactics-hint">{pressingOptions()[tacticDraft.pressing]?.desc}</div></label>
              <label><span>Direction</span><select className="select" value={tacticDraft.direction} disabled={!canChangeTactics || tacticsBusy} onChange={(event) => setTacticDraft({ ...tacticDraft, direction: Number(event.target.value) })}>{directionOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <div className="live-tactics-hint">{directionOptions()[tacticDraft.direction]?.desc}</div></label>
              {typeof liveTactics?.familiarity === "number" && (
                <div>
                  <FamiliarityBar value={liveTactics.familiarity} projected={draftMatchesLive ? null : draftProjection} />
                  <div className="live-tactics-hint">
                    {draftMatchesLive
                      ? t("live.familiarityDrilled")
                      : t("live.familiarityDraft")}
                  </div>
                </div>
              )}
              {!isSpectator && <button className="btn gold" onClick={() => void doTactics()} disabled={!canChangeTactics || tacticsBusy}>{tacticsBusy ? t("live.applying") : tacticsCooldownMinutes > 0 ? t("live.lockedMin", { min: tacticsCooldownMinutes }) : t("live.applyTactics")}</button>}
              {!isSpectator && !isDone && <button className="btn" onClick={() => setShowSubs(true)} disabled={subsLeft <= 0}><Subscript size={15} /> {t("live.subs", { count: subsLeft })}</button>}
              {tacticsStatus && <div className="live-tactics-status">{tacticsStatus}</div>}
              {!isSpectator && state.phase === "halftime" && <div className="live-tactics-hint">{t("live.halftimeHint")}</div>}
            </div>
          )}
        </aside>
      </div>

      {state.phase === "halftime" && (() => {
        const pauseSec = (state.halftimePauseMinutes ?? 5) * 60;
        const elapsedSec = state.halftimeStartedAt ? Math.floor((nowTick - state.halftimeStartedAt) / 1000) : 0;
        const remainingSec = Math.max(0, pauseSec - elapsedSec);
        const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0");
        const ss = String(remainingSec % 60).padStart(2, "0");
        const myReady = state.halftimeReady?.[humanSide] ?? false;
        const homeReady = state.homeIsHuman ? (state.halftimeReady?.[0] ?? false) : true;
        const awayReady = state.awayIsHuman ? (state.halftimeReady?.[1] ?? false) : true;
        const bothHumans = state.homeIsHuman && state.awayIsHuman;
        const canReady = (state.homeIsHuman && humanSide === 0) || (state.awayIsHuman && humanSide === 1);
        return (
          <div className="card" style={{ borderColor: "rgba(240,180,41,0.4)", marginBottom: 16, textAlign: "center", padding: "18px 14px" }}>
            <h2 style={{ fontSize: "1.3rem", marginBottom: 6 }}>{t("live.interval", { time: `${mm}:${ss}` })}</h2>
            <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 6 }}>
              {isSpectator
                ? t("live.spectatorHalftime")
                : t("live.participantHalftime", { count: subsLeft })}
            </div>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 12 }}>
              {bothHumans ? (
                <span>{t("matchday.home")} {homeReady ? t("live.ready") : t("live.waiting")} · {t("matchday.away")} {awayReady ? t("live.ready") : t("live.waiting")} {bothHumans && homeReady && awayReady ? t("live.resuming") : ""}</span>
              ) : (
                <span>{remainingSec > 0 ? t("live.secondHalfResumes", { min: state.halftimePauseMinutes ?? 5, time: `${mm}:${ss}` }) : t("live.resumingDots")}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
               {!isSpectator && (
                 <button className="btn" onClick={() => setShowLineup((v) => !v)}>
                   <Users size={15} /> {showLineup ? t("live.hideLineup") : t("live.changeFormation")}
                 </button>
               )}
              {canReady && (
                <button className={`btn ${myReady ? "ghost" : "gold"}`} onClick={() => void doHalftimeReady()} disabled={halftimeBusy || myReady}>
                  {myReady ? t("live.ready") : t("live.imReady")}
                </button>
              )}
              <button className="btn ghost" onClick={() => void refreshLiveState()}><RefreshCw size={15} /> {t("live.refresh")}</button>
            </div>
            {showLineup && (
              <div style={{ textAlign: "left", marginTop: 16 }}>
                <TacticsBoard
                  mode="match"
                  matchId={state.matchId}
                  liveState={state}
                  onSaved={(s) => {
                    setShowLineup(false);
                    if (s) applyState(s);
                  }}
                />
              </div>
            )}
          </div>
        );
      })()}

      {!isSpectator && !isDone && state.automationDisabled !== undefined && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{t("live.autoPresets")}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>{t("live.rulesFired", { count: state.automationFiredCount ?? 0, state: state.automationDisabled?.[humanSide] ? t("live.automationPaused") : t("live.automationActive") })}</div>
            </div>
            <button
              className={`btn ${state.automationDisabled?.[humanSide] ? "gold" : "ghost"}`}
              disabled={autoBusy}
              onClick={() => {
                void (async () => {
                  const enabled = Boolean(state.automationDisabled?.[humanSide]);
                  setAutoBusy(true);
                  try {
                    if (send({ type: "automation", enabled })) return;
                    // WS is down: fall back to REST so the toggle never fails silently.
                    if (matchId) {
                      const res = await api.liveAutomationToggle(matchId, enabled);
                      applyState(res.state);
                    }
                  } catch (e) {
                    console.error(e);
                  } finally {
                    setAutoBusy(false);
                  }
                })();
              }}
            >
              {state.automationDisabled?.[humanSide] ? t("live.resumeAutomation") : t("live.pauseAutomation")}
            </button>
          </div>
          {(state.automationLog?.length ?? 0) > 0 && (
            <div className="aut-log" style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: isMobile ? "30vh" : 160, overflowY: "auto" }}>
              {[...state.automationLog!].reverse().map((entry, i) => (
                <div key={i} style={{ fontSize: "0.8rem", color: entry.status === "APPLIED" ? "var(--grass-2)" : "var(--text-3)" }}>
                  {entry.minute}&apos; — {entry.status === "APPLIED" ? t("live.autoLogApplied") : entry.status === "RETIRED" ? t("live.autoLogRetired", { reason: tDynamic(automationReasonKey(entry.reason)) }) : t("live.autoLogSkipped", { reason: tDynamic(automationReasonKey(entry.reason)) })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        {isDone ? (
          <button className="btn gold" onClick={backToDashboard}>
            <Flag size={15} /> {t("live.backToDashboard")}
          </button>
        ) : (
          state.phase !== "halftime" && (
            <>
              <button className="btn ghost" onClick={() => void refreshLiveState()}>
                <RefreshCw size={15} /> {t("live.refresh")}
              </button>
            </>
          )
        )}
      </div>

      {showSubs && (
        <div className="modal-overlay" onClick={() => setShowSubs(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 4 }}>{t("live.substitutions")}</h3>
            <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginBottom: 12 }}>
              {subsLeft === 1 ? t("live.subsRemaining", { count: 1 }) : t("live.subsRemainingOther", { count: subsLeft })}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div className="card-title" style={{ marginBottom: 6 }}>{t("live.onThePitch")}</div>
                <div className="sub-list">
                  {onPitch.map((p) => (
                    <button
                      key={p.id}
                      className={`sub-row is-on-pitch${subOut?.id === p.id ? " sel" : ""}`}
                      onClick={() => setSubOut(p)}
                    >
                      <span className={`tb-row-position ${positionClass(p.naturalPosition)}`} title={positionLabel(p.naturalPosition)}>{p.deployedRole ?? p.naturalPosition}</span>
                      <span className="tb-row-body">
                        <span className="tb-row-name">{(p.displayName ?? p.name)}</span>
                        <span className="tb-energy-bar" aria-label={t("tactics.energyAria", { value: Math.round(p.energy) })}>
                          <span className="tb-energy-fill" style={{ width: `${Math.max(0, Math.min(100, p.energy))}%` }} />
                        </span>
                      </span>
                      <strong className="sub-rating">{p.overall}</strong>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="card-title" style={{ marginBottom: 6 }}>{t("live.bench")}</div>
                <div className="sub-list">
                  {[...bench]
                    .sort((a, b) => (POSITION_ORDER[a.naturalPosition as NaturalPosition] ?? Number.MAX_SAFE_INTEGER) - (POSITION_ORDER[b.naturalPosition as NaturalPosition] ?? Number.MAX_SAFE_INTEGER) || b.overall - a.overall)
                    .map((p) => (
                    <button
                      key={p.id}
                      className={`sub-row is-bench${subIn?.id === p.id ? " sel" : ""}`}
                      onClick={() => setSubIn(p)}
                      disabled={p.injuryDays > 0 || p.suspended}
                    >
                      <span className={`tb-row-position ${positionClass(p.naturalPosition)}`} title={positionLabel(p.naturalPosition)}>{naturalPosition(p)}</span>
                      <span className="tb-row-body">
                        <span className="tb-row-name">{(p.displayName ?? p.name)}</span>
                        <span className="tb-energy-bar" aria-label={t("tactics.energyAria", { value: Math.round(p.energy) })}>
                          <span className="tb-energy-fill" style={{ width: `${Math.max(0, Math.min(100, p.energy))}%` }} />
                        </span>
                      </span>
                      <strong className="sub-rating">{p.overall}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowSubs(false)}>{t("live.close")}</button>
              <button className="btn" style={{ flex: 1 }} onClick={() => void doSub()} disabled={!subOut || !subIn || subBusy}>
                {t("live.confirmSub")}
              </button>
            </div>
          </div>
        </div>
      )}
      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}
