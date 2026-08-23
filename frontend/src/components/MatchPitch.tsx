import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { KitDesign, LiveBall, LiveEvent, LiveMissingPlayer, LivePlayer } from "../api/client";
import { FootballKit } from "./kit/FootballKit";
import { ClubNameLink } from "./ClubNameLink";
import {
  BALL_CENTER_POINT,
  cueForEvent,
  eventKey,
  isSetPieceStart,
  placeLiveBall,
  slotPointsFor,
  teamPitchPoints,
  turnoverIntent,
  type IntentLine,
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
  /** Players absent from the pitch (red cards; unreplaced injuries). */
  missing?: LiveMissingPlayer[];
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
};

/** Kinds loud enough to earn the bottom banner; detail cues (corner/save/post) flash their pitch icon only. */
const BANNER_KINDS = new Set(["goal", "miss", "yellow", "red", "injury", "sub"]);

/** Phases in which the live ball follows possession; other phases park it at the centre spot. */
const LIVE_PLAY_PHASES = new Set(["first", "second", "et1", "et2"]);

// Shot choreography timings (presentation-only, mirroring the cue windows
// above): the ball glides to the goalkeeper/frame, pauses, then distributes.
const SEQ_LEG_MS = 900;
const SEQ_HOLD_MS = 600;
const SEQ_PASS_MS = 800;
/** Cap on waiting for the post-save possession snapshot before resuming. */
const SEQ_HOLD_MAX_MS = 2600;
/** Curated event codes with ball-travel choreography (EVENT_CODES mirrors). */
const EVENT_SAVE = 15;
const EVENT_WOODWORK = 16;
const CUE_MAX_AGE_MINUTES = 1;

function cueIsFresh(event: LiveEvent, displayMinute: number): boolean {
  return displayMinute - event.minute <= CUE_MAX_AGE_MINUTES;
}

/**
 * A scripted ball sequence that owns the ⚽ while it plays out: saves glide
 * shooter/carrier → GK, pause at the gloves, then distribute to the first
 * post-save carrier; woodwork hits kiss the frame. Goals keep the dedicated
 * CueOverlay animation into the net.
 */
interface BallSeq {
  key: number;
  kind: "save" | "woodwork";
  stage: "start" | "leg" | "hold" | "pass";
  /** Origin of the currently displayed leg. */
  from: PitchPoint;
  /** Current rendered point (target of the active glide). */
  point: PitchPoint;
  /** Side that saved (ball recipient); null for woodwork. */
  gkSide: PitchSide | null;
}

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

const MISSING_COPY: Record<LiveMissingPlayer["kind"], string> = {
  RED: "Sent off",
  INJURY: "Injured · no substitution left",
};

/** Ghost marker for a vacated tactical slot: dimmed jersey with a persistent
 *  cause badge (🟥 red card / ✚ injury), so short-handed teams read at a
 *  glance. */
function MissingMarker({ missing, point, kit }: { missing: LiveMissingPlayer; point: PitchPoint; kit: PitchTeam["kit"] }) {
  const style = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    "--kit": kit.primary,
    "--kit-2": kit.secondary,
  } as CSSProperties;
  return (
    <span
      className="pitch-player pitch-missing"
      style={style}
      role="img"
      aria-label={`${missing.name}, ${MISSING_COPY[missing.kind]}`}
      title={`${missing.name} · ${MISSING_COPY[missing.kind]}`}
    >
      <span className="pitch-player-kit" aria-hidden="true">
        <FootballKit {...kit} number={missing.number ?? ""} size="100%" flat />
      </span>
      <span className={`pitch-missing-badge pitch-missing-${missing.kind === "RED" ? "red" : "injury"}`} aria-hidden="true">
        {missing.kind === "RED" ? "🟥" : "✚"}
      </span>
      <span className="pitch-player-name">{missing.number != null ? `${missing.number} · ${missing.name}` : missing.name}</span>
    </span>
  );
}

function CueOverlay({ cue, active, reducedMotion }: { cue: PitchCue; active: boolean; reducedMotion: boolean }) {
  const { actorPoint, targetPoint } = cue;
  const activeClass = reducedMotion ? " pitch-cue-reduced" : "";
  const ballEvent = cue.kind === "goal" || cue.kind === "miss";
  const actorY = (actorPoint.y / 100) * 64;
  const targetY = (targetPoint.y / 100) * 64;
  return (
    <>
      {/* Ball layers only render while the cue plays out; afterwards the
          persistent possession ball takes over so the pitch never shows two
          balls (e.g. one frozen in the net plus the kickoff ball). */}
      {active && ballEvent && (
        <svg className="pitch-trail" viewBox="0 0 100 64" aria-hidden="true">
          <line x1={actorPoint.x} y1={actorY} x2={targetPoint.x} y2={targetY} />
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
        {cue.kind === "yellow" ? "🟨" : cue.kind === "red" ? "🟥" : cue.kind === "injury" ? "✚" : cue.kind === "sub" ? "↔" : cue.kind === "miss" ? "×" : cue.kind === "goal" ? "⚽" : cue.kind === "corner" ? "🚩" : cue.kind === "save" ? "🧤" : "💥"}
      </span>
    </>
  );
}

export function MatchPitch({ home, away, missing = [], events, phase, minute, reducedMotion = false, ball = null }: MatchPitchProps) {
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
  // Missing-player ghosts: red cards and unreplaced injuries leave vacated
  // tactical slots; each marker sits where the player used to stand.
  const homeMissing = useMemo(() => missing.filter((entry) => entry.side === 0), [missing]);
  const awayMissing = useMemo(() => missing.filter((entry) => entry.side === 1), [missing]);
  const homeMissingPoints = useMemo(
    () => slotPointsFor(homeMissing.map((entry) => entry.tacPos), "home", home.formationId),
    [homeMissing, home.formationId]
  );
  const awayMissingPoints = useMemo(
    () => slotPointsFor(awayMissing.map((entry) => entry.tacPos), "away", away.formationId),
    [awayMissing, away.formationId]
  );
  const shortSuffix = (sideMissing: LiveMissingPlayer[]) => {
    if (sideMissing.length === 0) return "";
    const icons = sideMissing.map((entry) => (entry.kind === "RED" ? "🟥" : "✚")).join("");
    return ` · ${icons} ${sideMissing.length === 1 ? "1 man short" : `${sideMissing.length} men short`}`;
  };
  useEffect(() => {
    for (const player of players) {
      const side: PitchSide = home.players.some((p) => p.id === player.id) ? "home" : "away";
      const points = side === "home" ? homePoints : awayPoints;
      rememberedRef.current.set(player.id, points.get(player.id) ?? { x: 50, y: 50 });
    }
  }, [players, home.players, homePoints, awayPoints]);

  const pitchEvents = useMemo(() => events.filter((event) => event.type !== 8), [events]);

  // The live cue comes solely from the actively playing event; between cues
  // nothing is highlighted so the possession ball stays the single focus.
  const cueActive = !!activeEvent && cueIsFresh(activeEvent, minute);
  const cue = cueActive && activeEvent ? cueForEvent(activeEvent, home.clubId, home.players, away.players, rememberedRef.current) : null;
  const overlayBallActive = cueActive && !!cue && (cue.kind === "goal" || cue.kind === "miss");
  const shotCueActive = cueActive && !!cue && (cue.kind === "goal" || cue.kind === "miss" || cue.kind === "save" || cue.kind === "woodwork");

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
    return { idle: false as const, side: (homePossesses ? "home" : "away") as PitchSide, ...placeLiveBall(ball, players, points) };
  }, [ball, phase, home.players, away.players, homePoints, awayPoints]);

  const lastBallPointRef = useRef<PitchPoint | null>(null);
  const trailSeqRef = useRef(0);
  const [trail, setTrail] = useState<{ from: PitchPoint; to: PitchPoint; key: number; intent?: IntentLine | null } | null>(null);

  // --- Scripted shot sequences (save / woodwork) ---------------------------
  const seqKeyRef = useRef(0);
  const seqTimerRef = useRef<number | null>(null);
  const seqRafRef = useRef<number | null>(null);
  const [seq, setSeq] = useState<BallSeq | null>(null);
  const seqRef = useRef<BallSeq | null>(null);
  const activeEventRef = useRef<LiveEvent | null>(null);
  const liveBallRef = useRef(liveBall);
  // Possession metadata of the previously rendered snapshot; a side change is
  // the turnover signal for the dotted intent line.
  const prevBallMetaRef = useRef<{ side: PitchSide; zone: string; carrierId: number | null; point: PitchPoint } | null>(null);

  useLayoutEffect(() => {
    liveBallRef.current = liveBall;
    seqRef.current = seq;
  }, [liveBall, seq]);

  function scheduleSeqTimer(fn: () => void, ms: number) {
    if (seqTimerRef.current !== null) window.clearTimeout(seqTimerRef.current);
    seqTimerRef.current = window.setTimeout(() => {
      seqTimerRef.current = null;
      fn();
    }, ms);
  }

  function finishBallSeq(seed: PitchPoint) {
    if (seqTimerRef.current !== null) {
      window.clearTimeout(seqTimerRef.current);
      seqTimerRef.current = null;
    }
    if (seqRafRef.current !== null) {
      window.cancelAnimationFrame(seqRafRef.current);
      seqRafRef.current = null;
    }
    // Seed the trajectory origin so the next real move draws from here.
    lastBallPointRef.current = seed;
    setSeq(null);
  }

  function playPassLeg(key: number, target: PitchPoint) {
    setSeq((current) => (current && current.key === key
      ? { ...current, stage: "pass", from: current.point, point: target }
      : current));
    scheduleSeqTimer(() => finishBallSeq(target), SEQ_PASS_MS);
  }

  function beginShotLeg(initial: BallSeq, target: PitchPoint, onArrival: () => void) {
    setSeq(initial);
    if (seqRafRef.current !== null) window.cancelAnimationFrame(seqRafRef.current);
    // Paint the ball at the authoritative shooter with transitions off before
    // starting its glide on the next frame. Otherwise it flies in from the
    // unrelated synthetic possession carrier.
    seqRafRef.current = window.requestAnimationFrame(() => {
      seqRafRef.current = window.requestAnimationFrame(() => {
        seqRafRef.current = null;
        setSeq((current) => (current && current.key === initial.key
          ? { ...current, stage: "leg", from: initial.point, point: target }
          : current));
        scheduleSeqTimer(onArrival, SEQ_LEG_MS);
      });
    });
  }

  function collectAtGk(key: number) {
    const current = seqRef.current;
    if (!current || current.key !== key || !current.gkSide) return;
    const lb = liveBallRef.current;
    if (lb && !lb.idle && lb.side === current.gkSide) {
      // The post-save snapshot already arrived with the event: distribute now.
      playPassLeg(key, lb.point);
      return;
    }
    setSeq((s) => (s && s.key === key ? { ...s, stage: "hold" } : s));
    scheduleSeqTimer(() => {
      const held = seqRef.current;
      if (held && held.key === key) finishBallSeq(held.point);
    }, SEQ_HOLD_MAX_MS);
  }

  // Intercept save/woodwork cues and hand the ⚽ to the sequence. Declared
  // before the trajectory effect so lastBallPointRef still holds the pre-shot
  // ball position when this runs.
  useLayoutEffect(() => {
    const ev = activeEvent;
    const prevEv = activeEventRef.current;
    activeEventRef.current = ev;
    if (!ev || ev === prevEv || !cueIsFresh(ev, minute) || motionReduced || !liveBall || liveBall.idle) return;
    const kind = ev.type === EVENT_SAVE ? ("save" as const) : ev.type === EVENT_WOODWORK ? ("woodwork" as const) : null;
    if (!kind) return;
    const cueInfo = cueForEvent(ev, home.clubId, home.players, away.players, rememberedRef.current);
    if (!cueInfo) return;
    // The suppressed possession ball must not spawn a trajectory of its own.
    const previousPoint = lastBallPointRef.current;
    lastBallPointRef.current = null;
    prevBallMetaRef.current = null;
    setTrail(null);
    const key = ++seqKeyRef.current;
    if (kind === "woodwork") {
      // Kiss the frame beside the goal mouth the attack was aiming at.
      const frame = cueInfo.side === "home" ? { x: 95, y: 38 } : { x: 5, y: 38 };
      const shooter = cueInfo.actorPoint;
      beginShotLeg({ key, kind, stage: "start", from: shooter, point: shooter, gkSide: null }, frame, () => {
        setSeq((current) => (current && current.key === key ? { ...current, stage: "hold" } : current));
        scheduleSeqTimer(() => finishBallSeq(frame), SEQ_HOLD_MS);
      });
      return;
    }
    const gkSide = cueInfo.actorSide;
    const shooter = cueInfo.secondaryPoint ?? previousPoint ?? cueInfo.actorPoint;
    beginShotLeg({ key, kind, stage: "start", from: shooter, point: shooter, gkSide }, cueInfo.actorPoint, () => {
      setSeq((current) => (current && current.key === key ? { ...current, stage: "hold" } : current));
      scheduleSeqTimer(() => collectAtGk(key), SEQ_HOLD_MS);
    });
  }, [activeEvent, motionReduced, liveBall, home.clubId, home.players, away.players]);

  useEffect(() => () => {
    if (seqTimerRef.current !== null) window.clearTimeout(seqTimerRef.current);
    if (seqRafRef.current !== null) window.cancelAnimationFrame(seqRafRef.current);
  }, []);

  useLayoutEffect(() => {
    // While a scripted sequence owns the ⚽ the possession stream must not
    // spawn trajectories or move the seeding refs underneath it.
    if (seq) return;
    // Replace the trajectory before the browser paints the new ball target.
    // Keeping this in a normal effect leaves one frame where the ball has
    // started its new glide while the previous move's line is still visible.
    if (!liveBall || liveBall.idle || motionReduced || shotCueActive) {
      lastBallPointRef.current = null;
      prevBallMetaRef.current = null;
      setTrail(null);
      return;
    }
    const prev = lastBallPointRef.current;
    const prevMeta = prevBallMetaRef.current;
    const ballSide: PitchSide = ball?.side === 1 ? "away" : "home";
    lastBallPointRef.current = liveBall.point;
    prevBallMetaRef.current = { side: ballSide, zone: ball?.zone ?? "", carrierId: liveBall.carrierId, point: liveBall.point };
    if (!prev) {
      setTrail(null);
      return;
    }
    const dx = liveBall.point.x - prev.x;
    const dy = liveBall.point.y - prev.y;
    const significantMove = Math.abs(dx) >= 1.2 || Math.abs(dy) >= 1.2;
    // Tiny layout changes do not deserve a trajectory.
    if (!significantMove) {
      setTrail(null);
      return;
    }
    // Turnover intent: when the possessing side changed, add a dotted line
    // toward where the dispossessed move was heading before the solid
    // interception line to the new carrier.
    let intent: IntentLine | null = null;
    const action = ball?.lastBallAction;
    const attemptedAction = action?.action ?? ball?.lastAction;
    const attemptedZone = action?.fromZone ?? ball?.prevZone;
    if (prevMeta && attemptedAction && attemptedZone && prevMeta.side !== ballSide) {
      const lostPlayers = prevMeta.side === "home" ? home.players : away.players;
      const lostPoints = prevMeta.side === "home" ? homePoints : awayPoints;
      intent = turnoverIntent(prev, attemptedZone, prevMeta.side, attemptedAction, lostPlayers, lostPoints, action?.targetPlayerId ?? null);
    }
    trailSeqRef.current += 1;
    setTrail({ from: prev, to: liveBall.point, key: trailSeqRef.current, intent });
  }, [seq, liveBall, motionReduced, shotCueActive, ball, home.players, away.players, homePoints, awayPoints]);

  useEffect(() => {
    const fresh = pitchEvents.filter((event) => !seenRef.current.has(eventKey(event)));
    for (const event of fresh) seenRef.current.add(eventKey(event));
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const displayable = fresh.filter((event) => cueIsFresh(event, minute));
    if (displayable.length > 0) {
      setQueue((current) => [...current, ...displayable].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
    }
  }, [pitchEvents, minute]);

  useEffect(() => {
    if (activeEvent && !cueIsFresh(activeEvent, minute)) setActiveEvent(null);
    setQueue((current) => {
      const fresh = current.filter((event) => cueIsFresh(event, minute));
      return fresh.length === current.length ? current : fresh;
    });
  }, [activeEvent, minute]);

  useEffect(() => {
    if (activeEvent || queue.length === 0) return;
    if (cueIsFresh(queue[0], minute)) setActiveEvent(queue[0]);
    setQueue((current) => current.slice(1));
  }, [activeEvent, queue, minute]);

  useEffect(() => {
    if (!activeEvent) return;
    const timer = window.setTimeout(() => setActiveEvent(null), motionReduced ? 900 : 2300);
    return () => window.clearTimeout(timer);
  }, [activeEvent, motionReduced]);

  // Highlights, overlay and banner only live while the cue actively plays;
  // once it finishes the pitch falls back to the possession ball alone so no
  // stale glow/icon lingers on a player who no longer has the ball.
  const actorId = cueActive && cue ? cue.event.playerId : null;
  const secondaryId = cueActive && cue ? cue.event.player2Id : null;
  const homeHighlighted = actorId != null && home.players.some((player) => player.id === actorId) ? actorId : null;
  const awayHighlighted = actorId != null && away.players.some((player) => player.id === actorId) ? actorId : null;
  const homeSecondaryHighlighted = secondaryId != null && home.players.some((player) => player.id === secondaryId) ? secondaryId : null;
  const awaySecondaryHighlighted = secondaryId != null && away.players.some((player) => player.id === secondaryId) ? secondaryId : null;
  // The scripted sequence owns the ⚽ while it plays; otherwise the possession
  // ball renders normally (hidden under goal/miss cues which animate their own).
  const showLiveBall = (!!liveBall && !overlayBallActive) || !!seq;
  const ballRenderPoint = seq ? seq.point : liveBall?.point ?? BALL_CENTER_POINT;
  const liveBallClass = [
    "pitch-live-ball",
    !seq && liveBall?.idle ? "pitch-live-ball-idle" : "",
    !seq && !liveBall?.idle && ball && isSetPieceStart(ball.startType) ? "pitch-live-ball-setpiece" : "",
    !seq && !liveBall?.idle && ball?.counter && ball.phase === "TRANSITION" ? "pitch-live-ball-counter" : "",
    motionReduced ? "pitch-live-ball-reduced" : "",
    seq ? "pitch-live-ball-seq" : "",
    seq?.stage === "start" ? "pitch-live-ball-seq-start" : "",
  ].filter(Boolean).join(" ");

  return (
    <section className="match-pitch-card" aria-label="Live match pitch">
      <div className="match-pitch-head">
        <div>
          <div className="card-title">Live pitch</div>
        </div>
        <div className="match-pitch-teams">
          <span className="match-pitch-team">
            <FootballKit {...home.kit} size={34} flat />
            <span><b><ClubNameLink clubId={home.clubId} name={home.name} showCrest={false} /></b><small>{formationLabel(home.formationId)}{shortSuffix(homeMissing)}</small></span>
          </span>
          <span className="match-pitch-team">
            <FootballKit {...away.kit} size={34} flat />
            <span><b><ClubNameLink clubId={away.clubId} name={away.name} showCrest={false} /></b><small>{formationLabel(away.formationId)}{shortSuffix(awayMissing)}</small></span>
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
        {trail && !motionReduced && !shotCueActive && !seq && (
          <svg className="pitch-trail pitch-live-trail" viewBox="0 0 100 64" aria-hidden="true">
            {trail.intent && (
              <line
                className="pitch-trail-intent"
                pathLength={100}
                x1={trail.intent.from.x}
                y1={(trail.intent.from.y / 100) * 64}
                x2={trail.intent.to.x}
                y2={(trail.intent.to.y / 100) * 64}
              />
            )}
            <line key={trail.key} pathLength={100} x1={trail.from.x} y1={(trail.from.y / 100) * 64} x2={trail.to.x} y2={(trail.to.y / 100) * 64} />
          </svg>
        )}
        {seq && seq.stage !== "start" && !motionReduced && (
          <svg className="pitch-trail pitch-live-trail pitch-shot-trail" viewBox="0 0 100 64" aria-hidden="true">
            <line
              key={`${seq.key}-${seq.stage}`}
              pathLength={100}
              x1={seq.from.x}
              y1={(seq.from.y / 100) * 64}
              x2={seq.point.x}
              y2={(seq.point.y / 100) * 64}
            />
          </svg>
        )}
        {showLiveBall && (
          <span className={liveBallClass} style={{ left: `${ballRenderPoint.x}%`, top: `${ballRenderPoint.y}%` }} aria-hidden="true">⚽</span>
        )}
        {cueActive && cue && <CueOverlay cue={cue} active={cueActive} reducedMotion={motionReduced} />}
        <div className="pitch-players">
          {home.players.map((player) => <PlayerMarker key={`home-${player.id}`} player={player} point={homePoints.get(player.id) ?? { x: 50, y: 50 }} side="home" kit={player.tacPos === 1 ? home.gkKit : home.kit} highlighted={homeHighlighted === player.id || homeSecondaryHighlighted === player.id} />)}
          {away.players.map((player) => <PlayerMarker key={`away-${player.id}`} player={player} point={awayPoints.get(player.id) ?? { x: 50, y: 50 }} side="away" kit={player.tacPos === 1 ? away.gkKit : away.kit} highlighted={awayHighlighted === player.id || awaySecondaryHighlighted === player.id} />)}
          {homeMissing.map((entry) => <MissingMarker key={`home-missing-${entry.playerId}`} missing={entry} point={homeMissingPoints.get(entry.tacPos) ?? { x: 50, y: 50 }} kit={entry.tacPos === 1 ? home.gkKit : home.kit} />)}
          {awayMissing.map((entry) => <MissingMarker key={`away-missing-${entry.playerId}`} missing={entry} point={awayMissingPoints.get(entry.tacPos) ?? { x: 50, y: 50 }} kit={entry.tacPos === 1 ? away.gkKit : away.kit} />)}
        </div>
        {cue && activeEvent && BANNER_KINDS.has(cue.kind) && <div className="pitch-event-banner"><b>{EVENT_COPY[cue.kind]}</b><span>{cue.event.player || cue.event.player2}</span></div>}
      </div>
    </section>
  );
}
