import type { MarketType, World } from "../game/types";
import type { UserWorldEvent } from "./worldEvents";

function listingDetails(world: World, marketType: MarketType, listingId: number): Pick<UserWorldEvent, "status" | "currentPrice" | "deadline" | "bidderCount"> {
  const listing = marketType === "TRANSFER"
    ? world.transferAuctions.find((candidate) => candidate.id === listingId)
    : world.freeAgentListings.find((candidate) => candidate.id === listingId);
  const bids = world.marketBids.filter((bid) => bid.marketType === marketType && bid.listingId === listingId);
  return {
    status: listing?.status ?? "CANCELLED",
    currentPrice: listing?.currentPrice,
    deadline: listing?.deadline,
    bidderCount: bids.length,
  };
}

export function marketUpdatedEvents(
  world: World,
  marketType: MarketType,
  listingId: number,
  statusOverride?: string,
): { userId: number; event: UserWorldEvent }[] {
  const details = listingDetails(world, marketType, listingId);
  const listing = marketType === "TRANSFER"
    ? world.transferAuctions.find((candidate) => candidate.id === listingId)
    : world.freeAgentListings.find((candidate) => candidate.id === listingId);
  const leadingClubId = listing?.leadingClubId ?? null;
  return world.clubs
    .filter((club): club is typeof club & { ownerUserId: number } => club.ownerUserId !== null)
    .map((club) => ({
      userId: club.ownerUserId,
      event: {
        type: "marketUpdated" as const,
        marketType,
        listingId,
        ...details,
        ...(statusOverride ? { status: statusOverride } : {}),
        ...(leadingClubId !== null ? { amILeading: leadingClubId === club.id } : {}),
      },
    }));
}
