import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import type { KitDesign, LiveBall, LiveEvent, LiveMissingPlayer, LivePlayer } from "../api/client";
import { FootballKit } from "./kit/FootballKit";
import { ClubNameLink } from "./ClubNameLink";
import { positionLabel } from "../positions";
import {
  BALL_CENTER_POINT,
  bendSignFor,
  classifyMove,
  cueForEvent,
  curveControlPoint,
  eventKey,
  hasPitchCue,
  isSetPieceStart,
  placeLiveBall,
  resolveColumnCollisions,
  shotHasOwnCue,
  teamPitchPointsFromSlots,
  turnoverIntent,
  type IntentLine,
  type MoveStyle,
  type PitchCue,
  type PitchPoint,
  type PitchSide,
} from "./matchPitchUtils";

interface PitchTeam {
  clubId: number;
  name: string;
  kit: KitDesign;
  /** Kit Lab GK design; the deployedRole==="GK" marker wears it (LiveState.homeGkKit/awayGkKit). */
  gkKit: KitDesign;
  players: LivePlayer[];
  formationId: number;
  /** Formation name from the live view — the backend catalog is the only
   *  formation-name authority (§16.1); the frontend keeps no second table. */
  formationName: string;
  formationSlots?: Array<{ x: number; y: number }>;
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
  /** Fired exactly once per event that carries a pitch cue (goal/card/save/…),
   * at the moment this component either starts animating it or gives up on
   * it for being stale — never earlier. A parent showing its own event feed
   * alongside the pitch should gate cue-eligible rows on this instead of
   * revealing them the instant they arrive, or the sidebar and the pitch
   * animation fall out of sync (see hasPitchCue in matchPitchUtils). */
  onEventRevealed?: (event: LiveEvent) => void;
  onPlayerClick?: (id: number, name: string) => void;
}

const EVENT_COPY: Record<string, string> = {
  goal: "pitch.goal",
  miss: "pitch.miss",
  yellow: "pitch.yellow",
  red: "pitch.red",
  injury: "pitch.injury",
  sub: "pitch.sub",
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
const EVENT_SHOT_MISS = 17;
const EVENT_SHOT_BLOCKED = 18;
// Loose enough to absorb a batched delta spanning a few simulated minutes
// (fast-forwarded play, a reconnect catch-up) without treating an event as
// stale before the pitch even had a chance to queue it — every event that
// misses this window still gets revealed to a synced sidebar immediately via
// onEventRevealed, just without an animation, so nothing goes missing either
// way; this only controls how often that fallback kicks in.
const CUE_MAX_AGE_MINUTES = 3;

function cueIsFresh(event: LiveEvent, displayMinute: number): boolean {
  return displayMinute - event.minute <= CUE_MAX_AGE_MINUTES;
}

/**
 * A scripted ball sequence that owns the ⚽ while it plays out: saves glide
 * shooter/carrier → GK, pause at the gloves, then distribute to the first
 * post-save carrier; woodwork hits kiss the frame; off-target shots fade out
 * wide of the frame; blocked shots deflect back into play off the defender.
 * Goals keep the dedicated CueOverlay animation into the net.
 */
interface BallSeq {
  key: number;
  kind: "save" | "woodwork" | "shot-off" | "shot-blocked";
  stage: "start" | "leg" | "hold" | "pass" | "rebound" | "fade";
  /** Origin of the currently displayed leg. */
  from: PitchPoint;
  /** Current rendered point (target of the active glide). */
  point: PitchPoint;
  /** Side that saved (ball recipient); null for woodwork. */
  gkSide: PitchSide | null;
}

/** Clamp a scratch point to the pitch's visible playing area. */
function clampToPitch(p: PitchPoint): PitchPoint {
  return { x: Math.max(3, Math.min(97, p.x)), y: Math.max(6, Math.min(58, p.y)) };
}

/** Renders a trail segment as a straight line, or a quadratic-Bezier path when
 * a curve control point is given (crosses, corner deliveries, wide shots). */
function TrailShape({ from, to, control, className, style }: { from: PitchPoint; to: PitchPoint; control?: PitchPoint | null; className?: string; style?: CSSProperties }) {
  const y1 = (from.y / 100) * 64;
  const y2 = (to.y / 100) * 64;
  if (control) {
    const cy = (control.y / 100) * 64;
    return <path className={className} style={style} pathLength={100} fill="none" d={`M ${from.x} ${y1} Q ${control.x} ${cy} ${to.x} ${y2}`} />;
  }
  return <line className={className} style={style} pathLength={100} x1={from.x} y1={y1} x2={to.x} y2={y2} />;
}

/** Quick deflection off the frame after a woodwork "kiss", back into play. */
const WOODWORK_REBOUND_MS = 350;

/** Distance-scaled possession glide: short lay-offs stay snappy, long
 * diagonal balls take proportionally longer instead of covering the whole
 * pitch in the same fixed window a 5-yard pass gets. Feeds both the ball's
 * CSS transition and the trail's draw animation via --ball-glide-ms so they
 * never fall out of step (see the sync notes on the trajectory effect). */
function glideDurationFor(distancePct: number): number {
  // Floor is intentionally low (not "snappy pass" territory) because this
  // also covers sub-trail-threshold jitter hops, which must resolve well
  // before the next snapshot lands or the ball is caught still creeping
  // toward them when the next real move needs to measure its position.
  return Math.max(500, Math.min(2200, 700 + distancePct * 11));
}

const PlayerMarker = memo(function PlayerMarker({ player, point, kit, highlighted, onPlayerClick }: { player: LivePlayer; point: PitchPoint; side: PitchSide; kit: PitchTeam["kit"]; highlighted: boolean; onPlayerClick?: (id: number, name: string) => void }) {
  const style = {
    left: `${point.x}%`,
    top: `${point.y}%`,
    "--kit": kit.primary,
    "--kit-2": kit.secondary,
  } as CSSProperties;
  const posLabel = positionLabel(player.naturalPosition) || i18n.t("pitch.playerFallback");
  return (
    <button
      type="button"
      className={`pitch-player${highlighted ? " pitch-player-highlight" : ""}${player.injuryDays > 0 ? " pitch-player-injured" : ""}`}
      style={style}
      aria-label={player.number != null ? `${player.number} ${player.name}` : player.name}
      title={player.number != null ? `${player.number} · ${player.name} · ${posLabel}` : `${player.name} · ${posLabel}`}
      onClick={() => onPlayerClick?.(player.id, player.name)}
    >
      <span className="pitch-player-kit" aria-hidden="true">
        <FootballKit {...kit} number={player.number ?? ""} size="100%" flat />
      </span>
      <span className="pitch-player-name">{player.name}</span>
    </button>
  );
});

const CueOverlay = memo(function CueOverlay({ cue, active, reducedMotion }: { cue: PitchCue; active: boolean; reducedMotion: boolean }) {
  const { actorPoint, targetPoint } = cue;
  const activeClass = reducedMotion ? " pitch-cue-reduced" : "";
  const ballEvent = cue.kind === "goal" || cue.kind === "miss";
  const actorY = (actorPoint.y / 100) * 64;
  const targetY = (targetPoint.y / 100) * 64;
  // A miss bows wide of/over the frame instead of flying straight at the same
  // spot a goal does — the curve itself reads as "off target" at a glance.
  // The bend direction is seeded from the event so it never flips on re-render.
  const control = cue.kind === "miss" ? curveControlPoint(actorPoint, targetPoint, 9 * bendSignFor(eventKey(cue.event))) : null;
  const controlY = control ? (control.y / 100) * 64 : 0;
  const pathD = control ? `M ${actorPoint.x} ${actorY} Q ${control.x} ${controlY} ${targetPoint.x} ${targetY}` : null;
  // animateMotion translates relative to the element's own static cx/cy, so
  // the motion path must start at the origin rather than at actorPoint too —
  // otherwise the offset applies twice and the ball flies off past the target.
  const motionPathD = control
    ? `M 0 0 Q ${control.x - actorPoint.x} ${controlY - actorY} ${targetPoint.x - actorPoint.x} ${targetY - actorY}`
    : null;
  return (
    <>
      {/* Ball layers only render while the cue plays out; afterwards the
          persistent possession ball takes over so the pitch never shows two
          balls (e.g. one frozen in the net plus the kickoff ball). */}
      {active && ballEvent && (
        <svg className="pitch-trail pitch-trail-shot" viewBox="0 0 100 64" aria-hidden="true">
          {pathD
            ? <path d={pathD} fill="none" />
            : <line x1={actorPoint.x} y1={actorY} x2={targetPoint.x} y2={targetY} />}
        </svg>
      )}
      {active && ballEvent && (
        <svg className={`pitch-ball-layer${cue.event.subtype === 3 || cue.event.subtype === 4 ? " pitch-ball-set-piece" : ""}${activeClass}`} viewBox="0 0 100 64" aria-hidden="true">
          <circle cx={actorPoint.x} cy={actorY} r="1.3" className="pitch-ball">
            {!reducedMotion && motionPathD && <animateMotion dur="0.9s" fill="freeze" path={motionPathD} />}
            {!reducedMotion && !pathD && <animate attributeName="cx" from={actorPoint.x} to={targetPoint.x} dur="0.9s" fill="freeze" />}
            {!reducedMotion && !pathD && <animate attributeName="cy" from={actorY} to={targetY} dur="0.9s" fill="freeze" />}
          </circle>
        </svg>
      )}
      {/* Net ripple: a couple of rings expanding from the goal mouth on the
          instant the ball would hit the net. */}
      {active && !reducedMotion && cue.kind === "goal" && (
        <svg className="pitch-goal-ripple" viewBox="0 0 100 64" aria-hidden="true">
          <circle cx={targetPoint.x} cy={targetY} r="1.5" className="pitch-goal-ripple-ring pitch-goal-ripple-ring-1" />
          <circle cx={targetPoint.x} cy={targetY} r="1.5" className="pitch-goal-ripple-ring pitch-goal-ripple-ring-2" />
        </svg>
      )}
      <span className={`pitch-cue-icon pitch-cue-${cue.kind}${activeClass}`} style={{ left: `${actorPoint.x}%`, top: `${actorPoint.y}%` }} aria-hidden="true">
        {cue.kind === "yellow" ? "🟨" : cue.kind === "red" ? "🟥" : cue.kind === "injury" ? "✚" : cue.kind === "sub" ? "↔" : cue.kind === "miss" ? "×" : cue.kind === "goal" ? "⚽" : cue.kind === "corner" ? "🚩" : cue.kind === "save" ? "🧤" : cue.kind === "shot-off" ? "↗" : cue.kind === "shot-blocked" ? "🛡️" : "💥"}
      </span>
    </>
  );
});

function MatchPitchImpl({ home, away, missing = [], events, phase, minute, reducedMotion = false, ball = null, onEventRevealed, onPlayerClick }: MatchPitchProps) {
  const { t } = useTranslation();
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

  // A delta can arrive just before a full roster refresh. Missing-player IDs
  // are still authoritative, so never draw a stale dismissed/injured marker.
  const missingIds = useMemo(() => new Set(missing.map((entry) => entry.playerId)), [missing]);
  const homePitchPlayers = useMemo(() => home.players.filter((player) => !missingIds.has(player.id)), [home.players, missingIds]);
  const awayPitchPlayers = useMemo(() => away.players.filter((player) => !missingIds.has(player.id)), [away.players, missingIds]);
  const players = useMemo(() => [...homePitchPlayers, ...awayPitchPlayers], [homePitchPlayers, awayPitchPlayers]);
  // Computed together (not as two independent memos) because two
  // independently-authored formations can otherwise place a home line and a
  // mirrored away line at nearly the same x purely by coincidence, rendering
  // both teams' markers on top of each other — resolveColumnCollisions nudges
  // any such pair apart, so it needs both sides' points at once.
  const { homePoints, awayPoints } = useMemo(() => {
    const home_ = teamPitchPointsFromSlots(homePitchPlayers, "home", home.formationSlots) ?? new Map();
    const away_ = teamPitchPointsFromSlots(awayPitchPlayers, "away", away.formationSlots) ?? new Map();
    resolveColumnCollisions(home_, away_);
    return { homePoints: home_, awayPoints: away_ };
  }, [homePitchPlayers, home.formationSlots, awayPitchPlayers, away.formationSlots]);
  // Keep the short-handed status in the team header without drawing a marker
  // for a player who has left the pitch.
  const homeMissing = useMemo(() => missing.filter((entry) => entry.side === 0), [missing]);
  const awayMissing = useMemo(() => missing.filter((entry) => entry.side === 1), [missing]);
  const shortSuffix = (sideMissing: LiveMissingPlayer[]) => {
    if (sideMissing.length === 0) return "";
    const icons = sideMissing.map((entry) => (entry.kind === "RED" ? "🟥" : "✚")).join("");
    return ` · ${icons} ${sideMissing.length === 1 ? t("pitch.manShort") : t("pitch.menShort", { count: sideMissing.length })}`;
  };
  useEffect(() => {
    for (const player of players) {
      const side: PitchSide = homePitchPlayers.some((p) => p.id === player.id) ? "home" : "away";
      const points = side === "home" ? homePoints : awayPoints;
      rememberedRef.current.set(player.id, points.get(player.id) ?? { x: 50, y: 50 });
    }
  }, [players, homePitchPlayers, homePoints, awayPoints]);

  // Boundary events (half-time, full-time, coin toss, shootout announcement)
  // have no pitch cue at all — queuing them anyway would occupy the "one cue
  // at a time" slot for a couple of seconds with nothing to show, needlessly
  // delaying the next real (goal/card/save/…) cue behind it.
  const pitchEvents = useMemo(() => events.filter((event) => hasPitchCue(event.type)), [events]);

  // The live cue comes solely from the actively playing event; between cues
  // nothing is highlighted so the possession ball stays the single focus.
  const cueActive = !!activeEvent && cueIsFresh(activeEvent, minute);
  const cue = cueActive && activeEvent ? cueForEvent(activeEvent, home.clubId, home.players, away.players, rememberedRef.current) : null;
  const overlayBallActive = cueActive && !!cue && (cue.kind === "goal" || cue.kind === "miss");
  const shotCueActive = cueActive && !!cue && (cue.kind === "goal" || cue.kind === "miss" || cue.kind === "save" || cue.kind === "woodwork" || cue.kind === "shot-off" || cue.kind === "shot-blocked");

  // Live possession ball: anchored to the possessing side's nearest supporting
  // player during play; parked at the centre spot whenever play is stopped.
  const liveBall = useMemo(() => {
    if (!ball) return null;
    if (!LIVE_PLAY_PHASES.has(phase)) {
      return { idle: true as const, carrierId: null, point: BALL_CENTER_POINT };
    }
    const homePossesses = ball.side === 0;
    const players = homePossesses ? homePitchPlayers : awayPitchPlayers;
    const points = homePossesses ? homePoints : awayPoints;
    return { idle: false as const, side: (homePossesses ? "home" : "away") as PitchSide, ...placeLiveBall(ball, players, points) };
  }, [ball, phase, homePitchPlayers, awayPitchPlayers, homePoints, awayPoints]);

  const lastBallPointRef = useRef<PitchPoint | null>(null);
  const trailSeqRef = useRef(0);
  const [trail, setTrail] = useState<{
    from: PitchPoint;
    to: PitchPoint;
    key: number;
    intent?: IntentLine | null;
    style: MoveStyle;
    /** Bezier control point for curved styles (cross/corner/wide shot); straight line otherwise. */
    control?: PitchPoint | null;
    /** Kit colors for a turnover: dispossessed side's intent line, new side's solid line. */
    intentColor?: string | null;
    solidColor?: string | null;
  } | null>(null);
  // A foul stops the ball dead rather than sending it anywhere, so it gets its
  // own "ping" marker at the spot instead of a from→to trail.
  const foulSeqRef = useRef(0);
  const foulSeenRef = useRef<string | null>(null);
  const [foulPing, setFoulPing] = useState<{ point: PitchPoint; key: number } | null>(null);
  // Distance-scaled glide duration shared by the ball's CSS transition and the
  // trail's draw animation via the --ball-glide-ms custom property.
  const [glideMs, setGlideMs] = useState(1800);
  // DOM refs used to sample the ball's true rendered position (not just the
  // last commanded target) so a new trail always starts where the ball
  // actually is, even if the previous glide was interrupted mid-flight.
  const pitchSurfaceRef = useRef<HTMLDivElement | null>(null);
  const ballElRef = useRef<HTMLSpanElement | null>(null);

  function measureBallPoint(): PitchPoint | null {
    const el = ballElRef.current;
    const surface = pitchSurfaceRef.current;
    if (!el || !surface) return null;
    const surfaceRect = surface.getBoundingClientRect();
    if (surfaceRect.width === 0 || surfaceRect.height === 0) return null;
    const ballRect = el.getBoundingClientRect();
    return {
      x: ((ballRect.left + ballRect.width / 2) - surfaceRect.left) / surfaceRect.width * 100,
      y: ((ballRect.top + ballRect.height / 2) - surfaceRect.top) / surfaceRect.height * 100,
    };
  }

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
    const kind = ev.type === EVENT_SAVE ? ("save" as const) : ev.type === EVENT_WOODWORK ? ("woodwork" as const) : ev.type === EVENT_SHOT_MISS ? ("shot-off" as const) : ev.type === EVENT_SHOT_BLOCKED ? ("shot-blocked" as const) : null;
    if (!kind) return;
    const cueInfo = cueForEvent(ev, home.clubId, home.players, away.players, rememberedRef.current);
    if (!cueInfo) return;
    // The suppressed possession ball must not spawn a trajectory of its own.
    const previousPoint = lastBallPointRef.current;
    lastBallPointRef.current = null;
    prevBallMetaRef.current = null;
    setTrail(null);
    const key = ++seqKeyRef.current;
    if (kind === "shot-off") {
      // The ball sails past the frame the attack was aiming at — wide of the
      // goal mouth, bowing one way or the other (seeded from the event so a
      // reconnect never flips which side). It fades out past the goal line
      // instead of arriving anywhere.
      const shotSign = bendSignFor(String(ev.sequence ?? ev.minute));
      const frameX = cueInfo.side === "home" ? 97 : 3;
      const wideY = shotSign > 0 ? 24 : 52;
      const shooter = cueInfo.actorPoint;
      beginShotLeg({ key, kind, stage: "start", from: shooter, point: shooter, gkSide: null }, { x: frameX, y: wideY }, () => {
        setSeq((current) => (current && current.key === key ? { ...current, stage: "hold" } : current));
        scheduleSeqTimer(() => {
          setSeq((current) => (current && current.key === key ? { ...current, stage: "fade", from: current.point, point: current.point } : current));
          // Seed the next trajectory from where the ball actually vanished
          // (wide of the frame), not from the shooter.
          scheduleSeqTimer(() => finishBallSeq({ x: frameX, y: wideY }), SEQ_HOLD_MS);
        }, SEQ_HOLD_MS);
      });
      return;
    }
    if (kind === "shot-blocked") {
      // The ball flies toward the blocker (secondary player), stops at his
      // feet for a beat, then deflects back into play off him.
      const shooter = cueInfo.actorPoint;
      const blocker = cueInfo.secondaryPoint ?? previousPoint ?? shooter;
      const deflectSign = bendSignFor(String(ev.sequence ?? ev.minute));
      const deflectOutward = cueInfo.side === "home" ? 1 : -1;
      const deflected = clampToPitch({ x: blocker.x + deflectOutward * 6, y: blocker.y + deflectSign * 8 });
      beginShotLeg({ key, kind, stage: "start", from: shooter, point: shooter, gkSide: null }, blocker, () => {
        setSeq((current) => (current && current.key === key ? { ...current, stage: "hold" } : current));
        scheduleSeqTimer(() => {
          setSeq((current) => (current && current.key === key ? { ...current, stage: "rebound", from: blocker, point: deflected } : current));
          scheduleSeqTimer(() => finishBallSeq(deflected), WOODWORK_REBOUND_MS);
        }, SEQ_HOLD_MS);
      });
      return;
    }
    if (kind === "woodwork") {
      // Kiss the frame beside the goal mouth the attack was aiming at.
      const frame = cueInfo.side === "home" ? { x: 95, y: 38 } : { x: 5, y: 38 };
      const shooter = cueInfo.actorPoint;
      // Deflect off the frame back into play instead of just freezing there.
      const reboundSign = bendSignFor(String(ev.sequence ?? ev.minute));
      const reboundInward = cueInfo.side === "home" ? -1 : 1;
      const rebound = clampToPitch({ x: frame.x + reboundInward * 6, y: frame.y + reboundSign * 8 });
      beginShotLeg({ key, kind, stage: "start", from: shooter, point: shooter, gkSide: null }, frame, () => {
        setSeq((current) => (current && current.key === key ? { ...current, stage: "hold" } : current));
        scheduleSeqTimer(() => {
          setSeq((current) => (current && current.key === key ? { ...current, stage: "rebound", from: frame, point: rebound } : current));
          scheduleSeqTimer(() => finishBallSeq(rebound), WOODWORK_REBOUND_MS);
        }, SEQ_HOLD_MS);
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
      setFoulPing(null);
      return;
    }
    // The ball's CSS transition can still be mid-flight when this snapshot
    // lands (long moves cover more ground in the same window, so they're the
    // ones most often caught in transit). lastBallPointRef only ever holds
    // the *commanded* target, which the ball may never have actually reached
    // before being retargeted — so measure where it visually is right now and
    // prefer that as the new trail's origin. This read happens before paint,
    // so it reports the pre-update animated position, not the new target.
    const hadPreviousMove = lastBallPointRef.current !== null;
    const prev = hadPreviousMove ? (measureBallPoint() ?? lastBallPointRef.current) : null;
    const prevMeta = prevBallMetaRef.current;
    const ballSide: PitchSide = ball?.side === 1 ? "away" : "home";
    lastBallPointRef.current = liveBall.point;
    prevBallMetaRef.current = { side: ballSide, zone: ball?.zone ?? "", carrierId: liveBall.carrierId, point: liveBall.point };

    const action = ball?.lastBallAction;
    const style = classifyMove(ball);
    const actionKey = action ? String(action.sequence) : null;

    // A foul stops the ball dead on the spot rather than sending it anywhere;
    // it gets its own ping instead of a from→to trail.
    if (style === "foul") {
      if (actionKey && foulSeenRef.current !== actionKey) {
        foulSeenRef.current = actionKey;
        foulSeqRef.current += 1;
        setFoulPing({ point: liveBall.point, key: foulSeqRef.current });
      }
      setTrail(null);
      return;
    }

    // Shots with their own curated cue (goal overlay, save/woodwork sequence)
    // must not also draw a live trajectory: this effect can run a commit ahead
    // of the event being dequeued into activeEvent, so the trail would paint a
    // stray duplicate tracer right before the real one takes over. The ball
    // position was already seeded above, so later moves still measure from it.
    if (shotHasOwnCue(ball)) {
      setTrail(null);
      return;
    }

    if (!prev) {
      setTrail(null);
      return;
    }
    const dx = liveBall.point.x - prev.x;
    const dy = liveBall.point.y - prev.y;
    const distance = Math.hypot(dx, dy);
    // Every hop retargets the ball's CSS transition, even ones too small to
    // draw a trail for — so the glide duration must be refreshed here too,
    // not only past the significant-move gate below. Otherwise a tiny hop
    // inherits whatever (possibly multi-second) duration the last long ball
    // set, the ball is still visibly crawling toward it when the *next* real
    // move lands, and measureBallPoint() (correctly) reports that stale
    // in-flight position — which can sit next to an earlier carrier entirely,
    // making the trail look like it started from a player who never had it.
    setGlideMs(glideDurationFor(distance));
    const significantMove = Math.abs(dx) >= 1.2 || Math.abs(dy) >= 1.2;
    // Tiny layout changes do not deserve a trajectory.
    if (!significantMove) {
      setTrail(null);
      return;
    }
    // Turnover intent: when the possessing side changed, add a dotted line
    // toward where the dispossessed move was heading before the solid
    // interception line to the new carrier. Color each leg by the kit of the
    // side it belongs to so a turnover reads at a glance without the score.
    let intent: IntentLine | null = null;
    let intentColor: string | null = null;
    let solidColor: string | null = null;
    const attemptedAction = action?.action ?? ball?.lastAction;
    const attemptedZone = action?.fromZone ?? ball?.prevZone;
    if (prevMeta && attemptedAction && attemptedZone && prevMeta.side !== ballSide) {
      const lostPlayers = prevMeta.side === "home" ? homePitchPlayers : awayPitchPlayers;
      const lostPoints = prevMeta.side === "home" ? homePoints : awayPoints;
      intent = turnoverIntent(prev, attemptedZone, prevMeta.side, lostPlayers, lostPoints, action?.targetPlayerId ?? null);
      intentColor = prevMeta.side === "home" ? home.kit.primary : away.kit.primary;
      solidColor = ballSide === "home" ? home.kit.primary : away.kit.primary;
    }
    // Curved styles (cross / corner delivery / wide shot) bow perpendicular to
    // the straight line; the bend direction is seeded from the action so it's
    // stable across re-renders instead of re-rolling every paint.
    let control: PitchPoint | null = null;
    if (style === "corner" || style === "cross" || style === "shot-miss") {
      const bendUnits = style === "shot-miss" ? 10 : style === "corner" ? 7 : 5;
      const seedKey = actionKey ?? `${prev.x.toFixed(1)},${prev.y.toFixed(1)}->${liveBall.point.x.toFixed(1)},${liveBall.point.y.toFixed(1)}`;
      control = curveControlPoint(prev, liveBall.point, bendUnits * bendSignFor(seedKey));
    }
    trailSeqRef.current += 1;
    setTrail({ from: prev, to: liveBall.point, key: trailSeqRef.current, intent, style, control, intentColor, solidColor });
  }, [seq, liveBall, motionReduced, shotCueActive, ball, homePitchPlayers, awayPitchPlayers, homePoints, awayPoints, home.kit.primary, away.kit.primary]);

  useEffect(() => {
    if (!foulPing) return;
    const timer = window.setTimeout(() => {
      setFoulPing((current) => (current && current.key === foulPing.key ? null : current));
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [foulPing]);

  useEffect(() => {
    const fresh = pitchEvents.filter((event) => !seenRef.current.has(eventKey(event)));
    for (const event of fresh) seenRef.current.add(eventKey(event));
    if (!mountedRef.current) {
      mountedRef.current = true;
      // The very first batch is the pre-mount backlog (initial load or a
      // reconnect catch-up) — it was never queued for animation at all, so a
      // parent's event feed must reveal it immediately too, or a mid-match
      // join would show an empty sidebar until the next new event arrives.
      fresh.forEach((event) => onEventRevealed?.(event));
      return;
    }
    const displayable = fresh.filter((event) => cueIsFresh(event, minute));
    // Anything too stale to enqueue (e.g. a batched delta spanning several
    // simulated minutes) still needs to be revealed — just without an
    // animation — so it can never go missing from a synced event feed.
    fresh.filter((event) => !cueIsFresh(event, minute)).forEach((event) => onEventRevealed?.(event));
    if (displayable.length > 0) {
      setQueue((current) => [...current, ...displayable].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
    }
  }, [pitchEvents, minute, onEventRevealed]);

  useEffect(() => {
    if (activeEvent && !cueIsFresh(activeEvent, minute)) setActiveEvent(null);
    setQueue((current) => {
      const fresh = current.filter((event) => cueIsFresh(event, minute));
      if (fresh.length !== current.length) {
        // Aged out while still waiting in line — reveal it now rather than
        // let it vanish from a synced feed with no pitch cue ever having run.
        current.filter((event) => !cueIsFresh(event, minute)).forEach((event) => onEventRevealed?.(event));
      }
      return fresh.length === current.length ? current : fresh;
    });
  }, [activeEvent, minute, onEventRevealed]);

  useEffect(() => {
    if (activeEvent || queue.length === 0) return;
    // Reveal exactly when the cue starts playing — this is the moment a
    // synced sidebar should show the row too, not whenever the event first
    // arrived over the wire.
    onEventRevealed?.(queue[0]);
    if (cueIsFresh(queue[0], minute)) setActiveEvent(queue[0]);
    setQueue((current) => current.slice(1));
  }, [activeEvent, queue, minute, onEventRevealed]);

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
  // Short-circuit to null up front while no cue is active: these four scans
  // only ever matter while a cue is playing.
  const homeHighlighted = !cueActive ? null : actorId != null && homePitchPlayers.some((player) => player.id === actorId) ? actorId : null;
  const awayHighlighted = !cueActive ? null : actorId != null && awayPitchPlayers.some((player) => player.id === actorId) ? actorId : null;
  const homeSecondaryHighlighted = !cueActive ? null : secondaryId != null && homePitchPlayers.some((player) => player.id === secondaryId) ? secondaryId : null;
  const awaySecondaryHighlighted = !cueActive ? null : secondaryId != null && awayPitchPlayers.some((player) => player.id === secondaryId) ? secondaryId : null;
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
    seq?.stage === "rebound" ? "pitch-live-ball-seq-rebound" : "",
    seq?.stage === "fade" ? "pitch-live-ball-seq-fade" : "",
  ].filter(Boolean).join(" ");
  const surfaceStyle = { "--ball-glide-ms": `${glideMs}ms` } as CSSProperties;

  return (
    <section className="match-pitch-card" aria-label={t("pitch.pitchAria")}>
      <div className="match-pitch-head">
        <div>
          <div className="card-title">{t("pitch.live")}</div>
        </div>
        <div className="match-pitch-teams">
          <span className="match-pitch-team">
            <FootballKit {...home.kit} size={34} flat />
            <span><b><ClubNameLink clubId={home.clubId} name={home.name} showCrest={false} /></b><small>{home.formationName}{shortSuffix(homeMissing)}</small></span>
          </span>
          <span className="match-pitch-team">
            <FootballKit {...away.kit} size={34} flat />
            <span><b><ClubNameLink clubId={away.clubId} name={away.name} showCrest={false} /></b><small>{away.formationName}{shortSuffix(awayMissing)}</small></span>
          </span>
        </div>
      </div>
      <div ref={pitchSurfaceRef} style={surfaceStyle} className={`pitch-surface${cue && activeEvent ? ` pitch-${cue.kind}-active` : ""}${motionReduced ? " pitch-reduced-motion" : ""}`}>
        <svg className="pitch-lines" viewBox="0 0 100 64" role="img" aria-label={t("pitch.formationsAria", { home: home.name, away: away.name })}>
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
          <svg className={`pitch-trail pitch-live-trail pitch-trail-${trail.style}`} viewBox="0 0 100 64" aria-hidden="true">
            {trail.intent && (
              <line
                className="pitch-trail-intent"
                pathLength={100}
                x1={trail.intent.from.x}
                y1={(trail.intent.from.y / 100) * 64}
                x2={trail.intent.to.x}
                y2={(trail.intent.to.y / 100) * 64}
                style={trail.intentColor ? { stroke: trail.intentColor } : undefined}
              />
            )}
            {/* Counter-attack "comet": faint offset echoes of the same shape,
                staggered to suggest speed behind the lead line. */}
            {ball?.counter && ball.phase === "TRANSITION" && (
              <>
                <TrailShape from={trail.from} to={trail.to} control={trail.control} className="pitch-trail-comet pitch-trail-comet-2" />
                <TrailShape from={trail.from} to={trail.to} control={trail.control} className="pitch-trail-comet pitch-trail-comet-1" />
              </>
            )}
            <TrailShape
              key={trail.key}
              from={trail.from}
              to={trail.to}
              control={trail.control}
              style={trail.solidColor ? { stroke: trail.solidColor } : undefined}
            />
          </svg>
        )}
        {seq && seq.stage !== "start" && seq.stage !== "fade" && !motionReduced && (
          <svg className={`pitch-trail pitch-live-trail pitch-shot-trail${seq.stage === "leg" || seq.stage === "hold" ? " pitch-shot-trail-danger" : ""}${seq.stage === "rebound" ? " pitch-shot-trail-rebound" : ""}`} viewBox="0 0 100 64" aria-hidden="true">
            <line
              // "hold" keeps the leg's exact geometry, so it must reuse the
              // same element: keying by stage remounts the line at the hold,
              // restarting pitchTrajectoryDraw and visibly redrawing the
              // shooter→target tracer a second time while the ball pauses.
              key={`${seq.key}-${seq.stage === "hold" ? "leg" : seq.stage}`}
              pathLength={100}
              x1={seq.from.x}
              y1={(seq.from.y / 100) * 64}
              x2={seq.point.x}
              y2={(seq.point.y / 100) * 64}
            />
          </svg>
        )}
        {foulPing && !motionReduced && (
          <svg className="pitch-foul-ping" viewBox="0 0 100 64" aria-hidden="true">
            <circle key={foulPing.key} cx={foulPing.point.x} cy={(foulPing.point.y / 100) * 64} r="1.6" />
          </svg>
        )}
        {showLiveBall && (
          <span ref={ballElRef} className={liveBallClass} style={{ left: `${ballRenderPoint.x}%`, top: `${ballRenderPoint.y}%` }} aria-hidden="true">⚽</span>
        )}
        {cueActive && cue && <CueOverlay cue={cue} active={cueActive} reducedMotion={motionReduced} />}
        <div className="pitch-players">
          {homePitchPlayers.map((player) => <PlayerMarker key={`home-${player.id}`} player={player} point={homePoints.get(player.id) ?? { x: 50, y: 50 }} side="home" kit={player.deployedRole === "GK" ? home.gkKit : home.kit} highlighted={homeHighlighted === player.id || homeSecondaryHighlighted === player.id} onPlayerClick={onPlayerClick} />)}
          {awayPitchPlayers.map((player) => <PlayerMarker key={`away-${player.id}`} player={player} point={awayPoints.get(player.id) ?? { x: 50, y: 50 }} side="away" kit={player.deployedRole === "GK" ? away.gkKit : away.kit} highlighted={awayHighlighted === player.id || awaySecondaryHighlighted === player.id} onPlayerClick={onPlayerClick} />)}
        </div>
        {cue && activeEvent && BANNER_KINDS.has(cue.kind) && <div className="pitch-event-banner"><b>{(t as unknown as (k: string) => string)(EVENT_COPY[cue.kind])}</b><span>{cue.event.player || cue.event.player2}</span></div>}
      </div>
    </section>
  );
}

export const MatchPitch = memo(MatchPitchImpl);
