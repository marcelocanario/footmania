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

const POSITION_POINTS: Record<number, PitchPoint> = {
  1: { x: 8, y: 50 }, 2: { x: 25, y: 18 }, 3: { x: 25, y: 35 }, 4: { x: 25, y: 50 },
  5: { x: 25, y: 65 }, 6: { x: 25, y: 82 }, 7: { x: 25, y: 30 }, 8: { x: 25, y: 70 },
  9: { x: 25, y: 82 }, 10: { x: 45, y: 18 }, 11: { x: 45, y: 32 }, 12: { x: 45, y: 45 },
  13: { x: 45, y: 55 }, 14: { x: 45, y: 68 }, 15: { x: 45, y: 50 }, 16: { x: 45, y: 78 },
  17: { x: 45, y: 82 }, 18: { x: 70, y: 50 }, 19: { x: 67, y: 22 }, 20: { x: 67, y: 22 },
  21: { x: 67, y: 38 }, 22: { x: 67, y: 50 }, 23: { x: 67, y: 62 }, 24: { x: 67, y: 72 },
  25: { x: 70, y: 50 },
};

export function pitchPoint(tacPos: number, side: PitchSide): PitchPoint {
  const point = POSITION_POINTS[tacPos] ?? { x: 50, y: 50 };
  return side === "home" ? point : { x: 100 - point.x, y: point.y };
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

function pointForPlayer(playerId: number | null | undefined, players: LivePlayer[], side: PitchSide, remembered: Map<number, PitchPoint>): PitchPoint {
  const player = playerId === null || playerId === undefined ? undefined : players.find((p) => p.id === playerId);
  if (player) return pitchPoint(player.tacPos, side);
  if (playerId !== null && playerId !== undefined) return remembered.get(playerId) ?? { x: 50, y: 50 };
  return { x: 50, y: 50 };
}

export function cueForEvent(event: LiveEvent, homeClubId: number, homePlayers: LivePlayer[], awayPlayers: LivePlayer[], remembered = new Map<number, PitchPoint>()): PitchCue {
  const side: PitchSide = event.clubId === homeClubId ? "home" : "away";
  const actorSide: PitchSide = event.subtype === 2 && event.playerId !== null && event.playerId !== undefined
    ? (homePlayers.some((player) => player.id === event.playerId) ? "home" : "away")
    : side;
  const players = actorSide === "home" ? homePlayers : awayPlayers;
  const actorPoint = pointForPlayer(event.playerId, players, actorSide, remembered);
  const secondaryPoint = event.player2Id === null || event.player2Id === undefined ? null : pointForPlayer(event.player2Id, players, actorSide, remembered);
  const kind = cueKind(event);
  const targetPoint = kind === "goal" || kind === "miss" ? (side === "home" ? { x: 96, y: 50 } : { x: 4, y: 50 }) : actorPoint;
  return { kind, event, side, actorSide, actorPoint, secondaryPoint, targetPoint };
}
