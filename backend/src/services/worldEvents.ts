/**
 * Ephemeral user-scoped events. Durable notifications remain in the database;
 * this bus only wakes connected clients and is intentionally a no-op offline.
 */
export interface UserWorldEvent {
  type: "liveMatchStarted" | "liveMatchEnded" | "invalidate" | "mpStatus" | "permissionsChanged";
  scope?: string;
  matchId?: number;
}

type Publisher = (userId: number, event: UserWorldEvent) => void;

let publisher: Publisher | null = null;

export function registerWorldEventPublisher(next: Publisher | null): void {
  publisher = next;
}

export function publishUserWorldEvent(userId: number, event: UserWorldEvent): void {
  try {
    publisher?.(userId, event);
  } catch {
    // WebSocket delivery is best effort and must never fail a game mutation.
  }
}

export function publishWorldEventToUsers(userIds: Iterable<number>, event: UserWorldEvent): void {
  for (const userId of userIds) publishUserWorldEvent(userId, event);
}
