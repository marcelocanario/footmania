import type { JobContext, JobResult } from "./runner";
import { seasonRefFor, seasonKey } from "../../game/clock";
import { rollover } from "../mpService";

function seasonOrder(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Season scheduler (worker plan §1).
 *
 * Responsibilities:
 *  - detect calendar transitions (month boundary) and run rollover;
 *  - recover an interrupted rollover (world.mp.rolloverPhase still set);
 *  - never re-run rollover for a month the world is already on.
 *
 * Rollover is atomic and idempotent (mpService.rollover), so a retry after a
 * crash cannot duplicate matches, allocations, promotions, memberships, AI
 * clubs or salary events.
 */
export async function seasonScheduler(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = Date.now();
  const ref = seasonRefFor(new Date(now));

  const worldOrder = seasonOrder(world.mp.seasonYear, world.mp.seasonMonth);
  const realOrder = seasonOrder(ref.year, ref.month);

  // Recover an interrupted rollover first.
  if (world.mp.rolloverPhase !== null) {
    await rollover(ctx.prisma);
    return { changed: true, persisted: true };
  }

  // A forced admin rollover may intentionally put the world one month ahead of
  // the host clock; the admin clock is authoritative until real time catches up.
  if (worldOrder > realOrder) return { changed: false };

  // Crossed into a new calendar month while the world is still on the old one.
  if (world.mp.seasonId !== 0 && worldOrder < realOrder) {
    await rollover(ctx.prisma);
    return { changed: true, persisted: true };
  }

  return { changed: false };
}
