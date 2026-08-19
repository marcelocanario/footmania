import { describe, it, expect } from "vitest";
import {
  aiMaximumBid,
  aiSellSurplus,
  calculateSellScore,
  deterministicValuationNoise,
  evaluateAndBidOnce,
  evaluateSquadForSelling,
  positionNeedScore,
  runAiBuying,
  runAiSelling,
  upgradeGain,
} from "../src/game/aiMarket";
import { clubTransferCapMultiplier, createTransferAuction } from "../src/game/market";
import { MARKET_CONFIG } from "../src/config";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, TransferAuction, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function makeAIClub(id: number, overrides: Partial<Club> = {}): Club {
  return makeClub({ id, isHuman: false, ownerUserId: null, cash: 50_000_000, ...overrides });
}

function player(
  rng: ReturnType<typeof createRng>,
  club: Club,
  id: number,
  overrides: Partial<Player> = {}
): Player {
  const p = generatePlayer(rng, club, { id, isYouth: false });
  return { ...p, ...overrides, clubId: club.id };
}

/** Build a world with one AI club and its senior squad. */
function squadWorld(club: Club, players: Player[]): World {
  return makeWorld([club], players);
}

describe("sell score (§36)", () => {
  it("lists a surplus backup over the threshold", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    // Three defenders: the evaluated one is clearly surplus.
    const p1 = player(rng, club, 1, { position: 2, overall: 70, age: 24, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const world = squadWorld(club, [p1, p2, p3]);

    const result = calculateSellScore({
      world,
      club,
      player: p1,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(MARKET_CONFIG.aiSelling.listThreshold);
    expect(result.shouldList).toBe(true);
  });

  it("protects the sole senior player at a position regardless of market opportunity (§93)", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const keeper = player(rng, club, 1, { position: 0, overall: 70, age: 22, contractDays: 30 });
    // Only one GK in the whole squad.
    const world = squadWorld(club, [keeper]);

    const candidates = evaluateSquadForSelling(world, club);
    expect(candidates.find((c) => c.player.id === keeper.id)).toBeUndefined();
    expect(candidates.length).toBe(0);
  });

  it("penalises a primary starter so it is not listed", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const starter = player(rng, club, 1, { position: 3, overall: 80, age: 26, starter: true, contractDays: 30 });
    // A backup exists, but the starter penalty (-30) cancels the backup bonus.
    const backup = player(rng, club, 2, { position: 3, overall: 68, age: 24, contractDays: 30 });
    const world = squadWorld(club, [starter, backup]);

    const result = calculateSellScore({
      world,
      club,
      player: starter,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    expect(result.shouldList).toBe(false);
  });

  it("adds financial pressure when cash is low relative to payroll", () => {
    const rng = createRng(1);
    const club = makeAIClub(1, { cash: 100_000 });
    const p1 = player(rng, club, 1, { position: 2, overall: 70, salary: 3_000_000, age: 24, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, salary: 3_000_000, age: 25, contractDays: 30 });
    const world = squadWorld(club, [p1, p2]);

    const rich = makeAIClub(1, { cash: 200_000_000 });
    const richResult = calculateSellScore({
      world,
      club: rich,
      player: p1,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    const poor = makeAIClub(1, { cash: 100_000 });
    const poorResult = calculateSellScore({
      world,
      club: poor,
      player: p1,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    expect(poorResult.score).toBeGreaterThan(richResult.score);
  });

  it("does not use hidden potential, developmentProfile, or star flags", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const highPotential = player(rng, club, 1, { position: 2, overall: 70, age: 19, potential: 95, developmentProfile: { declineStartAge: 35, developmentRate: 3, developmentVolatility: 0.05 }, contractDays: 30 });
    const lowPotential = player(rng, club, 2, { position: 2, overall: 70, age: 19, potential: 40, developmentProfile: { declineStartAge: 24, developmentRate: 0.1, developmentVolatility: 0.9 }, contractDays: 30 });
    const world = squadWorld(club, [highPotential, lowPotential]);

    const result = calculateSellScore({
      world,
      club,
      player: highPotential,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    // The score must be identical for two identical visible players differing
    // only in hidden potential/development profile.
    const control = calculateSellScore({
      world,
      club,
      player: lowPotential,
      activeListingsAtPosition: 0,
      clubsWithNeedAtPosition: 0,
    });
    expect(result.score).toBe(control.score);
  });
});

describe("AI selling decision (§39/§40)", () => {
  it("creates a public auction for an eligible surplus player", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const p1 = player(rng, club, 1, { position: 2, overall: 70, age: 24, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const world = squadWorld(club, [p1, p2, p3]);

    const created = aiSellSurplus(world, club, { sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(created.length).toBeGreaterThan(0);
    const listing = world.transferAuctions.find((a) => a.status === "ACTIVE");
    expect(listing).toBeDefined();
    expect(listing!.sellerClubId).toBe(club.id);
    expect(listing!.openingPrice).toBeGreaterThan(0);
    // The player is marked on sale.
    expect(world.players.find((p) => p.id === listing!.playerId)!.onSale).toBe(true);
  });

  it("never lists a youth player or a player on loan", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const youth = player(rng, club, 1, { position: 2, overall: 70, age: 17, isYouth: true, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const onLoan = player(rng, club, 4, { position: 2, overall: 68, age: 24, contractDays: 30, loanId: 99 });
    const world = squadWorld(club, [youth, p2, p3, onLoan]);

    const created = aiSellSurplus(world, club, { sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    for (const c of created) {
      const pl = world.players.find((p) => p.id === c.playerId)!;
      expect(pl.isYouth).toBe(false);
      expect(pl.loanId).toBeNull();
    }
  });

  it("does not create duplicate active listings for the same player on a second run", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const p1 = player(rng, club, 1, { position: 2, overall: 70, age: 24, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const world = squadWorld(club, [p1, p2, p3]);

    const first = aiSellSurplus(world, club, { sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(first.length).toBeGreaterThan(0);
    const second = aiSellSurplus(world, club, { sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    // No new listings for already-listed players.
    const listedPlayerIds = new Set(world.transferAuctions.filter((a) => a.status === "ACTIVE").map((a) => a.playerId));
    expect(second.every((c) => !listedPlayerIds.has(c.playerId))).toBe(true);
  });

  it("respects the same-season cooldown after a club-to-club purchase", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const other = makeAIClub(2);
    const p1 = player(rng, club, 1, { position: 2, overall: 70, age: 24, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const world = squadWorld(club, [p1, p2, p3]);
    void other;

    // Simulate a same-season club-to-club acquisition for p1.
    world.playerMarketHistory.push({
      id: world.nextId++,
      playerId: p1.id,
      listingId: 500,
      type: "TRANSFER",
      fromClubId: 999,
      toClubId: club.id,
      price: 1_000_000,
      seasonId: world.mp.seasonId,
      seasonKey: "2026-01",
      matchday: 1,
      timestamp: 1_700_000_000_000,
    });

    const created = aiSellSurplus(world, club, { sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(created.some((c) => c.playerId === p1.id)).toBe(false);
  });
});

describe("runAiSelling rotation and budgets", () => {
  it("only evaluates AI clubs and only when a budget is configured", () => {
    const rng = createRng(1);
    const ai1 = makeAIClub(1);
    const ai2 = makeAIClub(2);
    const human = makeClub({ id: 3, isHuman: true, ownerUserId: 3 });
    const p1 = player(rng, ai1, 1, { position: 2, overall: 70, age: 24, contractDays: 30 });
    const p2 = player(rng, ai1, 2, { position: 2, overall: 72, age: 25, contractDays: 30 });
    const p3 = player(rng, ai1, 3, { position: 2, overall: 69, age: 26, contractDays: 30 });
    const p4 = player(rng, ai2, 4, { position: 3, overall: 70, age: 24, contractDays: 30 });
    const p5 = player(rng, ai2, 5, { position: 3, overall: 72, age: 25, contractDays: 30 });
    const p6 = player(rng, ai2, 6, { position: 3, overall: 69, age: 26, contractDays: 30 });
    const world = makeWorld([ai1, ai2, human], [p1, p2, p3, p4, p5, p6]);

    const created = runAiSelling(world, {
      divisionByClub: new Map([[ai1.id, 1]]),
      totalDivisions: 3,
      now: 1_700_000_000_000,
      maxClubs: 10,
    });
    // Only ai1 had a division; ai2 (no division) and human are skipped.
    expect(created.every((c) => world.clubs.find((x) => x.id === world.transferAuctions.find((a) => a.id === c.listingId)?.sellerClubId) === ai1)).toBe(true);
  });

  it("rotates which clubs are evaluated across time buckets", () => {
    const rng = createRng(1);
    const clubs = [1, 2, 3].map((i) => makeAIClub(i));
    const players: Player[] = [];
    for (const club of clubs) {
      // Each club has surplus attackers.
      for (let i = 0; i < 3; i++) {
        players.push(player(rng, club, club.id * 100 + i, { position: 4, overall: 70 + i, age: 24 + i, contractDays: 30 }));
      }
    }
    const divisionByClub = new Map(clubs.map((c) => [c.id, 1]));

    // Bucket for t1 and t2 differ by at least one evaluation interval.
    const t1 = 1_700_000_000_000;
    const interval = MARKET_CONFIG.aiSelling.evaluationIntervalMinutes * 60_000;
    const t2 = t1 + interval;

    const sellerOf = (world: World, created: ReturnType<typeof runAiSelling>) => {
      const ids = created.map((c) => world.transferAuctions.find((a) => a.id === c.listingId)?.sellerClubId);
      return ids.find((x) => x !== undefined) ?? null;
    };

    const w1 = makeWorld(clubs, players);
    const w2 = makeWorld(clubs, players);
    const r1 = runAiSelling(w1, { divisionByClub, totalDivisions: 3, now: t1, maxClubs: 1 });
    const r2 = runAiSelling(w2, { divisionByClub, totalDivisions: 3, now: t2, maxClubs: 1 });
    const seller1 = sellerOf(w1, r1);
    const seller2 = sellerOf(w2, r2);
    expect(seller1).not.toBeNull();
    expect(seller2).not.toBeNull();
    // Different time buckets start at different clubs (not identical).
    expect(seller1).not.toBe(seller2);
  });
});
describe("AI buying — position need (§28)", () => {
  it("scores high need when there is no viable starter at a position", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    // Only one weak senior defender (overall 55, below the 60 floor).
    const weak = player(rng, club, 1, { position: 2, overall: 55, age: 24, contractDays: 30 });
    const world = squadWorld(club, [weak]);

    const need = positionNeedScore(club, world.players, 2);
    // noViableStarter (50) + belowRequiredDepth (40)
    expect(need).toBeGreaterThanOrEqual(50 + 40);
  });

  it("scores low/negative when the position is already strong and deep", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const p1 = player(rng, club, 1, { position: 2, overall: 78, age: 24, starter: true, contractDays: 30 });
    const p2 = player(rng, club, 2, { position: 2, overall: 75, age: 25, contractDays: 30 });
    const p3 = player(rng, club, 3, { position: 2, overall: 74, age: 26, contractDays: 30 });
    const p4 = player(rng, club, 4, { position: 2, overall: 73, age: 27, contractDays: 30 });
    const world = squadWorld(club, [p1, p2, p3, p4]);

    const need = positionNeedScore(club, world.players, 2);
    // adequate >= desired+2 => alreadyStrong (-40)
    expect(need).toBeLessThanOrEqual(0);
  });
});

describe("AI buying — upgrade gain and deterministic noise (§29/§32)", () => {
  it("computes upgrade gain as target overall relative to the current best", () => {
    const rng = createRng(1);
    const club = makeAIClub(1);
    const starter = player(rng, club, 1, { position: 3, overall: 72, age: 25, starter: true, contractDays: 30 });
    const world = squadWorld(club, [starter]);
    const target = player(rng, club, 99, { position: 3, overall: 80, age: 24, contractDays: 30 });

    const gain = upgradeGain(club, world.players, target);
    expect(gain).toBeCloseTo(80 / 72, 5);
  });

  it("returns the same noise for the same club+player+listing", () => {
    const a = deterministicValuationNoise(1, 2, 3);
    const b = deterministicValuationNoise(1, 2, 3);
    expect(a).toBe(b);
  });

  it("produces different noise for different players", () => {
    const a = deterministicValuationNoise(1, 2, 3);
    const c = deterministicValuationNoise(1, 4, 3);
    expect(a).not.toBe(c);
  });
});

describe("AI maximum bid (§30)", () => {
  it("never exceeds the bidder-specific auction cap or the safe budget", () => {
    const rng = createRng(1);
    const club = makeAIClub(1, { cash: 500_000_000 });
    const player1 = player(rng, club, 1, { position: 3, overall: 85, age: 24, value: 100_000_000, salary: 5_000_000, contractDays: 30 });
    const world = squadWorld(club, [player1]);

    // Seller in a stronger division (2) than buyer (1): cap = 150% baseline? No —
    // buyer stronger division (1) buying from weaker (2): gap = 2-1 = 1.
    const listing = {
      id: 5,
      playerId: player1.id,
      sellerClubId: 999,
      sellerDivisionAtListing: 2,
      totalDivisionsAtListing: 3,
      openingPrice: 1,
      bidIncrement: 1,
      playerValueAtListing: player1.value,
      currentPrice: 1,
      leadingClubId: null,
      createdAt: 1_700_000_000_000,
      deadline: 1_700_000_000_000 + 100_000,
      originalDeadline: 1_700_000_000_000,
      status: "ACTIVE" as const,
      completedAt: null,
      winningClubId: null,
      finalPrice: null,
      cancelledAt: null,
      softClosed: false,
      softCloseExtensions: 0,
    } as TransferAuction;

    const bid = aiMaximumBid({
      club,
      player: player1,
      listing,
      needScore: 90,
      upgrade: 1.2,
      buyerDivision: 1,
      totalDivisions: 3,
      safeMarketBudget: 250_000_000,
    });

    const cap = clubTransferCapMultiplier(1, 2, 3);
    expect(bid).toBeLessThanOrEqual(Math.round(Math.min(player1.value * cap, 250_000_000)));
    // And it must be a sensible positive number.
    expect(bid).toBeGreaterThan(0);
  });
});

describe("evaluateAndBidOnce (§33/§34)", () => {
  function listingFor(world: World, seller: Club, p: Player): TransferAuction {
    const created = createTransferAuction(world, { player: p, sellerClub: seller, sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    return created.listing;
  }

  it("submits one maximum bid for a genuine need and records the evaluation", () => {
    const rng = createRng(1);
    const buyer = makeAIClub(1);
    const seller = makeAIClub(2);
    // Buyer has no viable GK.
    const nobody = player(rng, buyer, 1, { position: 3, overall: 40, age: 24, contractDays: 30 });
    const world = squadWorld(buyer, [nobody]);
    world.clubs.push(seller);

    // Seller lists a strong GK.
    const gk = player(rng, seller, 2, { position: 0, overall: 80, age: 24, value: 20_000_000, salary: 2_000_000, contractDays: 30 });
    gk.clubId = seller.id;
    world.players.push(gk);
    const listing = listingFor(world, seller, gk);

    const result = evaluateAndBidOnce(world, buyer, listing, { buyerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bid).toBeGreaterThan(0);
    // The durable evaluation row is recorded.
    const evalRow = world.aiEvaluations.find((e) => e.listingId === listing.id && e.clubId === buyer.id);
    expect(evalRow).toBeDefined();
    expect(evalRow!.decision).toBe("BID");
    // The bid landed in the market.
    expect(world.marketBids.some((b) => b.listingId === listing.id && b.clubId === buyer.id)).toBe(true);
  });

  it("does not re-evaluate the same listing (no second bid) — §34", () => {
    const rng = createRng(1);
    const buyer = makeAIClub(1);
    const seller = makeAIClub(2);
    const nobody = player(rng, buyer, 1, { position: 3, overall: 40, age: 24, contractDays: 30 });
    const world = squadWorld(buyer, [nobody]);
    world.clubs.push(seller);
    const gk = player(rng, seller, 2, { position: 0, overall: 80, age: 24, value: 20_000_000, salary: 2_000_000, contractDays: 30 });
    gk.clubId = seller.id;
    world.players.push(gk);
    const listing = listingFor(world, seller, gk);

    const first = evaluateAndBidOnce(world, buyer, listing, { buyerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(first.ok).toBe(true);
    const bidCountAfterFirst = world.marketBids.filter((b) => b.listingId === listing.id).length;

    const second = evaluateAndBidOnce(world, buyer, listing, { buyerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(second.ok).toBe(false);
    expect(world.marketBids.filter((b) => b.listingId === listing.id).length).toBe(bidCountAfterFirst);
  });

  it("records a PASS when there is no need, and never bids", () => {
    const rng = createRng(1);
    const buyer = makeAIClub(1);
    const seller = makeAIClub(2);
    // Buyer already has a strong, deep midfield.
    const p1 = player(rng, buyer, 1, { position: 3, overall: 78, age: 24, starter: true, contractDays: 30 });
    const p2 = player(rng, buyer, 2, { position: 3, overall: 76, age: 25, contractDays: 30 });
    const p3 = player(rng, buyer, 3, { position: 3, overall: 74, age: 26, contractDays: 30 });
    const world = squadWorld(buyer, [p1, p2, p3]);
    world.clubs.push(seller);
    const target = player(rng, seller, 4, { position: 3, overall: 75, age: 24, value: 10_000_000, salary: 1_500_000, contractDays: 30 });
    target.clubId = seller.id;
    world.players.push(target);
    const listing = listingFor(world, seller, target);

    const result = evaluateAndBidOnce(world, buyer, listing, { buyerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.recorded).toBe(true);
    expect(world.marketBids.filter((b) => b.listingId === listing.id).length).toBe(0);
    const evalRow = world.aiEvaluations.find((e) => e.listingId === listing.id && e.clubId === buyer.id);
    expect(evalRow).toBeDefined();
    expect(evalRow!.decision).toBe("PASS");
  });
});

describe("runAiBuying (§33/§34)", () => {
  it("lets a needful AI club bid on an active listing and rotates deterministically", () => {
    const rng = createRng(1);
    const buyer = makeAIClub(1);
    const seller = makeAIClub(2);
    const nobody = player(rng, buyer, 1, { position: 0, overall: 40, age: 24, contractDays: 30 });
    const world = squadWorld(buyer, [nobody]);
    world.clubs.push(seller);
    const gk = player(rng, seller, 2, { position: 0, overall: 82, age: 24, value: 30_000_000, salary: 3_000_000, contractDays: 30 });
    gk.clubId = seller.id;
    world.players.push(gk);
    const created = createTransferAuction(world, { player: gk, sellerClub: seller, sellerDivision: 1, totalDivisions: 3, now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);

    const bids = runAiBuying(world, {
      divisionByClub: new Map([[buyer.id, 1], [seller.id, 2]]),
      totalDivisions: 3,
      now: 1_700_000_000_000,
      maxClubs: 10,
    });
    expect(bids.length).toBe(1);
    expect(bids[0].clubId).toBe(buyer.id);
    expect(bids[0].listingId).toBe(created.listing.id);
    expect(bids[0].bid).toBeGreaterThan(0);
  });
});
