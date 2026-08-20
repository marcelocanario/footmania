import type { JobContext, JobResult } from "./runner";
import { rollover } from "../mpService";

/**
 * Season scheduler (worker plan §1).
 *
 * Responsibilities:
 *  - recover an interrupted rollover (world.mp.rolloverPhase still set);
 *  - never choose a rollover from the host calendar.
 *
 * Rollover is atomic and idempotent (mpService.rollover), so a retry after a
 * crash cannot duplicate matches, allocations, promotions, memberships, AI
 * clubs or salary events.
 */
export async function seasonScheduler(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;

  // Recover an interrupted rollover first.
  if (world.mp.rolloverPhase !== null) {
    await rollover(ctx.prisma, { calendarBoundary: true });
    return { changed: true, persisted: true };
  }
  return { changed: false };
}
