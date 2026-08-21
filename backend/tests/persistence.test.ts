import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-persist.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { generateWorld } from "../src/game/worldgen";
import { loadGlobalWorld, persistWorld, ensureGlobalSave, StaleWorldError } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { applyDevelopment } from "../src/game/player";
import { initSeason, createDivision, ensureDivisionFull, generateDivisionFixtures, rebuildTierDivisions } from "../src/game/multiplayer";
import { gameConfig } from "../src/config";

const prisma = new PrismaClient();

async function freshGlobalWorld(seed: number) {
  // Wipe any existing global save so tests are deterministic.
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

async function withSeason(saveId: number) {
  const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  initSeason(loaded.world, { year: 2026, month: 1 }, season.seasonId);
  loaded.world.mp.seasonId = season.seasonId;
  await persistWorld(prisma, saveId, saveId, loaded.world);
  return { seasonId: season.seasonId, world: loaded.world };
}

describe("global multiplayer world persistence", () => {
  it("round-trips clubs, players, fixtures and mp state through the database", async () => {
    const { saveId } = await freshGlobalWorld(4242);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const fixtures = generateDivisionFixtures(world, div, { year: 2026, month: 1 });
    world.fixtures.push(...fixtures);
    world.mpQueue.push({ clubId: world.clubs[0].id, source: "NEW_CLUB", queuedAt: Date.now(), preferredSeasonId: seasonId });
    world.seasonAllocations.push({ clubId: world.clubs[0].id, seasonId, type: "PROVISIONAL_NEXT_SEASON", amount: 5_000_000, issuedAt: Date.now() });
    world.clubs[0].eloRating = 1538.427;
    world.clubs[0].eloRatedMatches = 3;
    world.clubEloEvents = [{
      id: 880001,
      matchId: 880000,
      clubId: world.clubs[0].id,
      opponentClubId: world.clubs[1].id,
      ratingBefore: 1500,
      ratingAfter: 1538.427,
      delta: 38.427,
      expectedScore: 0.5,
      actualScore: 1,
      createdAt: Date.now(),
    }];

    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.world.clubs.length).toBe(world.clubs.length);
    expect(reloaded!.world.players.length).toBe(world.players.length);
    expect(reloaded!.world.competitions.length).toBe(world.competitions.length);
    expect(reloaded!.world.fixtures.length).toBe(world.fixtures.length);
    expect(reloaded!.world.mpQueue.length).toBe(1);
    expect(reloaded!.world.seasonAllocations.length).toBe(1);
    expect(reloaded!.world.seasonAllocations[0].type).toBe("PROVISIONAL_NEXT_SEASON");
    expect(reloaded!.world.clubs[0].eloRating).toBeCloseTo(1538.427, 6);
    expect(reloaded!.world.clubEloEvents).toHaveLength(1);
    expect(reloaded!.world.clubEloEvents![0].matchId).toBe(880000);
    expect(reloaded!.world.nextId).toBeGreaterThan(880001);
  });

  it("round-trips live match state (multiple) and records player minutes on finish", async () => {
    const { saveId } = await freshGlobalWorld(31337);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const home = world.clubs[0];
    const away = world.clubs[1];
    const st = createLiveMatchState(world.rng, home, away, world.players, {
      matchId: 990001,
      fixtureId: 990001,
      competitionId: div.id,
      homeNeutral: false,
    });
    tickLiveMatch(world.rng, home, away, world.players, st, 40, { ignoreHalfTime: true });
    world.liveMatches = [st];
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const st2 = reloaded!.world.liveMatches.find((s) => s.matchId === 990001);
    expect(st2).not.toBeNull();
    expect(st2!.playerMinutes).toEqual(st.playerMinutes);
    expect(st2!.matchClockSeconds).toBe(st.matchClockSeconds);
    expect(st2!.rngState).toEqual(st.rngState);
    expect(st2!.playerEnergy).toEqual(st.playerEnergy);
    expect(st2!.stats.home.controlledBallSeconds + st2!.stats.away.controlledBallSeconds).toBeGreaterThan(0);

    // Finalize via the multiplayer path: minutes land on players.
    const { finalizeLiveMatch } = await import("../src/game/world");
    const home2 = reloaded!.world.clubs.find((c) => c.id === home.id)!;
    const away2 = reloaded!.world.clubs.find((c) => c.id === away.id)!;
    const clockBeforeResume = st2!.matchClockSeconds;
    tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 5, { ignoreHalfTime: true });
    expect(st2!.matchClockSeconds).toBeGreaterThan(clockBeforeResume);
    tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 200, { ignoreHalfTime: true });
    finalizeLiveMatch(reloaded!.world, st2!);
    const onPitchId = st2!.homeOn[0];
    const p = reloaded!.world.players.find((x) => x.id === onPitchId)!;
    expect(p.recentMinutes.length).toBeGreaterThan(0);
  });

  it("keeps the release clause in sync after development ticks and round-trips", async () => {
    const { saveId } = await freshGlobalWorld(555);
    const { world } = await withSeason(saveId);
    const club = world.clubs[0];
    const p = world.players.find((x) => x.clubId === club.id && !x.isYouth)!;
    for (let day = 1; day <= 10; day++) applyDevelopment(world.rng, p, club, day);
    const expected = Math.round(p.salary * (p.contractDays / gameConfig.seasonDays) * 0.5);
    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    const p2 = reloaded!.world.players.find((x) => x.id === p.id)!;
    expect(p2.releaseClause).toBe(expected);
  });

  it("round-trips normalized memberships, club-seasons and activity records", async () => {
    const { saveId } = await freshGlobalWorld(808);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const members = Object.keys(div.standings).map(Number);
    world.mpMemberships = members.map((clubId, i) => ({
      divisionId: div.id,
      clubId,
      slotNumber: i + 1,
      isFillerAI: i >= 5,
      replacedClubId: null,
      joinedAt: Date.now(),
    }));
    world.mpClubSeasons = members.map((clubId, i) => ({
      clubId,
      seasonId,
      divisionId: div.id,
      tier: 1,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      promotionStatus: "NONE",
      relegationStatus: "NONE",
    }));
    world.mpActivities.push({ userId: 1, clubId: members[0], activityType: "tactics", occurredAt: Date.now(), metadata: null });
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.world.mpMemberships.length).toBe(members.length);
    expect(reloaded!.world.mpClubSeasons.length).toBe(members.length);
    expect(reloaded!.world.mpActivities.length).toBe(1);
    expect(reloaded!.world.mpActivities[0].activityType).toBe("tactics");
    expect(reloaded!.world.mpMemberships[0].slotNumber).toBe(1);
  });

  it("rejects a stale revision write and bumps the revision on success", async () => {
    const { saveId } = await freshGlobalWorld(707);
    const first = await loadGlobalWorld(prisma);
    expect(first).not.toBeNull();
    const rev0 = first!.save.revision;

    // Simulate a concurrent writer: mutate + persist the world first.
    const second = await loadGlobalWorld(prisma);
    expect(second).not.toBeNull();
    second!.world.mp.completedRounds = 3;
    await persistWorld(prisma, saveId, saveId, second!.world, second!.save.revision);

    // The first writer now holds a stale world/revision.
    await expect(persistWorld(prisma, saveId, saveId, first!.world, rev0)).rejects.toBeInstanceOf(StaleWorldError);

    // Revision was incremented by the successful write.
    const after = await loadGlobalWorld(prisma);
    expect(after).not.toBeNull();
    expect(after!.save.revision).toBeGreaterThan(rev0);
  });

  it("round-trips player-origin metadata and the generation-events ledger (spec §45/§50)", async () => {
    const { saveId } = await freshGlobalWorld(4242);
    const { seasonId, world } = await withSeason(saveId);
    // Tag a generated player with origin metadata.
    const player = world.players.find((p) => !p.isYouth)!;
    player.generatedClubId = world.clubs[0].id;
    player.generatedDivision = 2;
    player.generatedSeasonId = seasonId;
    player.generationType = "initial-senior";
    player.generatedClubHighestDivision = 1;
    player.rawZ = 1.234;
    // Record an intake ledger event.
    world.generationEvents.push("academy-intake:1:7");
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    const rp = rw.players.find((p) => p.id === player.id)!;
    expect(rp.generatedClubId).toBe(world.clubs[0].id);
    expect(rp.generatedDivision).toBe(2);
    expect(rp.generatedSeasonId).toBe(seasonId);
    expect(rp.generationType).toBe("initial-senior");
    expect(rp.generatedClubHighestDivision).toBe(1);
    expect(rp.rawZ).toBeCloseTo(1.234, 5);
    expect(rw.generationEvents).toContain("academy-intake:1:7");
  });

  it("round-trips market listings, bids, reservations, history, and AI evaluations", async () => {
    const { saveId } = await freshGlobalWorld(901);
    const { seasonId, world } = await withSeason(saveId);
    const seller = world.clubs[0];
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
    const now = Date.now();

    // A public auction listing.
    const { createTransferAuction, applyMaxBid, releaseAllReservations } = await import("../src/game/market");    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;

    // A club bids (reservation + bid rows).
    const buyer = world.clubs.find((c) => c.id !== seller.id)!;
    const bid = applyMaxBid(world, {
      listing,
      club: buyer,
      player,
      proposedMaximum: Math.round(player.value * 1.1),
      buyerDivision: 1,
      immediateAvailableCash: 50_000_000,
      contractSeasons: 4,
      now,
    });
    expect(bid.ok).toBe(true);

    // History + AI evaluation state.
    const { recordTransaction } = await import("../src/game/market");
    recordTransaction(world, {
      playerId: player.id, listingId: listing.id, type: "TRANSFER",
      fromClubId: seller.id, toClubId: buyer.id, price: listing.currentPrice,
      seasonId, seasonKey: "2026-01", seasonDayIndex: world.dayIndex, contractSeasons: 4, contractSalary: world.marketBids[0].contractSalary, timestamp: now,
    });
    world.aiEvaluations.push({
      marketType: "TRANSFER", listingId: listing.id, clubId: buyer.id,
      evaluatedAt: now, decision: "BID", maxBid: Math.round(player.value * 1.1), contractSeasons: 4, contractSalary: world.marketBids[0].contractSalary,
    });

    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    expect(rw.transferAuctions).toHaveLength(1);
    expect(rw.transferAuctions[0].id).toBe(listing.id);
    expect(rw.transferAuctions[0].status).toBe("ACTIVE");
    expect(rw.marketBids).toHaveLength(1);
    expect(rw.marketBids[0].clubId).toBe(buyer.id);
    expect(rw.marketBids[0].maxBid).toBe(world.marketBids[0].maxBid);
    expect(rw.marketBids[0].contractSeasons).toBe(4);
    expect(rw.marketBids[0].contractSalary).toBe(world.marketBids[0].contractSalary);
    expect(rw.marketReservations).toHaveLength(1);
    expect(rw.marketReservations[0].amount).toBe(world.marketBids[0].maxBid);
    expect(rw.playerMarketHistory).toHaveLength(1);
    expect(rw.playerMarketHistory[0].type).toBe("TRANSFER");
    expect(rw.playerMarketHistory[0].contractSeasons).toBe(4);
    expect(rw.playerMarketHistory[0].contractSalary).toBe(world.marketBids[0].contractSalary);
    expect(rw.aiEvaluations).toHaveLength(1);
    expect(rw.aiEvaluations[0].decision).toBe("BID");
    expect(rw.aiEvaluations[0].contractSeasons).toBe(4);
    expect(rw.aiEvaluations[0].contractSalary).toBe(world.marketBids[0].contractSalary);

    // A reload after settlement-like release: released reservations survive.
    releaseAllReservations(rw, listing.id, "TRANSFER");
    await persistWorld(prisma, saveId, saveId, rw);
    const reloaded2 = await loadGlobalWorld(prisma);
    expect(reloaded2!.world.marketReservations[0].releasedAt).not.toBeNull();
  });

  it("round-trips financial-intervention audit data and anti-loop fields", async () => {
    const { saveId } = await freshGlobalWorld(902);
    const { seasonId, world } = await withSeason(saveId);
    const club = world.clubs[0];
    const replacement = world.players.find((player) => player.clubId === club.id && !player.isYouth)!;
    replacement.financialInterventionGeneratedSeasonId = seasonId;
    const freeAgent = world.players.find((player) => player.clubId === club.id && !player.isYouth && player.id !== replacement.id)!;
    freeAgent.clubId = null;
    freeAgent.onSale = false;
    const { createFreeAgentListing } = await import("../src/game/freeAgents");
    const created = createFreeAgentListing(world, freeAgent, { blockedClubId: club.id });
    expect(created.ok).toBe(true);
    world.financialInterventions.push({
      id: 990001,
      clubId: club.id,
      seasonId,
      payrollCycleId: 7,
      cashBefore: -1,
      commitmentsBefore: 2,
      cushionBefore: -3,
      forcedAuctionRevenue: 0,
      systemLiquidationRevenue: 4,
      cashAfter: 3,
      commitmentsAfter: 2,
      cushionAfter: 1,
      createdAt: Date.now(),
      entries: [{ playerId: freeAgent.id, kind: "SYSTEM_LIQUIDATION", price: 4, replacementPlayerId: replacement.id }],
      unableToFullyRecover: false,
    });
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    expect(rw.financialInterventions).toHaveLength(1);
    expect(rw.financialInterventions[0].entries[0].replacementPlayerId).toBe(replacement.id);
    expect(rw.nextId).toBeGreaterThan(990001);
    expect(rw.players.find((player) => player.id === replacement.id)?.financialInterventionGeneratedSeasonId).toBe(seasonId);
    expect(rw.freeAgentListings.find((listing) => listing.playerId === freeAgent.id)?.blockedClubId).toBe(club.id);
    expect(rw.freeAgentListings.find((listing) => listing.playerId === freeAgent.id)?.unclaimedSince).toBeDefined();
  });

  it("reads a legacy matchday into seasonDayIndex without losing its value", async () => {
    const { saveId } = await freshGlobalWorld(903);
    const { seasonId, world } = await withSeason(saveId);
    const player = world.players[0];
    await prisma.playerMarketTransaction.create({
      data: {
        saveId,
        playerId: player.id,
        listingId: null,
        type: "LOAN",
        fromClubId: null,
        toClubId: null,
        price: 0,
        seasonId,
        seasonKey: "2026-01",
        seasonDayIndex: null,
        matchday: 9,
        contractSeasons: null,
        contractSalary: null,
        timestamp: BigInt(123),
      },
    });
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.playerMarketHistory[0].seasonDayIndex).toBe(9);
  });

  it("migrates persisted legacy phases through the authoritative calendar", async () => {
    const { saveId, world } = await freshGlobalWorld(904);
    world.mp.seasonDayIndex = 28;
    world.mp.absoluteGameDay = 28;
    world.mp.phase = "ACTIVE";
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.mp.phase).toBe("POST_MATCH");
  });
});
