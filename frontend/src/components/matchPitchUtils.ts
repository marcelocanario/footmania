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
export type PitchCueKind = "goal" | "miss" | "yellow" | "red" | "injury" | "sub" | "corner" | "save" | "woodwork";

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
};

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

  const handled = new Set<number>();
  if (layout) {
    for (const line of layout) {
      const x = side === "home" ? line.x : 100 - line.x;
      const list = line.slots
        .map((slot) => players.find((p) => p.tacPos === slot))
        .filter((p): p is LivePlayer => !!p);
      for (const p of list) handled.add(p.id);
      spread(list, x);
    }
  }

  const fallback = new Map<number, LivePlayer[]>();
  for (const player of players) {
    if (handled.has(player.id)) continue;
    const x = FALLBACK_COLUMN_X[player.tacPos] ?? 50;
    const col = side === "home" ? x : 100 - x;
    const list = fallback.get(col) ?? [];
    list.push(player);
    fallback.set(col, list);
  }
  for (const [x, list] of fallback) {
    spread(list, x);
  }
  return points;
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
// The engine models possession at team/zone level (no individual carrier), so
// the client anchors the ball to the possessing-side player whose formation
// point best supports the ball zone. Everything here is deterministic from
// already-persisted state (side/zone/startType + minute) so re-renders and
// reconnects never reposition the ball differently.
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

/** FNV-1a seeded micro-jitter so consecutive minutes in the same zone still
 * nudge without ever rerolling between renders. */
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
 * Places the live ball for a possession snapshot. The ball rides the carrier's
 * marker with a small bias toward the attacked goal; deterministic per
 * (minute, zone, side).
 */
export function placeLiveBall(ball: LiveBall, minute: number, players: LivePlayer[], points: Map<number, PitchPoint>): BallPlacement {
  const side: PitchSide = ball.side === 0 ? "home" : "away";
  const anchor = pointForBall(side, ball.zone);
  const jitter = jitterFor(`${minute}:${ball.zone}:${ball.side}`);
  // Foot bias toward the goal this side attacks.
  const attackBias = side === "home" ? 1.7 : -1.7;
  const target = clampPitch({ x: anchor.x + jitter.x + attackBias, y: anchor.y + jitter.y });
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
  if (!chosen) return { carrierId: null, point: target };
  // Ride the carrier's spot, nudged toward the attacked goal.
  return {
    carrierId: chosen.p.id,
    point: clampPitch({ x: chosen.pt.x + jitter.x * 0.6 + attackBias * 0.5, y: chosen.pt.y + jitter.y * 0.6 }),
  };
}
