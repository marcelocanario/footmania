import type { LiveMatchState, World } from "../game/types";

export interface LiveMatchUpdate {
  matchId: number;
  homeClubId: number;
  awayClubId: number;
  eventStart: number;
  phaseChanged: boolean;
  finished: boolean;
}

type Broadcaster = (world: World, updates: LiveMatchUpdate[]) => void;

let broadcaster: Broadcaster | null = null;

export function registerLiveMatchBroadcaster(next: Broadcaster | null): void {
  broadcaster = next;
}

export function publishLiveMatchUpdates(world: World, updates: LiveMatchUpdate[]): void {
  if (updates.length === 0) return;
  try {
    broadcaster?.(world, updates);
  } catch {
    // Live delivery is best effort and must never fail a persisted mutation.
  }
}

export function liveMatchClubIds(state: Pick<LiveMatchState, "homeClubId" | "awayClubId">): [number, number] {
  return [state.homeClubId, state.awayClubId];
}
