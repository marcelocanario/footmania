import type { JobContext, JobResult } from "./runner";
import { settleDueAuctions } from "../../game/world";

/**
 * Auction processor (worker plan §1).
 *
 * Responsibilities:
 *  - settle only auctions whose endsAt (or legacy day deadline) <= now;
 *  - settle in chronological order;
 *  - settle idempotently: a resolved auction leaves the world (or is marked
 *    resolved), so re-running the job cannot settle the same listing twice.
 */
export async function auctionProcessor(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = Date.now();
  const dueListings = world.auctions.filter((listing) => {
    const deadline = listing.endsAt ?? fallbackDeadline(world, listing);
    return now >= deadline;
  });
  if (dueListings.length === 0) return { changed: false };
  settleDueAuctions(world, now);
  return { changed: true };
}

function fallbackDeadline(world: JobContext["world"], listing: { deadlineDay: number }) {
  const year = world.mp.seasonYear;
  const month = world.mp.seasonMonth;
  return Date.UTC(year, month - 1, Math.max(1, Math.min(31, listing.deadlineDay)), 20, 0, 0);
}
