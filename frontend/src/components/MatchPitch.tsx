import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { KitDesign, LiveBall, LiveEvent, LivePlayer } from "../api/client";
import { FootballKit } from "./kit/FootballKit";
import {
  BALL_CENTER_POINT,
  cueForEvent,
  eventKey,
  isSetPieceStart,
  placeLiveBall,
  teamPitchPoints,
  type PitchCue,
  type PitchPoint,
  type PitchSide,
} from "./matchPitchUtils";
import { formationLabel } from "../tacticsOptions";

interface PitchTeam {
  clubId: number;
  name: string;
  kit: KitDesign;
  /** Kit Lab GK design; the tacPos===1 marker wears it (LiveState.homeGkKit/awayGkKit). */
  gkKit: KitDesign;
  players: LivePlayer[];
  formationId: number;
}

export interface MatchPitchProps {
  home: PitchTeam;
  away: PitchTeam;
  events: LiveEvent[];
  phase: string;
  minute: number;
  addedTime?: number | null;
  reducedMotion?: boolean;
  /** Possession snapshot streamed per match-minute; drives the live ball. */
  ball?: LiveBall | null;
}

const EVENT_COPY: Record<string, string> = {
  goal: "Goal",
  miss: "Penalty missed",
  yellow: "Yellow card",
  red: "Red card",
  injury: "Injury",
  sub: "Substitution",
  assist: "Assist",
};

/** Phases in which the live ball follows possession; other phases park it at the centre spot. */
const LIVE_PLAY_PHASES = new Set(["first", "second", "et1", "et2"]);

function PlayerMarker({ player, point, kit, highlighted }: { player: LivePlayer; point: PitchPoint; side: PitchSide; kit: PitchTeam["kit"]; highlighted: boolean }) {
  const style = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    "--kit": kit.primary,
    "--kit-2": kit.secondary,
  } as CSSProperties;
  return (
    <span
      className={`pitch-player${highlighted ? " pitch-player-highlight" : ""}${player.injuryDays > 0 ? " pitch-player-injured" : ""}`}
      style={style}
      role="img"
      aria-label={`${player.name}, ${player.tacPos}`}
      title={`${player.name} · ${player.tacPos}`}
    >
      <span className="pitch-player-kit" aria-hidden="true">
        <FootballKit {...kit} number={player.number ?? ""} size="100%" flat />
      </span>
      <span className="pitch-player-name">{player.number != null ? `${player.number} · ${player.name}` : player.name}</span>
    </span>
  );
}

function CueOverlay({ cue, active, reducedMotion }: { cue: PitchCue; active: boolean; reducedMotion: boolean }) {
  const { actorPoint, secondaryPoint, targetPoint } = cue;
  const activeClass = reducedMotion ? " pitch-cue-reduced" : "";
  const ballEvent = cue.kind === "goal" || cue.kind === "miss";
  const actorY = (actorPoint.y / 100) * 64;
  const targetY = (targetPoint.y / 100) * 64;
  return (
    <>
      {/* Ball layers only render while the cue plays out; afterwards the
          persistent possession ball takes over so the pitch never shows two
          balls (e.g. one frozen in the net plus the kickoff ball). */}
      {active && (cue.kind === "assist" || cue.kind === "goal") && secondaryPoint && (
        <svg className="pitch-trail" viewBox="0 0 100 64" aria-hidden="true">
          <line x1={secondaryPoint.x} y1={(secondaryPoint.y / 100) * 64} x2={actorPoint.x} y2={actorY} />
        </svg>
      )}
      {active && ballEvent && (
        <svg className={`pitch-ball-layer${cue.event.subtype === 3 || cue.event.subtype === 4 ? " pitch-ball-set-piece" : ""}${activeClass}`} viewBox="0 0 100 64" aria-hidden="true">
          <circle cx={actorPoint.x} cy={actorY} r="1.3" className="pitch-ball">
            {!reducedMotion && <animate attributeName="cx" from={actorPoint.x} to={targetPoint.x} dur="0.9s" fill="freeze" />}
            {!reducedMotion && <animate attributeName="cy" from={actorY} to={targetY} dur="0.9s" fill="freeze" />}
          </circle>
        </svg>
      )}
      <span className={`pitch-cue-icon pitch-cue-${cue.kind}${activeClass}`} style={{ left: `${actorPoint.x}%`, top: `${actorPoint.y}%` }} aria-hidden="true">
        {cue.kind === "yellow" ? "🟨" : cue.kind === "red" ? "🟥" : cue.kind === "injury" ? "✚" : cue.kind === "sub" ? "↔" : cue.kind === "miss" ? "×" : cue.kind === "goal" ? "⚽" : "↗"}
      </span>
    </>
  );
}

export function MatchPitch({ home, away, events, phase, minute, addedTime, reducedMotion = false, ball = null }: MatchPitchProps) {
  const [activeEvent, setActiveEvent] = useState<LiveEvent | null>(null);
  const [queue, setQueue] = useState<LiveEvent[]>([]);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const seenRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const rememberedRef = useRef<Map<number, PitchPoint>>(new Map());
  const motionReduced = reducedMotion || systemReducedMotion;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setSystemReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const players = useMemo(() => [...home.players, ...away.players], [home.players, away.players]);
  const homePoints = useMemo(() => teamPitchPoints(home.players, "home", home.formationId), [home.players, home.formationId]);
  const awayPoints = useMemo(() => teamPitchPoints(away.players, "away", away.formationId), [away.players, away.formationId]);
  useEffect(() => {
    for (const player of players) {
      const side: PitchSide = home.players.some((p) => p.id === player.id) ? "home" : "away";
      const points = side === "home" ? homePoints : awayPoints;
      rememberedRef.current.set(player.id, points.get(player.id) ?? { x: 50, y: 50 });
    }
  }, [players, home.players, homePoints, awayPoints]);

  const pitchEvents = useMemo(() => events.filter((event) => event.type !== 8), [events]);

  // Live possession ball: anchored to the possessing side's nearest supporting
  // player during play; parked at the centre spot whenever play is stopped.
  const liveBall = useMemo(() => {
    if (!ball) return null;
    if (!LIVE_PLAY_PHASES.has(phase)) {
      return { idle: true as const, carrierId: null, point: BALL_CENTER_POINT };
    }
    const homePossesses = ball.side === 0;
    const players = homePossesses ? home.players : away.players;
    const points = homePossesses ? homePoints : awayPoints;
    return { idle: false as const, ...placeLiveBall(ball, minute, players, points) };
  }, [ball, phase, minute, home.players, away.players, homePoints, awayPoints]);

  const lastBallPointRef = useRef<PitchPoint | null>(null);
  const trailSeqRef = useRef(0);
  const [trail, setTrail] = useState<{ from: PitchPoint; to: PitchPoint; key: number } | null>(null);
  useEffect(() => {
    if (!liveBall || liveBall.idle || motionReduced) {
      lastBallPointRef.current = null;
      setTrail(null);
      return;
    }
    const prev = lastBallPointRef.current;
    lastBallPointRef.current = liveBall.point;
    if (!prev) return;
    if (Math.abs(prev.x - liveBall.point.x) < 0.4 && Math.abs(prev.y - liveBall.point.y) < 0.4) return;
    trailSeqRef.current += 1;
    setTrail({ from: prev, to: liveBall.point, key: trailSeqRef.current });
  }, [liveBall, motionReduced]);

  useEffect(() => {
    const fresh = pitchEvents.filter((event) => !seenRef.current.has(eventKey(event)));
    for (const event of fresh) seenRef.current.add(eventKey(event));
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (fresh.length > 0) {
      setQueue((current) => [...current, ...fresh].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
    }
  }, [pitchEvents]);

  useEffect(() => {
    if (activeEvent || queue.length === 0) return;
    setActiveEvent(queue[0]);
    setQueue((current) => current.slice(1));
  }, [activeEvent, queue]);

  useEffect(() => {
    if (!activeEvent) return;
    const timer = window.setTimeout(() => setActiveEvent(null), motionReduced ? 900 : 2300);
    return () => window.clearTimeout(timer);
  }, [activeEvent, motionReduced]);

  const displayedEvent = activeEvent && activeEvent.type !== 8 ? activeEvent : pitchEvents[pitchEvents.length - 1] ?? null;
  const cue = displayedEvent
    ? cueForEvent(displayedEvent, home.clubId, home.players, away.players, rememberedRef.current)
    : null;
  const cueActive = !!activeEvent;
  const shotCueActive = cueActive && !!cue && (cue.kind === "goal" || cue.kind === "miss");
  const homeHighlighted = cue?.actorSide === "home" ? cue.event.playerId : null;
  const awayHighlighted = cue?.actorSide === "away" ? cue.event.playerId : null;
  const homeSecondaryHighlighted = cue?.actorSide === "home" ? cue.event.player2Id : null;
  const awaySecondaryHighlighted = cue?.actorSide === "away" ? cue.event.player2Id : null;
  const fmtMinute = (m: number, a?: number | null) => (a ? `${m}+${a}'` : `${m}'`);
  const status = cue ? `${EVENT_COPY[cue.kind]} · ${fmtMinute(cue.event.minute, cue.event.addedTime)}` : phase === "pregame" ? "Lineups" : fmtMinute(minute, addedTime);
  const showLiveBall = !!liveBall && !shotCueActive;
  const liveBallClass = [
    "pitch-live-ball",
    liveBall?.idle ? "pitch-live-ball-idle" : "",
    !liveBall?.idle && ball && isSetPieceStart(ball.startType) ? "pitch-live-ball-setpiece" : "",
    !liveBall?.idle && ball?.counter && ball.phase === "TRANSITION" ? "pitch-live-ball-counter" : "",
    motionReduced ? "pitch-live-ball-reduced" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="match-pitch-card" aria-label="Live match pitch">
      <div className="match-pitch-head">
        <div>
          <div className="card-title">Live pitch</div>
          <div className="match-pitch-status"><span className="pulse-dot" /> {status}</div>
        </div>
        <div className="match-pitch-teams">
          <span className="match-pitch-team">
            <FootballKit {...home.kit} size={34} flat />
            <span><b>{home.name}</b><small>{formationLabel(home.formationId)}</small></span>
          </span>
          <span className="match-pitch-team">
            <FootballKit {...away.kit} size={34} flat />
            <span><b>{away.name}</b><small>{formationLabel(away.formationId)}</small></span>
          </span>
        </div>
      </div>
      <div className={`pitch-surface${cue && activeEvent ? ` pitch-${cue.kind}-active` : ""}${motionReduced ? " pitch-reduced-motion" : ""}`}>
        <svg className="pitch-lines" viewBox="0 0 100 64" role="img" aria-label={`${home.name} versus ${away.name} formation pitch`}>
          <defs>
            <linearGradient id="pitchGrass" x1="0" x2="1">
              <stop offset="0" stopColor="#176b3c" />
              <stop offset="0.5" stopColor="#238b4b" />
              <stop offset="1" stopColor="#176b3c" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="64" rx="3" fill="url(#pitchGrass)" />
          <path d="M 50 0 V 64 M 2 2 H 98 V 62 H 2 Z M 2 18 H 18 V 46 H 2 Z M 2 25 H 8 V 39 H 2 Z M 98 18 H 82 V 46 H 98 Z M 98 25 H 92 V 39 H 98 Z" fill="none" stroke="rgba(238,246,239,0.72)" strokeWidth="0.45" />
          <circle cx="50" cy="32" r="8" fill="none" stroke="rgba(238,246,239,0.72)" strokeWidth="0.45" />
          <circle cx="50" cy="32" r="0.7" fill="rgba(238,246,239,0.8)" />
        </svg>
        {trail && !motionReduced && (
          <svg className="pitch-trail pitch-live-trail" viewBox="0 0 100 64" aria-hidden="true">
            <line key={trail.key} x1={trail.from.x} y1={(trail.from.y / 100) * 64} x2={trail.to.x} y2={(trail.to.y / 100) * 64} />
          </svg>
        )}
        {showLiveBall && liveBall && (
          <span className={liveBallClass} style={{ left: `${liveBall.point.x}%`, top: `${liveBall.point.y}%` }} aria-hidden="true" />
        )}
        {cue && <CueOverlay cue={cue} active={cueActive} reducedMotion={motionReduced} />}
        <div className="pitch-players">
          {home.players.map((player) => <PlayerMarker key={`home-${player.id}`} player={player} point={homePoints.get(player.id) ?? { x: 50, y: 50 }} side="home" kit={player.tacPos === 1 ? home.gkKit : home.kit} highlighted={homeHighlighted === player.id || homeSecondaryHighlighted === player.id} />)}
          {away.players.map((player) => <PlayerMarker key={`away-${player.id}`} player={player} point={awayPoints.get(player.id) ?? { x: 50, y: 50 }} side="away" kit={player.tacPos === 1 ? away.gkKit : away.kit} highlighted={awayHighlighted === player.id || awaySecondaryHighlighted === player.id} />)}
        </div>
        {cue && activeEvent && <div className="pitch-event-banner"><b>{EVENT_COPY[cue.kind]}</b><span>{cue.event.player || cue.event.player2}</span></div>}
      </div>
    </section>
  );
}
