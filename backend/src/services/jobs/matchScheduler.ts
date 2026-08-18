import type { JobContext, JobResult } from "./runner";
import { processDueFixtures, advanceLiveMatches, syncCompletedRounds } from "../../game/world";
import { simulateThroughRound } from "../../game/multiplayer";
import { seasonRefFor } from "../../game/clock";

/**
 * Match scheduler (worker plan §1).
 *
 * Responsibilities:
 *  - sync completed rounds from the real clock (advances join-lock state);
 *  - start overdue fixtures at their scheduled kickoff;
 *  - advance in-progress live matches at real-time pace until full-time.
 *
 * All three are idempotent and timestamp-driven (kickoffAt / lastAdvancedAt),
 * so running them after downtime catches up automatically and re-running them
 * cannot double-play a fixture.
 */
export async function matchScheduler(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = Date.now();

  // Admin manual clock override: set-round deliberately only writes the target
  // and relies on the worker to perform the simulation on its next tick.
  if (world.mp.manualRound !== null) {
    if (world.mp.manualRound !== world.mp.completedRounds) {
      simulateThroughRound(world, world.mp.manualRound, now);
      return { changed: true };
    }
    const before = liveProgressSignature(world);
    const finished = advanceLiveMatches(world, now);
    return { changed: finished.length > 0 || before !== liveProgressSignature(world) };
  }

  const realRef = seasonRefFor(new Date(now));
  const worldOrder = world.mp.seasonYear * 12 + (world.mp.seasonMonth - 1);
  const realOrder = realRef.year * 12 + (realRef.month - 1);
  // A forced/admin future season owns its clock until real time catches up.
  if (worldOrder > realOrder) return { changed: false };

  const completedBefore = world.mp.completedRounds;
  const statusBefore = world.mp.seasonStatus;
  const joinStateBefore = world.mp.joinState;
  const liveBefore = liveProgressSignature(world);
  syncCompletedRounds(world, now);
  const started = processDueFixtures(world, now);
  const finished = advanceLiveMatches(world, now);
  const changed =
    completedBefore !== world.mp.completedRounds ||
    statusBefore !== world.mp.seasonStatus ||
    joinStateBefore !== world.mp.joinState ||
    started.length > 0 ||
    finished.length > 0 ||
    liveBefore !== liveProgressSignature(world);
  return { changed };
}

/** A cheap mutation fingerprint for live-match pacing. Full world persistence
 * is unnecessary on ticks where no match minute became due. */
function liveProgressSignature(world: JobContext["world"]): string {
  return world.liveMatches
    .map((match) => `${match.matchId}:${match.half}:${match.minute}:${match.scores[0]}:${match.scores[1]}:${match.lastAdvancedAt}:${match.ended}`)
    .join("|");
}
