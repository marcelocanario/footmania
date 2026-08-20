import type { JobContext, JobResult } from "./runner";
import { expireDueListings, settleDueTransferAuctions } from "../../game/market";
import { processDueFreeAgentListings } from "../../game/freeAgents";
import { scheduleEvent, ScheduledEventType } from "../scheduler";

/**
 * Auction processor (worker plan §1).
 *
 * Responsibilities:
 *  - expire no-bid new-format transfer listings past deadline;
 *  - atomically settle new-format transfer listings WITH bids (Phase 3);
 *  - settle due free-agent listings and relist no-bid ones (§54);
 *  - settle idempotently: resolved listings change status so re-runs skip them.
 */
export async function auctionProcessor(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = Date.now();
  const expiredNew = expireDueListings(world, now);
  const settledNew = settleDueTransferAuctions(world, now);
  const freeAgentResults = processDueFreeAgentListings(world, now);
  for (const result of freeAgentResults) {
    if (result.kind === "RELISTED") {
      const relisted = world.freeAgentListings.find((listing) => listing.id === result.newListingId);
      if (relisted) {
        await scheduleEvent(ctx.prisma, {
          saveId: ctx.saveId,
          type: ScheduledEventType.AUCTION_END,
          timeBasis: "REAL_TIME",
          dueAt: new Date(relisted.deadline),
          phase: "INTRADAY",
          entityType: "FREE_AGENT",
          entityId: String(relisted.id),
          payload: { listingId: relisted.id, marketType: "FREE_AGENT" },
          idempotencyKey: `AUCTION_END:FREE_AGENT:${relisted.id}:${relisted.deadline}`,
        });
      }
    } else if (result.kind === "DELETED") {
      await ctx.prisma.scheduledEvent.updateMany({
        where: {
          saveId: ctx.saveId,
          type: ScheduledEventType.AUCTION_END,
          entityType: "FREE_AGENT",
          entityId: { in: result.listingIds.map(String) },
          status: { in: ["PENDING", "FAILED"] },
        },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
    }
  }
  const changedFreeAgents = freeAgentResults.length;
  if (expiredNew === 0 && settledNew === 0 && changedFreeAgents === 0) {
    return { changed: false };
  }
  return { changed: true };
}
