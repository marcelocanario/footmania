import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { KitDesign, LiveEvent, LivePlayer } from "../api/client";
import { kitDotBackground } from "./kit/kitCss";
import { cueForEvent, eventKey, teamPitchPoints, type PitchCue, type PitchPoint, type PitchSide } from "./matchPitchUtils";

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

function PlayerMarker({ player, point, kit, highlighted }: { player: LivePlayer; point: PitchPoint; side: PitchSide; kit: PitchTeam["kit"]; highlighted: boolean }) {
  const style = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    "--kit": kit.primary,
    "--kit-2": kit.secondary,
    "--kit-dot": kitDotBackground(kit),
  } as CSSProperties;
  return (
    <span
      className={`pitch-player${highlighted ? " pitch-player-highlight" : ""}${player.injuryDays > 0 ? " pitch-player-injured" : ""}`}
      style={style}
      role="img"
      aria-label={`${player.name}, ${player.tacPos}`}
      title={`${player.name} · ${player.tacPos}`}
    >
      <span className="pitch-player-dot">{player.name.slice(0, 1).toUpperCase()}</span>
      <span className="pitch-player-name">{player.name}</span>
    </span>
  );
}

function CueOverlay({ cue, reducedMotion }: { cue: PitchCue; reducedMotion: boolean }) {
  const { actorPoint, secondaryPoint, targetPoint } = cue;
  const activeClass = reducedMotion ? " pitch-cue-reduced" : "";
  const ballEvent = cue.kind === "goal" || cue.kind === "miss";
  const actorY = (actorPoint.y / 100) * 64;
  const targetY = (targetPoint.y / 100) * 64;
  return (
    <>
      {(cue.kind === "assist" || cue.kind === "goal") && secondaryPoint && (
        <svg className="pitch-trail" viewBox="0 0 100 64" aria-hidden="true">
          <line x1={secondaryPoint.x} y1={(secondaryPoint.y / 100) * 64} x2={actorPoint.x} y2={actorY} />
        </svg>
      )}
      {ballEvent && (
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

export function MatchPitch({ home, away, events, phase, minute, addedTime, reducedMotion = false }: MatchPitchProps) {
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

  useEffect(() => {
    const fresh = events.filter((event) => !seenRef.current.has(eventKey(event)));
    for (const event of fresh) seenRef.current.add(eventKey(event));
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (fresh.length > 0) {
      setQueue((current) => [...current, ...fresh].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
    }
  }, [events]);

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

  const displayedEvent = activeEvent ?? events[events.length - 1] ?? null;
  const cue = displayedEvent
    ? cueForEvent(displayedEvent, home.clubId, home.players, away.players, rememberedRef.current)
    : null;
  const homeHighlighted = cue?.actorSide === "home" ? cue.event.playerId : null;
  const awayHighlighted = cue?.actorSide === "away" ? cue.event.playerId : null;
  const homeSecondaryHighlighted = cue?.actorSide === "home" ? cue.event.player2Id : null;
  const awaySecondaryHighlighted = cue?.actorSide === "away" ? cue.event.player2Id : null;
  const fmtMinute = (m: number, a?: number | null) => (a ? `${m}+${a}'` : `${m}'`);
  const status = cue ? `${EVENT_COPY[cue.kind]} · ${fmtMinute(cue.event.minute, cue.event.addedTime)}` : phase === "pregame" ? "Lineups" : fmtMinute(minute, addedTime);

  return (
    <section className="match-pitch-card" aria-label="Live match pitch">
      <div className="match-pitch-head">
        <div>
          <div className="card-title">Live pitch</div>
          <div className="match-pitch-status"><span className="pulse-dot" /> {status}</div>
        </div>
        <div className="match-pitch-teams" aria-hidden="true">
          <span><i style={{ background: home.kit.primary }} />{home.name}</span>
          <span><i style={{ background: away.kit.primary }} />{away.name}</span>
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
        {cue && <CueOverlay cue={cue} reducedMotion={motionReduced} />}
        <div className="pitch-players">
          {home.players.map((player) => <PlayerMarker key={`home-${player.id}`} player={player} point={homePoints.get(player.id) ?? { x: 50, y: 50 }} side="home" kit={player.tacPos === 1 ? home.gkKit : home.kit} highlighted={homeHighlighted === player.id || homeSecondaryHighlighted === player.id} />)}
          {away.players.map((player) => <PlayerMarker key={`away-${player.id}`} player={player} point={awayPoints.get(player.id) ?? { x: 50, y: 50 }} side="away" kit={player.tacPos === 1 ? away.gkKit : away.kit} highlighted={awayHighlighted === player.id || awaySecondaryHighlighted === player.id} />)}
        </div>
        {cue && activeEvent && <div className="pitch-event-banner"><b>{EVENT_COPY[cue.kind]}</b><span>{cue.event.player || cue.event.player2}</span></div>}
      </div>
    </section>
  );
}
