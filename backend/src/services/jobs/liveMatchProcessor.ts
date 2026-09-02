import type { PrismaClient } from "@prisma/client";
import { advanceLiveMatches } from "../../game/world";
import { notifyMatchGoal } from "../notifications";
import { loadGlobalWorldMutable, loadGlobalWorldMutableForLiveTick, persistLiveMatchState, persistWorld } from "../saveService";
import { withGlobalLease, withGlobalLock } from "../lock";
import { notifyFinishedMatches } from "../matchNotifications";
import { publishLiveMatchUpdates } from "../liveMatchEvents";
import { publishUserWorldEvent } from "../worldEvents";
import { diffLiveMatchAdvances, snapshotLiveMatches } from "../liveMatchDiff";
import { isWorldPausedGlobally, isPaused } from "../seasonPause";
import { loadPresetsForClubs } from "../automationPresetService";
import type { World } from "../../game/types";

/** Every club id involved in at least one currently-live match — the only
 *  clubs whose automation presets this tick could possibly need (plan §11
 *  Part 4: presets are loaded on demand, never held for every club). */
function liveMatchClubIds(world: World): number[] {
  const ids = new Set<number>();
  for (const st of world.liveMatches) {
    ids.add(st.homeClubId);
    ids.add(st.awayClubId);
  }
  return [...ids];
}

export async function liveMatchProcessor(prisma: PrismaClient): Promise<{ changed: boolean }> {
  // Season pause: matches are frozen mid-state and must not tick.
  if (await isWorldPausedGlobally(prisma)) return { changed: false };
  const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
  if (!save) return { changed: false };
  const active = await prisma.liveMatch.findFirst({ where: { saveId: save.id }, select: { matchId: true } });
  if (!active) return { changed: false };

  return withGlobalLock(() => withGlobalLease(prisma, async () => {
    const advancedAt = Date.now();
    // Fast path: skip the whole-world clone (dominated by `players`, which
    // can be orders of magnitude larger than the couple of clubs actually
    // playing) when no live match could possibly finish this tick.
    // loadGlobalWorldMutableForLiveTick returns null whenever there's genuine
    // doubt, falling back to the full clone below. And even after taking the
    // narrow path, if a match unexpectedly finishes anyway, the narrow
    // world's players/clubs are insufficient for finalizeLiveMatch's full
    // write (standings, ratings, Elo, news, ...) -- discard it (nothing has
    // been persisted yet) and redo the tick, deterministically, on a freshly
    // loaded full world. Bounded at two attempts: the second always uses the
    // full path, which can never hit this retry condition again.
    let loaded = await loadGlobalWorldMutableForLiveTick(prisma, advancedAt);
    let usedNarrowPath = loaded !== null;
    let before: ReturnType<typeof snapshotLiveMatches> | undefined;
    let finished: ReturnType<typeof advanceLiveMatches> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!loaded) loaded = await loadGlobalWorldMutable(prisma);
      if (!loaded || loaded.world.liveMatches.length === 0) return { changed: false };
      // Belt-and-braces inside the lock: another process may have paused
      // between the cheap pre-check above and this load.
      if (isPaused(loaded.world)) return { changed: false };
      before = snapshotLiveMatches(loaded.world.liveMatches);
      const automationPresets = await loadPresetsForClubs(prisma, loaded.save.id, liveMatchClubIds(loaded.world));
      finished = advanceLiveMatches(loaded.world, advancedAt, { automationPresets });
      if (usedNarrowPath && finished.length > 0) {
        loaded = null;
        usedNarrowPath = false;
        continue;
      }
      break;
    }
    if (!loaded || !before || !finished) return { changed: false };
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
