import type { World } from "../game/types";
import { createFreeAgentListing } from "../game/freeAgents";
import { releaseAllReservations } from "../game/market";

/** One-time cleanup for active market rows created before bidder-specific terms. */
export function migrateActiveContractMarket(world: World, now: number): boolean {
  if ((world.mp.contractMarketMigrationVersion ?? 0) >= 1) return false;

  const transferIds = new Set<number>();
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE") continue;
    transferIds.add(listing.id);
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = now;
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (player) player.onSale = false;
  }

  const activeFreeAgentIds = new Set<number>();
  const activeFreeAgents = new Map<number, { unclaimedSince: number; salaryBaselineAtListing?: number; blockedClubId: number | null }>();
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE") continue;
    activeFreeAgentIds.add(listing.id);
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    const existing = activeFreeAgents.get(listing.playerId);
    const related = world.freeAgentListings.filter((candidate) => candidate.playerId === listing.playerId);
    const unclaimedSince = related.reduce((earliest, candidate) => Math.min(earliest, candidate.unclaimedSince ?? candidate.createdAt), Number.POSITIVE_INFINITY);
    const earliestWithBaseline = [...related]
      .sort((a, b) => (a.unclaimedSince ?? a.createdAt) - (b.unclaimedSince ?? b.createdAt))
      .find((candidate) => candidate.salaryBaselineAtListing !== undefined);
    const salaryBaselineAtListing = earliestWithBaseline?.salaryBaselineAtListing;
    if (!existing) {
      activeFreeAgents.set(listing.playerId, {
        unclaimedSince: Number.isFinite(unclaimedSince) ? unclaimedSince : listing.createdAt,
        salaryBaselineAtListing,
        blockedClubId: listing.blockedClubId,
      });
    } else {
      existing.unclaimedSince = Math.min(existing.unclaimedSince, unclaimedSince);
      existing.salaryBaselineAtListing ??= salaryBaselineAtListing;
      existing.blockedClubId ??= listing.blockedClubId;
    }
    listing.status = "CANCELLED";
    listing.completedAt = now;
  }

  const clearedListingIds = new Set([...transferIds, ...activeFreeAgentIds]);
  world.marketBids = world.marketBids.filter((bid) => !clearedListingIds.has(bid.listingId));

  for (const [playerId, preserved] of activeFreeAgents) {
    const player = world.players.find((candidate) => candidate.id === playerId);
    if (!player || player.clubId !== null || player.isYouth) continue;
    createFreeAgentListing(world, player, {
      now,
      salaryBaselineAtListing: preserved.salaryBaselineAtListing,
      unclaimedSince: preserved.unclaimedSince,
      blockedClubId: preserved.blockedClubId,
    });
  }

  world.mp.contractMarketMigrationVersion = 1;
  return true;
}
