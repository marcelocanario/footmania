import type { LiveBall, LiveEvent, LivePlayer } from "../api/client";

export interface PitchPoint {
  x: number;
  y: number;
}

export type PitchSide = "home" | "away";
/**
 * Pitch cue kinds for notable live moments. Neutral boundary events (coin
 * toss, half-time/second-half/full-time whistles, shootout announcement) map
 * to no cue at all — they have no pitch location to highlight.
 */
export type PitchCueKind = "goal" | "miss" | "yellow" | "red" | "injury" | "sub" | "corner" | "save" | "woodwork" | "shot-off" | "shot-blocked";

/** Event types (EVENT_CODES) that produce a pitch cue; everything else is neutral. */
const CUE_TYPES: Record<number, PitchCueKind> = {
  1: "goal",
  2: "yellow",
  3: "red",
  4: "red",
  5: "injury",
  6: "sub",
  7: "miss",
  14: "corner",
  15: "save",
  16: "woodwork",
  17: "shot-off",
  18: "shot-blocked",
};

/** Whether this event type ever produces a pitch cue at all. A parent showing
 * its own event feed alongside the pitch needs this to know which rows must
 * wait for MatchPitch's onEventRevealed instead of appearing immediately. */
export function hasPitchCue(type: number): boolean {
  return type in CUE_TYPES;
}

export interface PitchCue {
  kind: PitchCueKind;
  event: LiveEvent;
  side: PitchSide;
  actorSide: PitchSide;
  actorPoint: PitchPoint;
  secondaryPoint: PitchPoint | null;
  targetPoint: PitchPoint;
}

// Formation-aware placement. Each formation variant defines the vertical
// columns (lines) its slots occupy, so 4-2-3-1 draws a double pivot + CAM trio
// while 4-4-2 Diamond draws an actual diamond. Slots not listed fall back to
// their role band below.
interface FormationLine {
  x: number;
  slots: number[];
}

type FormationLayout = FormationLine[];

const FORMATION_LAYOUTS: Record<number, FormationLayout> = {
  0: [
    { x: 25, slots: [2, 9, 6, 4, 8] },
    { x: 45, slots: [11, 13, 14, 16] },
    { x: 68, slots: [20] },
  ],
  1: [
    { x: 25, slots: [2, 9, 6, 4, 8] },
    { x: 36, slots: [11, 14] },
    { x: 54, slots: [13, 16] },
    { x: 68, slots: [20] },
  ],
  2: [
    { x: 25, slots: [2, 9, 6, 4, 8] },
    { x: 45, slots: [12, 14, 16] },
    { x: 68, slots: [22, 24] },
  ],
  3: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 45, slots: [10, 11, 13, 15, 17] },
    { x: 68, slots: [23] },
  ],
  4: [
    { x: 25, slots: [2, 9, 3, 5] },
    { x: 45, slots: [11, 13, 14, 16] },
    { x: 68, slots: [22, 24] },
  ],
  5: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 36, slots: [11] },
    { x: 45, slots: [12, 13] },
    { x: 52, slots: [15] },
    { x: 68, slots: [19, 21] },
  ],
  6: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 42, slots: [12, 14, 16] },
    { x: 52, slots: [15] },
    { x: 68, slots: [22, 24] },
  ],
  7: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 45, slots: [12, 14, 16] },
    { x: 68, slots: [22, 23, 24] },
  ],
  8: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 38, slots: [11] },
    { x: 45, slots: [13, 15] },
    { x: 68, slots: [19, 20, 21] },
  ],
  9: [
    { x: 25, slots: [4, 6, 8] },
    { x: 45, slots: [10, 11, 13, 15, 17] },
    { x: 68, slots: [22, 24] },
  ],
  10: [
    { x: 25, slots: [4, 6, 8] },
    { x: 45, slots: [10, 11, 13, 17] },
    { x: 68, slots: [18, 23, 25] },
  ],
  11: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 38, slots: [11, 16] },
    { x: 50, slots: [13, 14, 15] },
    { x: 68, slots: [23] },
  ],
  12: [
    { x: 25, slots: [2, 9, 6, 8] },
    { x: 36, slots: [11, 13] },
    { x: 54, slots: [10, 15, 17] },
    { x: 70, slots: [20] },
  ],
};

/** Fallback column per role band for slots missing from the active layout. */
const FALLBACK_COLUMN_X: Record<number, number> = {
  1: 8,
  2: 25, 3: 25, 4: 25, 5: 25, 6: 25, 7: 25, 8: 25, 9: 25,
  10: 45, 11: 45, 12: 45, 13: 45, 14: 45, 15: 45, 16: 45, 17: 45,
  18: 68, 19: 68, 20: 68, 21: 68, 22: 68, 23: 68, 24: 68, 25: 68,
};

/** Tactical slot → role name, mirroring the backend's TACTICAL_POSITION_NAMES
 *  (game/constants.ts). Front-line codes (20/22/23/24) read as ST and the wide
 *  wing codes (19/21) as LW/RW — matching the role the pitch layout renders
 *  the slot at. NOTE: the same codes are reused as bench-slot markers
 *  (BENCH_ORDER) with the same meaning; this label is only correct for
 *  on-pitch players, not for bench rows (which should show the natural
 *  position instead). */
export function tacticalRoleLabel(tacPos: number): string {
  return (
    {
      1: "GK",
      2: "LB",
      3: "CB", 4: "CB", 5: "CB", 6: "RB", 7: "CB", 8: "CB", 9: "RB",
      10: "LM", 11: "CDM", 12: "CM", 13: "CM", 14: "CM", 15: "CAM", 16: "CM", 17: "RM",
      18: "ST", 19: "LW", 20: "ST", 21: "RW", 22: "ST", 23: "ST", 24: "ST", 25: "ST",
    } as Record<number, string>
  )[tacPos] ?? "PLAYER";
}

/** Outfielders are spread evenly between these vertical bounds. */
const SPREAD_TOP = 20;
const SPREAD_BOTTOM = 80;

/** Evenly spaced vertical position for the i-th of n players in a line.
 * Small lines sit closer to the center; only 3+ players stretch edge to edge. */
function spreadY(n: number, i: number): number {
  if (n === 1) return 50;
  if (n === 2) return 35 + i * 30; // 35, 65 - centered, not hugging the sides
  return Math.round(SPREAD_TOP + (i * (SPREAD_BOTTOM - SPREAD_TOP)) / (n - 1));
}

const TACTICS_SPREAD_LEFT = 18;
const TACTICS_SPREAD_RIGHT = 82;

function spreadX(n: number, i: number): number {
  if (n === 1) return 50;
  if (n === 2) return 35 + i * 30;
  return Math.round(TACTICS_SPREAD_LEFT + (i * (TACTICS_SPREAD_RIGHT - TACTICS_SPREAD_LEFT)) / (n - 1));
}

/**
 * Computes the on-pitch point for every player of one team. Players are placed
 * according to the active formation's layout (variant-aware) and spread evenly
 * within each line. Slots the layout does not mention fall back to their role
 * band.
 */
export function teamPitchPoints(players: LivePlayer[], side: PitchSide, formationId: number): Map<number, PitchPoint> {
  const points = new Map<number, PitchPoint>();
  const layout = FORMATION_LAYOUTS[formationId];

  const spread = (list: LivePlayer[], x: number) => {
    const sorted = [...list].sort((a, b) => a.tacPos - b.tacPos);
    const n = sorted.length;
    sorted.forEach((player, i) => {
      points.set(player.id, { x, y: spreadY(n, i) });
    });
  };

  // Collect every player that sits on the same mirrored column first, then
  // spread once. The previous implementation spread each layout line and each
  // fallback bucket independently; any fallback column that coincided with a
  // layout column (e.g. a defender whose tacPos wasn't in the active layout
  // but whose fallback column is the same x) was spread as a second n=2 group
  // at the identical y positions (35,65) as the layout's n=2 group, producing
  // two markers exactly on top of each other. The result looked like a
  // formation had only 2 defenders instead of 4, which is why a 4-4-2 could
  // appear as a 2-5-3. Merging per column fixes that and also keeps the
  // visual density correct for any custom lineup.
  const colMap = new Map<number, LivePlayer[]>();
  const handled = new Set<number>();
  if (layout) {
    for (const line of layout) {
      const x = side === "home" ? line.x : 100 - line.x;
      const list = line.slots
        .map((slot) => players.find((p) => p.tacPos === slot))
        .filter((p): p is LivePlayer => !!p);
      for (const p of list) handled.add(p.id);
      if (list.length === 0) continue;
      const arr = colMap.get(x) ?? [];
      arr.push(...list);
      colMap.set(x, arr);
    }
  }

  for (const player of players) {
    if (handled.has(player.id)) continue;
    const x = FALLBACK_COLUMN_X[player.tacPos] ?? 50;
    const col = side === "home" ? x : 100 - x;
    const arr = colMap.get(col) ?? [];
    arr.push(player);
    colMap.set(col, arr);
  }
  for (const [x, list] of colMap) {
    spread(list, x);
  }
  return points;
}

/** Minimum x-separation (pitch percentage units) kept between a home column
 * and an away column once mirrored into the same shared coordinate space.
 * Markers are ~8.5% of the pitch width (70px on an 820px surface), so a gap
 * of 7 still leaves them visually overlapping. 12 guarantees a clear lane
 * between the two teams' columns. */
const MIN_COLUMN_GAP = 12;

/**
 * Two independently-authored formations can put a line at nearly the same x
 * purely by chance once the away side's is mirrored (e.g. a 3-4-3's midfield
 * line at x=45 vs a 4-2-3-1 Wide line that mirrors to x=46) — rendering both
 * teams' markers on top of each other. Groups each side's points by their
 * (rounded) x column and nudges any home/away column pair closer than
 * MIN_COLUMN_GAP apart, splitting the correction so neither side moves more
 * than necessary. Mutates both maps in place.
 */
export function resolveColumnCollisions(homePoints: Map<number, PitchPoint>, awayPoints: Map<number, PitchPoint>): void {
  const groupByColumn = (points: Map<number, PitchPoint>) => {
    const groups = new Map<number, number[]>();
    for (const [id, p] of points) {
      const col = Math.round(p.x);
      const arr = groups.get(col) ?? [];
      arr.push(id);
      groups.set(col, arr);
    }
    return groups;
  };
  const homeGroups = groupByColumn(homePoints);
  const awayGroups = groupByColumn(awayPoints);
  for (const hx of homeGroups.keys()) {
    for (const ax of awayGroups.keys()) {
      const gap = ax - hx;
      if (Math.abs(gap) >= MIN_COLUMN_GAP) continue;
      const push = (MIN_COLUMN_GAP - Math.abs(gap)) / 2;
      const dir = gap >= 0 ? 1 : -1;
      for (const id of homeGroups.get(hx)!) {
        const p = homePoints.get(id)!;
        homePoints.set(id, { ...p, x: p.x - dir * push });
      }
      for (const id of awayGroups.get(ax)!) {
        const p = awayPoints.get(id)!;
        awayPoints.set(id, { ...p, x: p.x + dir * push });
      }
    }
  }
}

/**
 * Pitch points for formation slots that have no on-pitch player — used to
 * place missing-player ghost markers at the vacated tactical position. Keyed
 * by tacPos. Reuses the exact placement pipeline via synthetic entries so
 * ghosts sit where the player used to stand.
 */
export function slotPointsFor(tacPoss: number[], side: PitchSide, formationId: number): Map<number, PitchPoint> {
  const ghosts: LivePlayer[] = tacPoss.map((tacPos, index) => ({
    id: -(index + 1),
    name: "",
    position: 0,
    tacPos,
    overall: 0,
    energy: 0,
    injuryDays: 0,
    suspended: false,
  }));
  const placed = teamPitchPoints(ghosts, side, formationId);
  const out = new Map<number, PitchPoint>();
  for (const ghost of ghosts) {
    const point = placed.get(ghost.id);
    if (point) out.set(ghost.tacPos, point);
  }
  return out;
}

/**
 * Vertical pitch slot points for the tactics editor. Reuses the same
 * FORMATION_LAYOUTS but maps horizontal depth (x) to vertical depth (y =
 * 100 - x) so GK sits at the bottom and attackers at the top, and spreads
 * each line horizontally. Returns points in the same order as slotTacPos.
 */
export function slotPointsForFormation(formationId: number, slotTacPos: number[]): PitchPoint[] {
  const layout = FORMATION_LAYOUTS[formationId];
  const out: (PitchPoint | null)[] = new Array(slotTacPos.length).fill(null);
  const posToIndices = new Map<number, number[]>();
  slotTacPos.forEach((pos, idx) => {
    const arr = posToIndices.get(pos) ?? [];
    arr.push(idx);
    posToIndices.set(pos, arr);
  });
  const handledPos = new Set<number>();

  const placeLine = (tacPoss: number[], y: number) => {
    const entries: { idx: number; pos: number }[] = [];
    for (const pos of tacPoss) {
      const indices = posToIndices.get(pos);
      if (!indices) continue;
      for (const idx of indices) {
        if (out[idx] !== null) continue;
        entries.push({ idx, pos });
      }
    }
    entries.sort((a, b) => a.pos - b.pos);
    const n = entries.length;
    entries.forEach((e, i) => {
      out[e.idx] = { x: spreadX(n, i), y };
      handledPos.add(e.pos);
    });
  };

  if (layout) {
    for (const line of layout) {
      const y = 100 - line.x;
      placeLine(line.slots, y);
    }
  }

  const fallbackGroups = new Map<number, { idx: number; pos: number }[]>();
  slotTacPos.forEach((pos, idx) => {
    if (out[idx] !== null) return;
    if (handledPos.has(pos)) return;
    const fx = FALLBACK_COLUMN_X[pos] ?? 50;
    const y = 100 - fx;
    const arr = fallbackGroups.get(y) ?? [];
    arr.push({ idx, pos });
    fallbackGroups.set(y, arr);
  });
  for (const [y, arr] of fallbackGroups) {
    arr.sort((a, b) => a.pos - b.pos);
    arr.forEach((e, i) => {
      out[e.idx] = { x: spreadX(arr.length, i), y };
    });
  }
  return out.map((p) => p ?? { x: 50, y: 50 });
}

export function eventKey(event: LiveEvent): string {
  if (event.sequence !== undefined) return String(event.sequence);
  return [event.minute, event.addedTime ?? "", event.half, event.type, event.subtype, event.clubId, event.playerId ?? event.player, event.player2Id ?? event.player2].join(":");
}

function cueKind(event: LiveEvent): PitchCueKind | null {
  return CUE_TYPES[event.type] ?? null;
}

function pointForPlayer(playerId: number | null | undefined, players: LivePlayer[], remembered: Map<number, PitchPoint>): PitchPoint {
  const player = playerId === null || playerId === undefined ? undefined : players.find((p) => p.id === playerId);
  if (player) return remembered.get(player.id) ?? { x: 50, y: 50 };
  if (playerId !== null && playerId !== undefined) return remembered.get(playerId) ?? { x: 50, y: 50 };
  return { x: 50, y: 50 };
}

export function cueForEvent(event: LiveEvent, homeClubId: number, homePlayers: LivePlayer[], awayPlayers: LivePlayer[], remembered = new Map<number, PitchPoint>()): PitchCue | null {
  const kind = cueKind(event);
  if (!kind) return null;
  const side: PitchSide = event.clubId === homeClubId ? "home" : "away";
  const actorSide: PitchSide = event.subtype === 2 && event.playerId !== null && event.playerId !== undefined
    ? (homePlayers.some((player) => player.id === event.playerId) ? "home" : "away")
    : side;
  const players = actorSide === "home" ? homePlayers : awayPlayers;
  const actorPoint = pointForPlayer(event.playerId, players, remembered);
  const secondaryPoint = event.player2Id === null || event.player2Id === undefined ? null : pointForPlayer(event.player2Id, players, remembered);
  const targetPoint = kind === "goal" || kind === "miss" ? (side === "home" ? { x: 96, y: 50 } : { x: 4, y: 50 }) : actorPoint;
  return { kind, event, side, actorSide, actorPoint, secondaryPoint, targetPoint };
}

// ---------------------------------------------------------------------------
// Live possession ball
//
// The engine persists a deterministic presentation carrier alongside the
// team/zone state. Older snapshots can still fall back to the nearest
// formation-supporting player. Everything here is derived from persisted state
// so re-renders and reconnects never reposition the ball differently.
// ---------------------------------------------------------------------------

/** Zone anchor points for the home side (attacking left -> right). */
const BALL_ZONE_ANCHORS: Record<string, PitchPoint> = {
  DEF_WIDE: { x: 12, y: 20 },
  DEF_CENTRAL: { x: 14, y: 32 },
  MID_WIDE: { x: 44, y: 20 },
  MID_CENTRAL: { x: 48, y: 32 },
  ATT_WIDE: { x: 76, y: 20 },
  ATT_CENTRAL: { x: 80, y: 32 },
  BOX: { x: 90, y: 32 },
};

/** Mirror of the pitch centre used whenever play is stopped. */
export const BALL_CENTER_POINT: PitchPoint = { x: 50, y: 32 };

const SET_PIECE_STARTS = new Set(["CORNER", "FREE_KICK", "THROW_IN", "PENALTY", "GOAL_KICK"]);

export function isSetPieceStart(startType: string): boolean {
  return SET_PIECE_STARTS.has(startType);
}

function clampPitch(p: PitchPoint): PitchPoint {
  return { x: Math.max(3, Math.min(97, p.x)), y: Math.max(6, Math.min(58, p.y)) };
}

/** Anchor point of the ball zone for one side. */
export function pointForBall(side: PitchSide, zone: string): PitchPoint {
  const anchor = BALL_ZONE_ANCHORS[zone] ?? BALL_ZONE_ANCHORS.MID_CENTRAL;
  return side === "home" ? { ...anchor } : { x: 100 - anchor.x, y: anchor.y };
}

/** FNV-1a seeded micro-offset used to keep the ball beside, rather than on top
 * of, its carrier. The key must identify the carrier—not the match minute—so
 * a player standing still never appears to dribble in place. */
function jitterFor(key: string): PitchPoint {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 8) % 1000) / 1000;
  const b = ((h >>> 20) % 1000) / 1000;
  return { x: (a - 0.5) * 4, y: (b - 0.5) * 3 };
}

export interface BallPlacement {
  /** Visual carrier: nearest supporting outfield player (null when none). */
  carrierId: number | null;
  point: PitchPoint;
}

/**
 * Places the live ball for a possession snapshot. The ball rides the
 * simulator-selected carrier when present; old snapshots use the nearest
 * formation-supporting player. Its offset is stable for the selected player,
 * so a new minute cannot move the ball at the same feet.
 */
export function placeLiveBall(ball: LiveBall, players: LivePlayer[], points: Map<number, PitchPoint>): BallPlacement {
  const side: PitchSide = ball.side === 0 ? "home" : "away";
  const anchor = pointForBall(side, ball.zone);
  // Foot bias toward the goal this side attacks.
  const attackBias = side === "home" ? 1.7 : -1.7;
  const target = clampPitch({ x: anchor.x + attackBias, y: anchor.y });
  const visualPoint = (player: LivePlayer, point: PitchPoint): BallPlacement => {
    const offset = jitterFor(`carrier:${player.id}:${ball.side}`);
    return {
      carrierId: player.id,
      point: clampPitch({ x: point.x + offset.x * 0.6 + attackBias * 0.5, y: point.y + offset.y * 0.6 }),
    };
  };
  const direct = ball.carrierId == null
    ? null
    : players.find((player) => player.id === ball.carrierId && points.has(player.id));
  if (direct) return visualPoint(direct, points.get(direct.id)!);
  const candidates = players
    .filter((p) => p.tacPos !== 1 || ball.startType === "GOAL_KICK")
    .map((p) => ({ p, pt: points.get(p.id) }))
    .filter((c): c is { p: LivePlayer; pt: PitchPoint } => !!c.pt)
    .sort((a, b) => {
      const da = (a.pt.x - target.x) ** 2 + (a.pt.y - target.y) ** 2;
      const db = (b.pt.x - target.x) ** 2 + (b.pt.y - target.y) ** 2;
      if (da !== db) return da - db;
      if (a.p.tacPos !== b.p.tacPos) return a.p.tacPos - b.p.tacPos;
      return a.p.id - b.p.id;
    });
  const chosen = candidates[0] ?? null;
  if (!chosen) {
    const offset = jitterFor(`zone:${ball.zone}:${ball.side}`);
    return { carrierId: null, point: clampPitch({ x: target.x + offset.x, y: target.y + offset.y }) };
  }
  // Ride the carrier's spot, nudged toward the attacked goal.
  return visualPoint(chosen.p, chosen.pt);
}

// ---------------------------------------------------------------------------
// Turnover intent projection
//
// When possession flips sides the client draws a dotted "intent" line showing
// where the dispossessed move was heading before the solid interception line
// to the actual new carrier. Everything is derived from already-persisted
// ball fields (prevZone/lastAction) so reconnects never re-reroll the line.
// ---------------------------------------------------------------------------

/** Lane-preserving zone ladder from own goal to the box. */
const ZONE_LADDER_WIDE = ["DEF_WIDE", "MID_WIDE", "ATT_WIDE", "BOX"];
const ZONE_LADDER_CENTRAL = ["DEF_CENTRAL", "MID_CENTRAL", "ATT_CENTRAL", "BOX"];

/** The zone one step further toward goal along the same lane. */
export function nextZoneTowardAttack(zone: string): string {
  const ladder = zone.endsWith("WIDE") ? ZONE_LADDER_WIDE : ZONE_LADDER_CENTRAL;
  const i = ladder.indexOf(zone);
  if (i < 0 || i === ladder.length - 1) return zone;
  return ladder[i + 1];
}

export interface IntentLine {
  from: PitchPoint;
  to: PitchPoint;
}

// ---------------------------------------------------------------------------
// Trajectory styling
//
// Classifies the possession move that just landed so the pitch can draw a
// trail that actually looks like what happened (a curled cross, a blocked
// shot, a corner delivery) instead of every move being an identical gold
// line. Driven entirely by fields already on LiveBall — no engine changes.
// ---------------------------------------------------------------------------

export type MoveStyle = "pass" | "cross" | "shot-blocked" | "shot-miss" | "corner" | "foul";

/** Shot outcomes that ship with their own curated pitch cue: GOAL renders the
 *  goal/miss overlay tracer; SAVE/WOODWORK/SHOT_MISS/SHOT_BLOCKED drive the
 *  scripted ball sequence. The possession snapshot can land in the same commit
 *  batch as — or one commit ahead of — the event being dequeued into the
 *  active cue, so also drawing a live trajectory for these shots races the
 *  curated one and shows the same shot twice. */
const SHOT_OUTCOMES_WITH_CUE = new Set(["GOAL", "SAVE", "WOODWORK", "BLOCKED", "MISS"]);

/** Whether this ball snapshot's last action is a shot that carries its own
 *  curated cue animation (see SHOT_OUTCOMES_WITH_CUE). */
export function shotHasOwnCue(ball: LiveBall | null | undefined): boolean {
  const action = ball?.lastBallAction;
  return action?.action === "SHOT" && SHOT_OUTCOMES_WITH_CUE.has(action.outcome);
}

/** Classifies the move that produced the current ball snapshot. */
export function classifyMove(ball: LiveBall | null | undefined): MoveStyle {
  const action = ball?.lastBallAction;
  if (ball?.startType === "CORNER") return "corner";
  if (action?.outcome === "FOUL") return "foul";
  if (action?.action === "SHOT" && action.outcome === "BLOCKED") return "shot-blocked";
  if (action?.action === "SHOT" && action.outcome === "MISS") return "shot-miss";
  if (action?.action === "CROSS") return "cross";
  return "pass";
}

/** FNV-1a seeded +1/-1, used to pick a stable curve direction per action so a
 * replay/reconnect never flips which way a cross or wide shot bows. */
export function bendSignFor(key: string): 1 | -1 {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h & 1) === 0 ? 1 : -1;
}

/** Control point for a quadratic Bezier bowing perpendicular to the from→to
 * line by `bendUnits` (pitch percentage units; sign flips which side it bows
 * toward). */
export function curveControlPoint(from: PitchPoint, to: PitchPoint, bendUnits: number): PitchPoint {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  return { x: mx + px * bendUnits, y: my + py * bendUnits };
}

/**
 * Projects where a broken-down move was heading: the old side's continuation
 * anchor one zone further toward attack, snapped to the nearest supporting
 * teammate for passes/crosses (the plausible intended receiver).
 */
export function turnoverIntent(
  sourcePoint: PitchPoint,
  prevZone: string,
  prevSide: PitchSide,
  players: LivePlayer[],
  points: Map<number, PitchPoint>,
  targetPlayerId: number | null = null,
): IntentLine {
  const from = clampPitch(sourcePoint);
  const authoritativeTarget = targetPlayerId == null ? null : points.get(targetPlayerId);
  if (authoritativeTarget) return { from, to: clampPitch(authoritativeTarget) };
  const to = clampPitch(pointForBall(prevSide, nextZoneTowardAttack(prevZone)));
  // A carry/dribble/clearance has no "intended receiver" the way a pass does,
  // but a raw zone anchor with no player-snapping still reads as a stray line
  // to nowhere in particular (it can coincidentally land right next to the
  // goalkeeper for a deep zone). Snapping to the nearest actual teammate — a
  // real marker the eye can anchor to — reads better regardless of action,
  // even though a pass/cross's target is still the more meaningful of the two.
  const candidates = players
    .filter((p) => p.tacPos !== 1)
    .map((p) => ({ p, pt: points.get(p.id) }))
    .filter((c): c is { p: LivePlayer; pt: PitchPoint } => !!c.pt)
    .sort((a, b) => {
      const da = (a.pt.x - to.x) ** 2 + (a.pt.y - to.y) ** 2;
      const db = (b.pt.x - to.x) ** 2 + (b.pt.y - to.y) ** 2;
      if (da !== db) return da - db;
      if (a.p.tacPos !== b.p.tacPos) return a.p.tacPos - b.p.tacPos;
      return a.p.id - b.p.id;
    });
  const receiver = candidates[0];
  return receiver ? { from, to: clampPitch(receiver.pt) } : { from, to };
}
