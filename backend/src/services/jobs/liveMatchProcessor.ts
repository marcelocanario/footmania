import type { PrismaClient } from "@prisma/client";
import { advanceLiveMatches } from "../../game/world";
import { notifyMatchGoal } from "../notifications";
import { loadGlobalWorldMutable, persistLiveMatchState, persistWorld } from "../saveService";
import { withGlobalLease, withGlobalLock } from "../lock";
import { notifyFinishedMatches } from "../matchNotifications";
import { publishLiveMatchUpdates } from "../liveMatchEvents";
import { publishUserWorldEvent } from "../worldEvents";
import { diffLiveMatchAdvances, snapshotLiveMatches } from "../liveMatchDiff";

export async function liveMatchProcessor(prisma: PrismaClient): Promise<{ changed: boolean }> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
  if (!save) return { changed: false };
  const active = await prisma.liveMatch.findFirst({ where: { saveId: save.id }, select: { matchId: true } });
  if (!active) return { changed: false };

  return withGlobalLock(() => withGlobalLease(prisma, async () => {
    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded || loaded.world.liveMatches.length === 0) return { changed: false };
    const before = snapshotLiveMatches(loaded.world.liveMatches);

    const advancedAt = Date.now();
    const finished = advanceLiveMatches(loaded.world, advancedAt);
    const { updates, changedStates, goals } = diffLiveMatchAdvances(before, loaded.world.liveMatches, finished);

    if (finished.length > 0) {
      await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
    } else {
      for (const state of changedStates) {
        await persistLiveMatchState(prisma, loaded.save.id, loaded.save.id, state, loaded.world.rng.state, loaded.save.revision);
        loaded.save.revision += 1;
      }
    }

    for (const goal of goals) {
      try {
        // A goal in the finishing tick is detected after finalizeLiveMatch has
        // detached the live state; notifyMatchGoal falls back to the persisted
        // Match record so the push is not lost.
        await notifyMatchGoal(prisma, loaded.world, goal.matchId, goal.clubId, goal.minute);
      } catch {
        // Goal inbox notifications are best effort.
      }
    }

    // Goal notifications have an earlier occurredAt than full-time, so the
    // feed remains correctly ordered even though the final Match is persisted
    // and the goal is discovered from that same finishing tick.
    if (finished.length > 0) {
      const userEvents = await notifyFinishedMatches(prisma, loaded.world, finished, new Date(advancedAt));
      for (const item of userEvents) publishUserWorldEvent(item.userId, item.event);
    }

    publishLiveMatchUpdates(loaded.world, updates);
    return { changed: updates.length > 0 };
  }, new Date()));
}
