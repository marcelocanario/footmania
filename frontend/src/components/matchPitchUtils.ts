import type { LiveEvent, LivePlayer } from "../api/client";

export interface PitchPoint {
  x: number;
  y: number;
}

export type PitchSide = "home" | "away";
export type PitchCueKind = "goal" | "miss" | "yellow" | "red" | "injury" | "sub" | "assist";

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

export function eventKey(event: LiveEvent): string {
  if (event.sequence !== undefined) return String(event.sequence);
  return [event.minute, event.half, event.type, event.subtype, event.clubId, event.playerId ?? event.player, event.player2Id ?? event.player2].join(":");
}

function cueKind(event: LiveEvent): PitchCueKind {
  if (event.type === 1) return "goal";
  if (event.type === 2) return "yellow";
  if (event.type === 3 || event.type === 4) return "red";
  if (event.type === 5) return "injury";
  if (event.type === 6) return "sub";
  if (event.type === 7) return "miss";
  return "assist";
}

function pointForPlayer(playerId: number | null | undefined, players: LivePlayer[], remembered: Map<number, PitchPoint>): PitchPoint {
  const player = playerId === null || playerId === undefined ? undefined : players.find((p) => p.id === playerId);
  if (player) return remembered.get(player.id) ?? { x: 50, y: 50 };
  if (playerId !== null && playerId !== undefined) return remembered.get(playerId) ?? { x: 50, y: 50 };
  return { x: 50, y: 50 };
}

export function cueForEvent(event: LiveEvent, homeClubId: number, homePlayers: LivePlayer[], awayPlayers: LivePlayer[], remembered = new Map<number, PitchPoint>()): PitchCue {
  const side: PitchSide = event.clubId === homeClubId ? "home" : "away";
  const actorSide: PitchSide = event.subtype === 2 && event.playerId !== null && event.playerId !== undefined
    ? (homePlayers.some((player) => player.id === event.playerId) ? "home" : "away")
    : side;
  const players = actorSide === "home" ? homePlayers : awayPlayers;
  const actorPoint = pointForPlayer(event.playerId, players, remembered);
  const secondaryPoint = event.player2Id === null || event.player2Id === undefined ? null : pointForPlayer(event.player2Id, players, remembered);
  const kind = cueKind(event);
  const targetPoint = kind === "goal" || kind === "miss" ? (side === "home" ? { x: 96, y: 50 } : { x: 4, y: 50 }) : actorPoint;
  return { kind, event, side, actorSide, actorPoint, secondaryPoint, targetPoint };
}
