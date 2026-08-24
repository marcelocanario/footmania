/**
 * Ephemeral user-scoped events. Durable notifications remain in the database;
 * this bus only wakes connected clients and is intentionally a no-op offline.
 */
export interface UserWorldEvent {
  type: "liveMatchStarted" | "liveMatchEnded" | "invalidate" | "mpStatus" | "permissionsChanged" | "marketUpdated" | "dayAdvanced" | "worldReset";
  scope?: string;
  matchId?: number;
  marketType?: "TRANSFER" | "FREE_AGENT";
  listingId?: number;
  status?: string;
  currentPrice?: number;
  deadline?: number;
  bidderCount?: number;
  amILeading?: boolean;
}

type Publisher = (userId: number, event: UserWorldEvent) => void;

let publisher: Publisher | null = null;

/**
 * Connected-user registry supplied by the WebSocket layer so world-wide
 * broadcasts (e.g. the admin world reset) can reach every open socket even
 * though users no longer own clubs after the reset.
 */
let connectedUsersProvider: (() => Iterable<number>) | null = null;

export function registerWorldEventPublisher(next: Publisher | null): void {
  publisher = next;
}

export function registerConnectedUsersProvider(next: (() => Iterable<number>) | null): void {
  connectedUsersProvider = next;
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

/** Wake every connected client: the world they were playing in no longer exists. */
export function publishWorldReset(): void {
  const provider = connectedUsersProvider;
  if (!provider) return;
  try {
    publishWorldEventToUsers(provider(), { type: "worldReset" });
  } catch {
    // Best effort, like every other push.
  }
}
