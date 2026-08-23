import type { Match, World } from "../game/types";
import { notifyMatchFinished } from "./notifications";
import type { PrismaClient } from "@prisma/client";
import type { UserWorldEvent } from "./worldEvents";

export async function notifyFinishedMatches(
  prisma: PrismaClient,
  world: World,
  matches: Match[],
  occurredAt = new Date(),
): Promise<{ userId: number; event: UserWorldEvent }[]> {
  const userEvents: { userId: number; event: UserWorldEvent }[] = [];
  for (const match of matches) {
    try {
      await notifyMatchFinished(prisma, world, match, occurredAt);
    } catch {
      // Inbox notifications are best effort; the match result remains durable.
    }
    for (const clubId of [match.homeClubId, match.awayClubId]) {
      const ownerUserId = world.clubs.find((club) => club.id === clubId)?.ownerUserId;
      if (ownerUserId !== null && ownerUserId !== undefined) {
        userEvents.push({ userId: ownerUserId, event: { type: "liveMatchEnded", matchId: match.id } });
      }
    }
  }
  return userEvents;
}
