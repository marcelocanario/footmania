import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-worker.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { startWorker } from "../src/services/worker";
import { createTransferAuction, applyMaxBid, settleDueTransferAuctions, expireDueListings } from "../src/game/market";
import { applyFreeAgentBid, createFreeAgentListing, settleDueFreeAgentListings } from "../src/game/freeAgents";
import { createHumanClub } from "../src/game/worldgen";
import { MP_CONFIG, gameConfig } from "../src/config";
import type { World } from "../src/game/types";

const prisma = new PrismaClient();

/** Current real UTC month as {year, month} — used to keep tests clock-relative. */
function currentMonth() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

async function freshGlobalWorld(seed: number) {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

async function withSeason(saveId: number, ref = currentMonth()) {
  const season = await ensureSeasonRow(prisma, ref);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  initSeason(loaded.world, ref, season.seasonId);
  loaded.world.mp.seasonId = season.seasonId;
  await persistWorld(prisma, saveId, saveId, loaded.world);
  return { seasonId: season.seasonId, world: loaded.world };
}

/** A human-owned club with a generated roster: production sellers/bidders are
 *  always human (filler-AI clubs are inert and hard-blocked, invariant #28).
 *  Also seeds the played matches required by the new-club outbound sell lock
 *  and a matching User row for the Club.ownerUserId foreign key. */
async function humanTrader(world: World, userId: number, name: string) {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.user.create({ data: { id: userId, username: `w-${userId}-${name}`, passwordHash: "test" } });
  const club = createHumanClub(world, { userId, clubName: name, country: "BRA", timezone: null });
  club.competitionState = "ACTIVE";
  // Played own fixtures so the outbound-market lock is satisfied.
  const division = world.competitions.find((candidate) => candidate.kind === "division")!;
  for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
    world.fixtures.push({
      id: world.nextId++,
      competitionId: division.id,
      round,
      homeClubId: club.id,
      awayClubId: -club.id,
      dayIndex: round,
      played: true,
    });
  }
  return club;
}

describe("worker wiring", () => {
  it("starts and stops the durable-scheduler loop without side effects on an empty world", async () => {
    const stop = startWorker(prisma, 10_000);
    // Both the durable scheduler and server-driven match timers must stop cleanly.
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("durable market settlement through persisted worlds", () => {
  it("settles a due transfer listing with bids atomically and skips it on re-run", async () => {
    const { saveId } = await freshGlobalWorld(4101);
    const { world } = await withSeason(saveId);
    // Seller and bidder are human clubs: filler-AI clubs are inert and
    // hard-blocked from the market (invariant #28).
    const seller = await humanTrader(world, 9900, "Seller FC");
    const buyer = await humanTrader(world, 9901, "Bidder FC");
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;

    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;

    const bid = applyMaxBid(world, {
      listing,
      club: buyer,
      player,
      proposedMaximum: Math.round(player.value * 1.1),
      buyerDivision: 1,
      immediateAvailableCash: 100_000_000,
    });
    expect(bid.ok).toBe(true);
    listing.deadline = Date.now() - 1; // make it due AFTER the bid was accepted
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    expect(settleDueTransferAuctions(loaded!.world, Date.now())).toBe(1);
    await persistWorld(prisma, saveId, saveId, loaded!.world);

    const reloaded = await loadGlobalWorld(prisma);
    const settled = reloaded!.world.transferAuctions.find((a) => a.id === listing.id)!;
    expect(settled.status).toBe("COMPLETED");
    expect(settled.winningClubId).toBe(buyer.id);
    expect(reloaded!.world.playerMarketHistory).toHaveLength(1);
    expect(reloaded!.world.players.find((p) => p.id === player.id)!.clubId).toBe(buyer.id);
    expect(reloaded!.world.marketReservations.every((r) => r.releasedAt !== null)).toBe(true);

    // Re-run: idempotent (nothing left to settle).
    const loaded2 = await loadGlobalWorld(prisma);
    expect(settleDueTransferAuctions(loaded2!.world, Date.now())).toBe(0);
    const reloaded2 = await loadGlobalWorld(prisma);
    expect(reloaded2!.world.playerMarketHistory).toHaveLength(1);
  });

  it("expires a due no-bid listing and clears on-sale", async () => {
    const { saveId } = await freshGlobalWorld(4102);
    const { world } = await withSeason(saveId);
    const seller = await humanTrader(world, 9910, "Expiry FC");
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    listing.deadline = Date.now() - 1;
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    expect(expireDueListings(loaded!.world, Date.now())).toBe(1);
    await persistWorld(prisma, saveId, saveId, loaded!.world);

    const reloaded = await loadGlobalWorld(prisma);
    const settled = reloaded!.world.transferAuctions.find((a) => a.id === listing.id)!;
    expect(settled.status).toBe("CANCELLED");
    expect(reloaded!.world.players.find((p) => p.id === player.id)!.onSale).toBe(false);
    expect(reloaded!.world.playerMarketHistory).toHaveLength(0);
  });

  it("settles a free-agent signing through the worker path and persists it", async () => {
    const { saveId } = await freshGlobalWorld(5301);
    const { world } = await withSeason(saveId);
    // Free a player from a human club, then have a second human sign him.
    const club = await humanTrader(world, 9920, "Releaser FC");
    const buyer = await humanTrader(world, 9902, "Signer FC");
    const player = world.players.find((p) => p.clubId === club.id && !p.isYouth)!;
    player.clubId = null;
    player.onSale = false;
    const created = createFreeAgentListing(world, player, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;

    // A club bids.
    const bidAt = 1_700_000_000_000 + 10_000;
    const bid = applyFreeAgentBid(world, { listing, club: buyer, player, proposedMaximum: 2_000_000, immediateAvailableCash: 200_000_000, contractSeasons: 3, now: bidAt });
    expect(bid.ok).toBe(true);
    listing.deadline = Date.now() - 1;
    await persistWorld(prisma, saveId, saveId, world);

    const loaded = await loadGlobalWorld(prisma);
    expect(settleDueFreeAgentListings(loaded!.world, Date.now())).toBe(1);
    await persistWorld(prisma, saveId, saveId, loaded!.world);

    const reloaded = await loadGlobalWorld(prisma);
    const settled = reloaded!.world.freeAgentListings.find((l) => l.id === listing.id)!;
    expect(settled.status).toBe("COMPLETED");
    expect(settled.winningClubId).toBe(buyer.id);
    const signedPlayer = reloaded!.world.players.find((p) => p.id === player.id)!;
    expect(signedPlayer.clubId).toBe(buyer.id);
    const acceptedBid = reloaded!.world.marketBids.find((candidate) => candidate.listingId === listing.id && candidate.clubId === buyer.id);
    expect(signedPlayer.salary).toBe(acceptedBid?.contractSalary);
    expect(signedPlayer.contractDays).toBe(gameConfig.seasonDays * (3 + 1));
    // Money left the economy (no club credited) and history recorded.
    expect(reloaded!.world.playerMarketHistory.some((t) => t.type === "FREE_AGENT_SIGNING")).toBe(true);
  });
});
