import type { PrismaClient } from "@prisma/client";
import { advanceLiveMatches } from "../../game/world";
import { livePhase } from "../../game/match";
import { EVENT_CODES } from "../../game/constants";
import { notifyMatchGoal } from "../notifications";
import { loadGlobalWorldMutable, persistLiveMatchState, persistWorld } from "../saveService";
import { withGlobalLease, withGlobalLock } from "../lock";
import { notifyFinishedMatches } from "../matchNotifications";
import { publishLiveMatchUpdates, type LiveMatchUpdate } from "../liveMatchEvents";
import { publishUserWorldEvent } from "../worldEvents";

interface MatchBeforeState {
  eventCount: number;
  phase: string;
  minute: number;
  score: [number, number];
  lastAdvancedAt: number;
  halftimeStartedAt: number | null | undefined;
}

export async function liveMatchProcessor(prisma: PrismaClient): Promise<{ changed: boolean }> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
  if (!save) return { changed: false };
  const active = await prisma.liveMatch.findFirst({ where: { saveId: save.id }, select: { matchId: true } });
  if (!active) return { changed: false };

  return withGlobalLock(() => withGlobalLease(prisma, async () => {
    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded || loaded.world.liveMatches.length === 0) return { changed: false };
    const before = new Map<number, MatchBeforeState>();
    for (const state of loaded.world.liveMatches) {
      before.set(state.matchId, {
        eventCount: state.events.length,
        phase: livePhase(state),
        minute: state.minute,
        score: [...state.scores] as [number, number],
        lastAdvancedAt: state.lastAdvancedAt,
        halftimeStartedAt: state.halftimeStartedAt,
      });
    }

    const finished = advanceLiveMatches(loaded.world, Date.now());
    const updates: LiveMatchUpdate[] = [];
    const changedStates: import("../../game/types").LiveMatchState[] = [];
    const goals: { matchId: number; clubId: number; minute: number }[] = [];
    for (const [matchId, previous] of before) {
      const state = loaded.world.liveMatches.find((candidate) => candidate.matchId === matchId);
      if (!state) {
        const match = finished.find((candidate) => candidate.id === matchId);
        if (match) updates.push({ matchId, homeClubId: match.homeClubId, awayClubId: match.awayClubId, eventStart: previous.eventCount, phaseChanged: true, finished: true });
        continue;
      }
      const phase = livePhase(state);
      const changed = state.events.length !== previous.eventCount
        || phase !== previous.phase
        || state.minute !== previous.minute
        || state.scores[0] !== previous.score[0]
        || state.scores[1] !== previous.score[1]
        || state.lastAdvancedAt !== previous.lastAdvancedAt
        || state.halftimeStartedAt !== previous.halftimeStartedAt;
      if (!changed) continue;
      changedStates.push(state);
      updates.push({
        matchId,
        homeClubId: state.homeClubId,
        awayClubId: state.awayClubId,
        eventStart: previous.eventCount,
        phaseChanged: phase !== previous.phase,
        finished: false,
      });
      for (const event of state.events.slice(previous.eventCount)) {
        if (event.type === EVENT_CODES.GOAL) goals.push({ matchId: state.matchId, clubId: event.clubId, minute: event.minute });
      }
    }

    if (finished.length > 0) {
      await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      const userEvents = await notifyFinishedMatches(prisma, loaded.world, finished);
      for (const item of userEvents) publishUserWorldEvent(item.userId, item.event);
    } else {
      for (const state of changedStates) {
        await persistLiveMatchState(prisma, loaded.save.id, loaded.save.id, state, loaded.world.rng.state, loaded.save.revision);
        loaded.save.revision += 1;
      }
    }

    for (const goal of goals) {
      try {
        await notifyMatchGoal(prisma, loaded.world, goal.matchId, goal.clubId, goal.minute);
      } catch {
        // Goal inbox notifications are best effort.
      }
    }

    publishLiveMatchUpdates(loaded.world, updates);
    return { changed: updates.length > 0 };
  }, new Date()));
}
