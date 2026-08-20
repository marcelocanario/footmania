import { describe, expect, it } from "vitest";
import { migrateActiveContractMarket } from "../src/services/contractMarketMigration";
import { applyFreeAgentBid, createFreeAgentListing } from "../src/game/freeAgents";
import { applyMaxBid, createTransferAuction } from "../src/game/market";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { makeClub, makeWorld } from "./helpers";

describe("active contract-market migration", () => {
  it("clears active auctions and recreates one free-agent listing with preserved state", () => {
    const seller = makeClub({ id: 10, ownerUserId: null });
    const buyer = makeClub({ id: 1, ownerUserId: 1 });
    const freeAgent = generatePlayer(createRng(1), seller, { id: 2, isYouth: false });
    freeAgent.clubId = null;
    const transferPlayer = generatePlayer(createRng(2), seller, { id: 3, isYouth: false });
    const world = makeWorld([seller, buyer], [freeAgent, transferPlayer]);
    const transfer = createTransferAuction(world, { player: transferPlayer, sellerClub: seller, sellerDivision: 1, totalDivisions: 3, now: 100 });
    if (!transfer.ok) throw new Error(transfer.error);
    expect(applyMaxBid(world, { listing: transfer.listing, club: buyer, player: transferPlayer, proposedMaximum: transfer.listing.openingPrice, buyerDivision: 1, immediateAvailableCash: 50_000_000, now: 101 }).ok).toBe(true);
    const free = createFreeAgentListing(world, freeAgent, { now: 200, salaryBaselineAtListing: 123_000, unclaimedSince: 150 });
    if (!free.ok) throw new Error(free.error);
    expect(applyFreeAgentBid(world, { listing: free.listing, club: buyer, player: freeAgent, proposedMaximum: free.listing.openingPrice, immediateAvailableCash: 50_000_000, now: 201 }).ok).toBe(true);
    world.aiEvaluations.push({ marketType: "TRANSFER", listingId: transfer.listing.id, clubId: buyer.id, evaluatedAt: 101, decision: "BID", maxBid: transfer.listing.openingPrice });
    world.aiEvaluations.push({ marketType: "FREE_AGENT", listingId: free.listing.id, clubId: buyer.id, evaluatedAt: 201, decision: "BID", maxBid: free.listing.openingPrice });

    expect(migrateActiveContractMarket(world, 1_000)).toBe(true);
    expect(transfer.listing.status).toBe("CANCELLED");
    expect(transferPlayer.onSale).toBe(false);
    expect(free.listing.status).toBe("CANCELLED");
    expect(world.marketBids).toHaveLength(0);
    expect(world.aiEvaluations).toHaveLength(0);
    expect(world.marketReservations.every((reservation) => reservation.releasedAt !== null)).toBe(true);
    const activeFreeAgents = world.freeAgentListings.filter((listing) => listing.status === "ACTIVE");
    expect(activeFreeAgents).toHaveLength(1);
    expect(activeFreeAgents[0].salaryBaselineAtListing).toBe(123_000);
    expect(activeFreeAgents[0].unclaimedSince).toBe(150);
    expect(world.mp.contractMarketMigrationVersion).toBe(1);
    expect(migrateActiveContractMarket(world, 2_000)).toBe(false);
  });
});
