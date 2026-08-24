import type { LiveMatchState, Match } from "../game/types";
import { livePhase } from "../game/match";
import { EVENT_CODES } from "../game/constants";
import type { LiveMatchUpdate } from "./liveMatchEvents";

/**
 * Pre-advance snapshot of one live match. The state is kept as an object
 * reference, not a copy: advanceLiveMatches mutates this same object and
 * finalizeLiveMatch then detaches it from world.liveMatches, so events
 * appended in the finishing tick (e.g. a stoppage-time goal) remain readable
 * through this reference after the advance.
 */
export interface LiveMatchSnapshot {
  state: LiveMatchState;
  eventCount: number;
  phase: string;
  minute: number;
  score: [number, number];
  lastAdvancedAt: number;
  halftimeStartedAt: number | null | undefined;
}

export interface LiveMatchGoal {
  matchId: number;
  clubId: number;
  minute: number;
}

export interface LiveMatchAdvanceDiff {
  updates: LiveMatchUpdate[];
  changedStates: LiveMatchState[];
  goals: LiveMatchGoal[];
}

/** Capture what every in-progress live match looked like before an advance. */
export function snapshotLiveMatches(liveMatches: LiveMatchState[]): Map<number, LiveMatchSnapshot> {
  const before = new Map<number, LiveMatchSnapshot>();
  for (const state of liveMatches) {
    before.set(state.matchId, {
      state,
      eventCount: state.events.length,
      phase: livePhase(state),
      minute: state.minute,
      score: [...state.scores] as [number, number],
      lastAdvancedAt: state.lastAdvancedAt,
      halftimeStartedAt: state.halftimeStartedAt,
    });
  }
  return before;
}

/** Collect goals scored after `eventStart`, whether or not the state is still attached. */
function collectGoals(matchId: number, state: LiveMatchState, eventStart: number, goals: LiveMatchGoal[]): void {
  for (const event of state.events.slice(eventStart)) {
    if (event.type === EVENT_CODES.GOAL) goals.push({ matchId, clubId: event.clubId, minute: event.minute });
  }
}

/**
 * Pure diff between pre-advance snapshots and the post-advance world. Matches
 * that vanished from liveMatches were finalized; their final-tick events must
 * still produce goal notifications even though the state is detached.
 */
export function diffLiveMatchAdvances(
  before: Map<number, LiveMatchSnapshot>,
  liveMatchesNow: LiveMatchState[],
  finished: Match[],
): LiveMatchAdvanceDiff {
  const updates: LiveMatchUpdate[] = [];
  const changedStates: LiveMatchState[] = [];
  const goals: LiveMatchGoal[] = [];
  const stateByMatchId = new Map(liveMatchesNow.map((state) => [state.matchId, state]));
  const finishedByMatchId = new Map(finished.map((match) => [match.id, match]));
  for (const [matchId, previous] of before) {
    const state = stateByMatchId.get(matchId);
    if (!state) {
      const match = finishedByMatchId.get(matchId);
      if (!match) continue;
      updates.push({ matchId, homeClubId: match.homeClubId, awayClubId: match.awayClubId, eventStart: previous.eventCount, phaseChanged: true, finished: true });
      collectGoals(matchId, previous.state, previous.eventCount, goals);
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
    collectGoals(matchId, state, previous.eventCount, goals);
  }
  return { updates, changedStates, goals };
}
