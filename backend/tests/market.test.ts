import { describe, it, expect } from "vitest";
import {
  applyMaxBid,
  auctionOpeningRange,
  bidIncrementForValue,
  calculateCurrentPrice,
  cancelTransferAuction,
  clubTransferCapMultiplier,
  createTransferAuction,
  determineLeader,
  expireDueListings,
  extendDeadline,
  maximumAllowedBid,
  onePayrollCycleReserve,
  recentTradeBaseValue,
  reconcileListingsAtRollover,
  recordTransaction,
  releaseAllReservations,
  resolveOpeningPrice,
  safeMarketBudget,
  settleDueTransferAuctions,
  settleTransferAuction,
  transferAuctionView,
  transferCooldownError,
  upsertReservation,
  validateMaxBid,
} from "../src/game/market";
import { MARKET_CONFIG } from "../src/config";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, TransferAuction, World } from "../src/game/types";
import { makeWorld } from "./helpers";

function makeClub(id: number, overrides: Partial<Club> = {}): Club {
  return {
    id,
    name: `Club ${id}`,
    shortName: `C${id}`,
    ownerUserId: id === 1 ? 1 : null,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    level: 20,
    highestDivision: 1,
    cash: 10_000_000,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}

function makeWorldWithClubs(clubs: Club[]): World {
  return makeWorld(clubs, []);
}

describe("auction listing rules (§9/§64.1)", () => {
  it("defaults the opening price to the base value (player.value with no history)", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorldWithClubs([club]);

    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No history → base = player.value → default opening = max of range (100%).
    expect(result.listing.openingPrice).toBe(10_000_000);
    expect(player.onSale).toBe(true);
  });

  it("lets the seller choose an opening price within the base-value range (§64.1)", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorldWithClubs([club]);

    const { min, max } = auctionOpeningRange(world, player);
    expect(min).toBe(Math.round(10_000_000 * MARKET_CONFIG.auctionOpeningRange.minValueRatio));
    expect(max).toBe(10_000_000);

    const result = createTransferAuction(world, {
      player,
      sellerClub: club,
      sellerDivision: 1,
      totalDivisions: 3,
      openingPrice: 8_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.openingPrice).toBe(8_000_000);
  });

  it("rejects a seller opening price outside the base-value range (§64.1)", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorldWithClubs([club]);

    const { min, max } = auctionOpeningRange(world, player);
    expect(resolveOpeningPrice(world, player, min - 500_000).ok).toBe(false);
    expect(resolveOpeningPrice(world, player, max + 500_000).ok).toBe(false);
    expect(resolveOpeningPrice(world, player, min).ok).toBe(true);
    expect(resolveOpeningPrice(world, player, max).ok).toBe(true);
  });

  it("bases the opening range on the player's recent trade price when recently traded (§48)", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.value = 5_000_000;
    const world = makeWorldWithClubs([club]);
    // Round 1 is played on day 1; round 3 is played on day 5 (interval 2).
    world.dayIndex = 5;
    // The player was signed cheaply from free agency in round 1 (matchday 1).
    recordTransaction(world, {
      playerId: player.id,
      listingId: 500,
      type: "FREE_AGENT_SIGNING",
      fromClubId: null,
      toClubId: club.id,
      price: 500_000,
      seasonId: world.mp.seasonId,
      seasonKey: "2026-01",
      matchday: 1,
      timestamp: 1_700_000_000_000,
    });

    const base = recentTradeBaseValue(world, player);
    // roundForDay(5) = round 3; roundForDay(1) = round 1; gamesSinceTrade = 2.
    // t = 2/6 → base = 500K + 4.5M × (2/6) = 2M.
    const expected = 500_000 + (5_000_000 - 500_000) * (2 / 6);
    expect(base).toBeCloseTo(expected, 0);

    const range = auctionOpeningRange(world, player);
    expect(range.min).toBeLessThan(3_000_000); // far below the full-value min
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3, openingPrice: range.min });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.openingPrice).toBe(range.min);
  });

  it("returns the full player.value base after the fade window elapses (§48)", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.value = 5_000_000;
    const world = makeWorldWithClubs([club]);
    // Round 20 > fade window (6): day 1 + (20-1)*2 = 39, but days are 1..30.
    // Use completedRounds fallback by setting dayIndex off-cadence? Instead
    // pick a day past the fade window within the month: round 15 = day 29.
    world.dayIndex = 29;
    recordTransaction(world, {
      playerId: player.id,
      listingId: 500,
      type: "FREE_AGENT_SIGNING",
      fromClubId: null,
      toClubId: club.id,
      price: 500_000,
      seasonId: world.mp.seasonId,
      seasonKey: "2026-01",
      matchday: 1,
      timestamp: 1_700_000_000_000,
    });

    const base = recentTradeBaseValue(world, player);
    // roundForDay(29) = (29-1)/2 + 1 = 15 ≥ 6 → full player.value.
    expect(base).toBe(5_000_000);
  });

  it("rejects youth players, non-squad players, and duplicate active listings", () => {
    const rng = createRng(1);
    const club = makeClub(1, { cash: 50_000_000 });
    const other = makeClub(2);
    const world = makeWorldWithClubs([club, other]);

    const youth = generatePlayer(rng, club, { id: 1, isYouth: true });
    expect(createTransferAuction(world, { player: youth, sellerClub: club, sellerDivision: 1, totalDivisions: 3 }).ok).toBe(false);

    const outsider = generatePlayer(rng, other, { id: 2, isYouth: false });
    expect(createTransferAuction(world, { player: outsider, sellerClub: club, sellerDivision: 1, totalDivisions: 3 }).ok).toBe(false);

    const senior = generatePlayer(rng, club, { id: 3, isYouth: false });
    const first = createTransferAuction(world, { player: senior, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = createTransferAuction(world, { player: senior, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toMatch(/active market listing/i);
  });

  it("rejects a listing that would cross the season rollover boundary", () => {
    const rng = createRng(1);
    const club = makeClub(1);
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    const world = makeWorldWithClubs([club]);
    const now = 1_700_000_000_000;
    const rolloverAt = now + 60 * 60 * 1000; // 1h away, but auction needs 24h
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3, now, seasonRolloverAt: rolloverAt });
    expect(result.ok).toBe(false);
  });
});

describe("proxy bidding (§11-14)", () => {
  it("keeps the current price at opening until at least two maximums exist", () => {
    expect(calculateCurrentPrice({ openingPrice: 100, bidIncrement: 10, bids: [] })).toBe(100);
    expect(calculateCurrentPrice({ openingPrice: 100, bidIncrement: 10, bids: [{ maxBid: 150 }] })).toBe(100);
    expect(
      calculateCurrentPrice({ openingPrice: 100, bidIncrement: 10, bids: [{ maxBid: 150 }, { maxBid: 120 }] })
    ).toBe(130); // second-highest + increment, capped by highest
  });

  it("clears at second-highest + increment, never the leader's full max", () => {
    const price = calculateCurrentPrice({
      openingPrice: 8_500_000,
      bidIncrement: 100_000,
      bids: [
        { maxBid: 10_000_000 },
        { maxBid: 12_000_000 },
        { maxBid: 9_500_000 },
      ],
    });
    expect(price).toBe(10_100_000);
  });

  it("resolves equal maximums in favour of the earliest submission (§13)", () => {
    const leader = determineLeader([
      { clubId: 1, maxBid: 10_000_000, initialPriorityAt: 100 },
      { clubId: 2, maxBid: 10_000_000, initialPriorityAt: 200 },
    ]);
    expect(leader).toBe(1);
  });

  it("picks the highest maximum regardless of order", () => {
    const leader = determineLeader([
      { clubId: 1, maxBid: 9_000_000, initialPriorityAt: 100 },
      { clubId: 2, maxBid: 11_000_000, initialPriorityAt: 200 },
    ]);
    expect(leader).toBe(2);
  });

  it("scales the bid increment with player value (§14)", () => {
    const small = bidIncrementForValue(500_000);
    const big = bidIncrementForValue(20_000_000);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(big);
    expect(big).toBeLessThanOrEqual(round(20_000_000 * 0.01));
  });
});

describe("bidder-specific cap (§10/§102.13.3)", () => {
  it("stays at the 150% baseline for same-division or weaker-division buyers", () => {
    // Same division, 3-division pyramid.
    expect(clubTransferCapMultiplier(2, 2, 3)).toBeCloseTo(1.5, 5);
    // Weaker division buying from a stronger division: favorableGap = 0.
    expect(clubTransferCapMultiplier(3, 1, 3)).toBeCloseTo(1.5, 5);
    expect(clubTransferCapMultiplier(2, 1, 3)).toBeCloseTo(1.5, 5);
  });

  it("relaxes smoothly for a stronger-division buyer, reaching exactly 300% at the max gap", () => {
    // D1 buys from D3 in a 3-division pyramid: normalizedGap = 1 => curve = 1.
    expect(clubTransferCapMultiplier(1, 3, 3)).toBeCloseTo(3.0, 5);
    // D1 buys from D2: normalizedGap = 0.5 => partial relaxation.
    const halfway = clubTransferCapMultiplier(1, 2, 3);
    expect(halfway).toBeGreaterThan(1.5);
    expect(halfway).toBeLessThan(3.0);
    // Diminishing returns: a larger gap increases the cap but never past 3.0.
    expect(clubTransferCapMultiplier(1, 3, 10)).toBeLessThan(3.0);
    // A 2-gap in a 10-division pyramid (norm 2/9) relaxes less than a 1-gap in
    // a 3-division pyramid (norm 1/2): deeper pyramids dilute the same gap.
    expect(clubTransferCapMultiplier(1, 3, 10)).toBeLessThan(halfway);
    expect(clubTransferCapMultiplier(1, 3, 10)).toBeGreaterThan(1.5);
  });

  it("adapts to pyramid depth: same absolute gap normalizes differently", () => {
    // 2-division gap in a 3-division pyramid reaches the 300% ceiling...
    expect(clubTransferCapMultiplier(1, 3, 3)).toBeCloseTo(3.0, 5);
    // ...but in a 10-division pyramid the same gap is only ~1/9 of the way.
    const deep = clubTransferCapMultiplier(1, 3, 10);
    expect(deep).toBeGreaterThan(1.5);
    expect(deep).toBeLessThan(3.0);
  });

  it("matches the §102.13.3 ten-division pyramid examples", () => {
    const cap = (buyer: number, seller: number) => clubTransferCapMultiplier(buyer, seller, 10);
    // D2 buys from D2: gap = 0.
    expect(cap(2, 2)).toBeCloseTo(1.5, 5);
    // D2 buys from D3: gap = 1/9 -> ~184%.
    expect(cap(2, 3)).toBeGreaterThan(1.5);
    expect(cap(2, 3)).toBeCloseTo(1.85, 1);
    // D2 buys from D5: gap = 3/9 -> ~235%.
    expect(cap(2, 5)).toBeCloseTo(2.34, 1);
    // D1 buys from D10: gap = 9/9 -> 300%.
    expect(cap(1, 10)).toBeCloseTo(3.0, 5);
    // D5 buys from D1: favorableGap = 0 -> 150%.
    expect(cap(5, 1)).toBeCloseTo(1.5, 5);
  });

  it("caps a max bid by min(value cap, safe market budget)", () => {
    // D1 buys from D3 (3-division pyramid) => 3.0× value cap.
    const cap = maximumAllowedBid(10_000_000, 1, 3, 3, 50_000_000);
    expect(cap).toBeCloseTo(30_000_000, 0);
    // Safe budget binds below the value cap.
    const tight = maximumAllowedBid(10_000_000, 2, 2, 3, 8_000_000);
    expect(tight).toBe(8_000_000);
  });
});

describe("maximum bid validation (§15/§19/§21/§24)", () => {
  function listing(opts: Partial<TransferAuction> = {}): TransferAuction {
    return {
      id: 1,
      playerId: 1,
      sellerClubId: 10,
      playerValueAtListing: 10_000_000,
      openingPrice: 8_500_000,
      bidIncrement: 100_000,
      sellerDivisionAtListing: 1,
      totalDivisionsAtListing: 3,
      currentPrice: 8_500_000,
      leadingClubId: null,
      createdAt: 1,
      deadline: 100_000,
      originalDeadline: 100_000,
      status: "ACTIVE",
      completedAt: null,
      winningClubId: null,
      finalPrice: null,
      cancelledAt: null,
      softClosed: false,
      softCloseExtensions: 0,
      ...opts,
    };
  }

  it("rejects the seller, non-positive values, and below-opening first bids", () => {
    const club = makeClub(10);
    const player = { value: 10_000_000 } as World["players"][number];
    const l = listing();

    expect(validateMaxBid({ listing: l, club, player, proposedMaximum: 8_000_000, buyerDivision: 1, safeMarketBudget: 100_000_000 }).ok).toBe(false);
    expect(validateMaxBid({ listing: l, club, player, proposedMaximum: 0, buyerDivision: 1, safeMarketBudget: 100_000_000 }).ok).toBe(false);
  });

  it("rejects decreasing an existing maximum (§19)", () => {
    const club = makeClub(1);
    const player = { value: 10_000_000 } as World["players"][number];
    const l = listing();
    const existing = {
      id: 1, marketType: "TRANSFER" as const, listingId: 1, clubId: 1, maxBid: 12_000_000,
      createdAt: 1, updatedAt: 1, initialPriorityAt: 1,
    };
    const res = validateMaxBid({ listing: l, club, player, proposedMaximum: 11_000_000, buyerDivision: 1, safeMarketBudget: 100_000_000, existingBid: existing });
    expect(res.ok).toBe(false);
  });

  it("rejects maximums above the safe market budget (§24)", () => {
    const club = makeClub(1);
    const player = { value: 10_000_000 } as World["players"][number];
    const l = listing();
    const res = validateMaxBid({ listing: l, club, player, proposedMaximum: 20_000_000, buyerDivision: 1, safeMarketBudget: 15_000_000 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/safe market budget/i);
  });
});

describe("financial validation (§24)", () => {
  it("computes a safe budget from cash minus reservations, acquisition salary, and reserve", () => {
    const club = makeClub(1, { cash: 20_000_000 });
    const world = makeWorld([club], []);
    world.marketReservations.push({
      id: 1, clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 2_000_000, createdAt: 1, releasedAt: null,
    });
    // No squad => annual payroll is 0, so the reserve is also 0.
    const reserve = onePayrollCycleReserve(world, club);
    expect(reserve).toBe(0);
    const budget = safeMarketBudget(world, club, { acquisitionSalary: 5_000_000 });
    expect(budget).toBe(20_000_000 - 2_000_000 - 5_000_000 - 0 - reserve);
  });

  it("is conservative: uncertain income is not counted, only guaranteed income", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    const without = safeMarketBudget(world, club, { guaranteedIncome: 0 });
    const withGuaranteed = safeMarketBudget(world, club, { guaranteedIncome: 5_000_000 });
    expect(withGuaranteed).toBe(without + 5_000_000);
  });

  it("returns 0 when the club cannot cover its reserve", () => {
    const rng = createRng(3);
    const club = makeClub(1, { cash: 1_000_000 });
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    player.salary = 5_000_000; // huge wage bill => reserve exceeds cash
    const world = makeWorld([club], [player]);
    expect(onePayrollCycleReserve(world, club)).toBeGreaterThan(club.cash);
    expect(safeMarketBudget(world, club)).toBe(0);
  });
});

describe("reservations (§23/§73)", () => {
  it("upserts one durable reservation per club/listing and releases on settlement", () => {
    const world = makeWorldWithClubs([]);
    const r1 = upsertReservation(world, { clubId: 1, listingId: 5, marketType: "TRANSFER", amount: 1_000_000 });
    const r2 = upsertReservation(world, { clubId: 1, listingId: 5, marketType: "TRANSFER", amount: 2_000_000 });
    expect(r1.id).toBe(r2.id);
    expect(r2.amount).toBe(2_000_000);
    expect(world.marketReservations).toHaveLength(1);

    releaseAllReservations(world, 5, "TRANSFER");
    expect(world.marketReservations[0].releasedAt).not.toBeNull();
  });

  it("a club's active reservations reduce its safe budget", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    upsertReservation(world, { clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 4_000_000 });
    upsertReservation(world, { clubId: 1, listingId: 2, marketType: "TRANSFER", amount: 3_000_000 });
    expect(safeMarketBudget(world, club)).toBe(10_000_000 - 7_000_000);
  });
});

describe("applyMaxBid integration", () => {
  function setupWorld() {
    const rng = createRng(7);
    const seller = makeClub(10, { cash: 10_000_000 });
    const buyer = makeClub(1, { cash: 30_000_000, isHuman: true });
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorld([seller, buyer], [player], { dayIndex: 5 });
    world.mpClubSeasons = [
      { clubId: 10, seasonId: 1, divisionId: 1, tier: 1, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0, promotionStatus: "NONE", relegationStatus: "NONE" },
      { clubId: 1, seasonId: 1, divisionId: 1, tier: 1, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0, promotionStatus: "NONE", relegationStatus: "NONE" },
    ];
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    return { world, seller, buyer, player, listing: created.listing };
  }

  it("places a private maximum, updates the proxy state, and reserves funds", () => {
    const { world, buyer, player, listing } = setupWorld();
    const res = applyMaxBid(world, {
      listing,
      club: buyer,
      player,
      proposedMaximum: 12_000_000,
      buyerDivision: 1,
      safeMarketBudget: 20_000_000,
      now: 1_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leading).toBe(true);
    expect(world.marketBids).toHaveLength(1);
    expect(world.marketBids[0].maxBid).toBe(12_000_000);
    // The reserved amount equals the private maximum (§23).
    expect(world.marketReservations[0].amount).toBe(12_000_000);
    // Public view never exposes competing maximums (§15).
    const view = transferAuctionView(world, listing, buyer.id);
    expect(view.myMaxBid).toBe(12_000_000);
    expect(view.currentPrice).toBe(listing.openingPrice); // single bid
    expect(view.bidderCount).toBe(1);
    expect(view.amILeading).toBe(true);
  });

  it("a second higher max flips the leader and releases the loser's reservation", () => {
    const { world, buyer, seller, player, listing } = setupWorld();
    const buyer2 = makeClub(2, { cash: 40_000_000, isHuman: true });
    world.clubs.push(buyer2);

    applyMaxBid(world, { listing, club: buyer, player, proposedMaximum: 10_000_000, buyerDivision: 1, safeMarketBudget: 20_000_000, now: 1_000 });
    const second = applyMaxBid(world, { listing, club: buyer2, player, proposedMaximum: 11_000_000, buyerDivision: 1, safeMarketBudget: 30_000_000, now: 2_000 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.leading).toBe(true);
    expect(listing.leadingClubId).toBe(buyer2.id);
    // Loser's reservation released; winner reserves its own max.
    expect(world.marketReservations.filter((r) => r.clubId === buyer.id && r.releasedAt !== null)).toHaveLength(1);
    expect(world.marketReservations.find((r) => r.clubId === buyer2.id)?.amount).toBe(11_000_000);
  });

  it("clears at second-highest + increment when three clubs compete", () => {
    const { world, buyer, seller, player, listing } = setupWorld();
    const c2 = makeClub(2, { cash: 40_000_000, isHuman: true });
    const c3 = makeClub(3, { cash: 40_000_000, isHuman: true });
    world.clubs.push(c2, c3);

    applyMaxBid(world, { listing, club: buyer, player, proposedMaximum: 10_000_000, buyerDivision: 1, safeMarketBudget: 30_000_000, now: 1_000 });
    applyMaxBid(world, { listing, club: c2, player, proposedMaximum: 12_000_000, buyerDivision: 1, safeMarketBudget: 30_000_000, now: 2_000 });
    applyMaxBid(world, { listing, club: c3, player, proposedMaximum: 9_500_000, buyerDivision: 1, safeMarketBudget: 30_000_000, now: 3_000 });

    expect(listing.currentPrice).toBe(10_100_000); // 10M + increment
    expect(listing.leadingClubId).toBe(c2.id);
  });

  it("rejects bids after the deadline and cannot be decreased", () => {
    const { world, buyer, player, listing } = setupWorld();
    listing.deadline = 500;
    const late = applyMaxBid(world, { listing, club: buyer, player, proposedMaximum: 12_000_000, buyerDivision: 1, safeMarketBudget: 30_000_000, now: 600 });
    expect(late.ok).toBe(false);
  });
});

describe("soft close (§18)", () => {
  function baseListing(): TransferAuction {
    return {
      id: 1, playerId: 1, sellerClubId: 10, playerValueAtListing: 10_000_000, openingPrice: 8_500_000,
      bidIncrement: 100_000, sellerDivisionAtListing: 1, totalDivisionsAtListing: 3, currentPrice: 8_500_000,
      leadingClubId: null, createdAt: 1, deadline: 10_000, originalDeadline: 10_000, status: "ACTIVE",
      completedAt: null, winningClubId: null, finalPrice: null, cancelledAt: null, softClosed: false,
      softCloseExtensions: 0,
    };
  }

  it("extends the deadline only on a leader or price change", () => {
    const listing = baseListing();
    const unchanged = extendDeadline({
      listing, previousLeader: null, previousPrice: 8_500_000, newLeader: null, newPrice: 8_500_000, now: 9_000,
    });
    expect(unchanged).toBe(listing.deadline);

    const extended = extendDeadline({
      listing, previousLeader: null, previousPrice: 8_500_000, newLeader: 1, newPrice: 9_000_000, now: 9_000,
    });
    // Extension is measured from the listing's deadline (§18: 15:00 -> 15:03).
    expect(extended).toBe(listing.deadline + MARKET_CONFIG.transferAuction.extensionMinutes * 60_000);
  });

  it("does not let a leader extend repeatedly beyond the maximum window", () => {
    const listing = baseListing();
    // 30min cap / 5min per extension => 6 extensions max.
    listing.softCloseExtensions = 6;
    const capped = extendDeadline({
      listing, previousLeader: 1, previousPrice: 9_000_000, newLeader: 2, newPrice: 9_100_000, now: 9_500,
    });
    expect(capped).toBe(listing.deadline);
  });

  it("caps the deadline at season rollover for club-to-club auctions", () => {
    const listing = baseListing();
    const capped = extendDeadline({
      listing, previousLeader: null, previousPrice: 8_500_000, newLeader: 1, newPrice: 9_000_000,
      now: 9_000, seasonRolloverAt: 9_000 + 60_000,
    });
    expect(capped).toBe(9_000 + 60_000);
  });
});

describe("listing cancellation (§20)", () => {
  it("allows cancellation before any bid and clears the player flag", () => {
    const rng = createRng(1);
    const club = makeClub(1);
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    const world = makeWorld([club], [player]);
    const created = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    upsertReservation(world, { clubId: 2, listingId: listing.id, marketType: "TRANSFER", amount: 100 });
    const cancelled = cancelTransferAuction(world, listing);
    expect(cancelled.ok).toBe(true);
    expect(listing.status).toBe("CANCELLED");
    expect(player.onSale).toBe(false);
    expect(world.marketReservations.every((r) => r.releasedAt !== null)).toBe(true);
  });

  it("rejects cancellation after a valid bid", () => {
    const rng = createRng(1);
    const seller = makeClub(10);
    const club = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorld([seller, club], [player]);
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const bid = applyMaxBid(world, { listing, club, player, proposedMaximum: 10_500_000, buyerDivision: 1, safeMarketBudget: 50_000_000 });
    expect(bid.ok).toBe(true);
    expect(cancelTransferAuction(world, listing).ok).toBe(false);
  });
});

describe("due listing expiry (§77)", () => {
  it("cancels no-bid listings past deadline, releasing reservations and clearing onSale", () => {
    const rng = createRng(2);
    const club = makeClub(1);
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    const world = makeWorld([club], [player]);
    const created = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    listing.deadline = 100;

    const resolved = expireDueListings(world, 200);
    expect(resolved).toBe(1);
    expect(listing.status).toBe("CANCELLED");
    expect(player.onSale).toBe(false);
  });

  it("leaves listings with bids for Phase 3 settlement", () => {
    const rng = createRng(3);
    const seller = makeClub(10);
    const buyer = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorld([seller, buyer], [player]);
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    applyMaxBid(world, { listing, club: buyer, player, proposedMaximum: 10_500_000, buyerDivision: 1, safeMarketBudget: 50_000_000 });
    listing.deadline = 100;

    const resolved = expireDueListings(world, 200);
    expect(resolved).toBe(0);
    expect(listing.status).toBe("ACTIVE");
    expect(player.onSale).toBe(true);
  });
});

describe("rollover reconciliation (§17/§102.9)", () => {
  it("cancels all active transfer listings at rollover, releasing reservations", () => {
    const rng = createRng(21);
    const seller = makeClub(10);
    const buyer = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    player.value = 10_000_000;
    const world = makeWorld([seller, buyer], [player]);
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    applyMaxBid(world, { listing, club: buyer, player, proposedMaximum: 10_500_000, buyerDivision: 1, safeMarketBudget: 50_000_000 });
    expect(world.marketReservations.filter((r) => r.releasedAt === null)).toHaveLength(1);

    const cancelled = reconcileListingsAtRollover(world, 5000);
    expect(cancelled).toBe(1);
    expect(listing.status).toBe("CANCELLED");
    expect(player.onSale).toBe(false);
    expect(world.marketReservations.every((r) => r.releasedAt !== null)).toBe(true);
    // No money or ownership moves (§17.4).
    expect(player.clubId).toBe(seller.id);
    expect(seller.cash + buyer.cash).toBe(20_000_000);
    expect(world.playerMarketHistory).toHaveLength(0);
  });
});

describe("market history (§72)", () => {
  it("records permanent acquisitions that feed the resale anchor, and keeps loans audit-only", () => {
    const world = makeWorldWithClubs([]);
    recordTransaction(world, {
      playerId: 1, listingId: 5, type: "TRANSFER", fromClubId: 1, toClubId: 2, price: 8_000_000,
      seasonId: 1, seasonKey: "2026-01", matchday: 3, timestamp: 100,
    });
    recordTransaction(world, {
      playerId: 1, listingId: null, type: "LOAN", fromClubId: 2, toClubId: 3, price: 0,
      seasonId: 1, seasonKey: "2026-01", matchday: 10, timestamp: 200,
    });
    const permanent = world.playerMarketHistory.filter((t) => t.type !== "LOAN");
    expect(permanent).toHaveLength(1);
    expect(permanent[0].price).toBe(8_000_000);
    expect(world.playerMarketHistory).toHaveLength(2);
  });
});

describe("settlement (§22)", () => {
  function setupWorldWithBids() {
    const rng = createRng(11);
    const seller = makeClub(10, { cash: 10_000_000 });
    const buyerA = makeClub(1, { cash: 30_000_000, isHuman: true });
    const buyerB = makeClub(2, { cash: 30_000_000 });
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    player.value = 10_000_000;
    player.salary = 500_000;
    const world = makeWorld([seller, buyerA, buyerB], [player], { dayIndex: 5 });
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    applyMaxBid(world, { listing, club: buyerA, player, proposedMaximum: 10_000_000, buyerDivision: 1, safeMarketBudget: 20_000_000, now: 100 });
    applyMaxBid(world, { listing, club: buyerB, player, proposedMaximum: 12_000_000, buyerDivision: 1, safeMarketBudget: 25_000_000, now: 200 });
    return { world, seller, buyerA, buyerB, player, listing };
  }

  it("settles atomically: winner pays clearing price, seller credited, contract preserved", () => {
    const { world, seller, buyerA, buyerB, player, listing } = setupWorldWithBids();
    const sellerCash = seller.cash;
    const buyerACash = buyerA.cash;
    const buyerBCash = buyerB.cash;
    const salaryBefore = player.salary;
    const contractDaysBefore = player.contractDays;
    const now = listing.deadline + 1;

    const result = settleTransferAuction(world, listing, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.winnerClubId).toBe(buyerB.id);
    // Clearing price = second-highest (10M) + increment, capped by highest (12M).
    expect(result.finalPrice).toBe(10_000_000 + listing.bidIncrement);
    expect(result.finalPrice).toBeLessThan(12_000_000);

    // Cash: winner pays clearing price. The seller is first charged the
    // player's accrued payroll through dayIndex (5 days of a 500K wage),
    // then receives the clearing price.
    const accruedPayroll = Math.round((player.salary * world.dayIndex) / 30);
    expect(buyerB.cash).toBe(buyerBCash - result.finalPrice!);
    expect(seller.cash).toBe(sellerCash - accruedPayroll + result.finalPrice!);
    // Loser pays nothing.
    expect(buyerA.cash).toBe(buyerACash);

    // Ownership + contract preserved (§27).
    expect(player.clubId).toBe(buyerB.id);
    expect(player.salary).toBe(salaryBefore);
    expect(player.contractDays).toBe(contractDaysBefore);
    expect(player.onSale).toBe(false);

    // Ledger: one income (seller), one expense (winner).
    expect(seller.ledger.income.filter((e) => e.code === 3 && e.label.includes(player.name))).toHaveLength(1);
    expect(buyerB.ledger.expense.filter((e) => e.code === 1 && e.label.includes(player.name))).toHaveLength(1);
    expect(buyerA.ledger.expense.filter((e) => e.code === 1)).toHaveLength(0);

    // Listing marked complete; winner recorded.
    expect(listing.status).toBe("COMPLETED");
    expect(listing.winningClubId).toBe(buyerB.id);
    expect(listing.finalPrice).toBe(result.finalPrice);
    expect(listing.completedAt).toBe(now);

    // All reservations released (§23).
    expect(world.marketReservations.every((r) => r.releasedAt !== null)).toBe(true);

    // History recorded.
    expect(world.playerMarketHistory).toHaveLength(1);
    expect(world.playerMarketHistory[0].type).toBe("TRANSFER");
    expect(world.playerMarketHistory[0].toClubId).toBe(buyerB.id);
    expect(world.playerMarketHistory[0].price).toBe(result.finalPrice);

    // News published.
    expect(world.news.some((n) => n.kind === "auction" && n.text.includes(player.name))).toBe(true);
  });

  it("does not double-settle: a completed listing is skipped", () => {
    const { world, listing } = setupWorldWithBids();
    const now = listing.deadline + 1;
    const result = settleTransferAuction(world, listing, now);
    expect(result.ok).toBe(true);
    const second = settleTransferAuction(world, listing, now + 1);
    expect(second.ok).toBe(false);
    // Money moved exactly once.
    expect(world.playerMarketHistory).toHaveLength(1);
  });

  it("settles a no-bid listing as cancelled without moving money", () => {
    const rng = createRng(12);
    const seller = makeClub(10);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    const world = makeWorld([seller], [player]);
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const cash = seller.cash;
    const result = settleTransferAuction(world, listing, listing.deadline + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.winnerClubId).toBeNull();
    expect(listing.status).toBe("CANCELLED");
    expect(seller.cash).toBe(cash);
    expect(player.clubId).toBe(seller.id);
    expect(player.onSale).toBe(false);
  });

  it("settles due listings via settleDueTransferAuctions and skips non-due ones", () => {
    const { world, listing } = setupWorldWithBids();
    // Not yet due: nothing settles.
    expect(settleDueTransferAuctions(world, listing.deadline - 1)).toBe(0);
    expect(world.playerMarketHistory).toHaveLength(0);
    // Due: settles.
    expect(settleDueTransferAuctions(world, listing.deadline + 1)).toBe(1);
    expect(world.playerMarketHistory).toHaveLength(1);
  });
});

describe("transfer cooldown (§53)", () => {
  it("blocks same-season club-to-club relisting", () => {
    const rng = createRng(13);
    const seller = makeClub(10);
    const buyer = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    const world = makeWorld([seller, buyer], [player], { dayIndex: 5 });
    world.mp.seasonId = 3;
    recordTransaction(world, {
      playerId: 1, listingId: 99, type: "TRANSFER", fromClubId: 10, toClubId: 1, price: 5_000_000,
      seasonId: 3, seasonKey: "2026-03", matchday: 2, timestamp: 1,
    });
    expect(transferCooldownError(world, player)).toMatch(/cannot be listed again/);
  });

  it("allows free-agent signings to be listed immediately", () => {
    const rng = createRng(14);
    const seller = makeClub(10);
    const buyer = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    const world = makeWorld([seller, buyer], [player], { dayIndex: 5 });
    world.mp.seasonId = 3;
    recordTransaction(world, {
      playerId: 1, listingId: 99, type: "FREE_AGENT_SIGNING", fromClubId: null, toClubId: 1, price: 2_000_000,
      seasonId: 3, seasonKey: "2026-03", matchday: 2, timestamp: 1,
    });
    expect(transferCooldownError(world, player)).toBeNull();
  });

  it("allows relisting a player acquired in a previous season", () => {
    const rng = createRng(15);
    const seller = makeClub(10);
    const buyer = makeClub(1);
    const player = generatePlayer(rng, seller, { id: 1, isYouth: false });
    const world = makeWorld([seller, buyer], [player], { dayIndex: 5 });
    world.mp.seasonId = 4;
    recordTransaction(world, {
      playerId: 1, listingId: 99, type: "TRANSFER", fromClubId: 10, toClubId: 1, price: 5_000_000,
      seasonId: 3, seasonKey: "2026-03", matchday: 2, timestamp: 1,
    });
    expect(transferCooldownError(world, player)).toBeNull();
  });

  it("blocks createTransferAuction for a cooling-down player", () => {
    const rng = createRng(16);
    const club = makeClub(1);
    const player = generatePlayer(rng, club, { id: 1, isYouth: false });
    const world = makeWorld([club], [player], { dayIndex: 5 });
    world.mp.seasonId = 3;
    recordTransaction(world, {
      playerId: 1, listingId: 99, type: "TRANSFER", fromClubId: 10, toClubId: 1, price: 5_000_000,
      seasonId: 3, seasonKey: "2026-03", matchday: 2, timestamp: 1,
    });
    const result = createTransferAuction(world, { player, sellerClub: club, sellerDivision: 1, totalDivisions: 3 });
    expect(result.ok).toBe(false);
  });
});

function round(n: number): number {
  return Math.round(n / 50_000) * 50_000;
}
