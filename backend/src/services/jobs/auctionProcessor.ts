import type { JobContext, JobResult } from "./runner";
import { expireDueListings, settleDueTransferAuctions } from "../../game/market";
import { relistDueFreeAgents, settleDueFreeAgentListings } from "../../game/freeAgents";

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
  const settledFreeAgents = settleDueFreeAgentListings(world, now);
  const relistedFreeAgents = relistDueFreeAgents(world, now);
  if (expiredNew === 0 && settledNew === 0 && settledFreeAgents === 0 && relistedFreeAgents === 0) {
    return { changed: false };
  }
  return { changed: true };
}
