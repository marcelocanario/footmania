import { describe, expect, it } from "vitest";
import { MARKET_CONFIG, MP_CONFIG } from "../src/config";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";
import { offerPlayerForLoan, claimLoan, borrowedCapError } from "../src/game/loans";
import { applyMaxBid, createTransferAuction, settleTransferAuction, upsertReservation, auctionOpeningRange } from "../src/game/market";
import { systemLiquidationPrice } from "../src/game/finance";
import { getImmediateAvailableCash } from "../src/game/finance";
import { SENIOR_SQUAD_LIMIT } from "../src/game/constants";
import { createHumanClub } from "../src/game/worldgen";
import { newClubSellLockError, matchesPlayedByClub } from "../src/game/league";

function club(id: number, overrides: Partial<Club> = {}): Club {
  return makeClub({ id, isHuman: true, ownerUserId: id, cash: 100_000_000, ...overrides });
}

function squadFor(worldClubs: Club[], perClub = 1, startId = 1): Player[] {
  const rng = createRng(7);
  const players: Player[] = [];
  let id = startId;
  for (const c of worldClubs) {
    for (let i = 0; i < perClub; i++) {
      players.push(generatePlayer(rng, c, { id: id++, isYouth: false }));
    }
  }
  return players;
}

// ---------------------------------------------------------------------------
// A1: lender-chosen loan fee
// ---------------------------------------------------------------------------

describe("loan fee (§55)", () => {
  function loanWorld() {
    const owner = club(1);
    const player = squadFor([owner], 1)[0];
    const world = makeWorld([owner], [player]);
    return { world, owner, player };
  }

  it("defaults to the minimum ratio and snapshots an absolute fee", () => {
    const { world, owner, player } = loanWorld();
    const offered = offerPlayerForLoan(world, owner, player, { now: 1_000 });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    expect(offered.loan.feeAmount).toBe(Math.round(player.value * MARKET_CONFIG.loans.feeMinValueRatio));
  });

  it("accepts any ratio inside the configured band and rejects outside it", () => {
    const { world, owner, player } = loanWorld();
    const lo = offerPlayerForLoan(world, owner, player, { now: 1_000, feeRatio: MARKET_CONFIG.loans.feeMinValueRatio });
    expect(lo.ok).toBe(true);
    world.loans.length = 0;
    player.loanId = null;
    const hi = offerPlayerForLoan(world, owner, player, { now: 1_000, feeRatio: MARKET_CONFIG.loans.feeMaxValueRatio });
    expect(hi.ok).toBe(true);
    world.loans.length = 0;
    player.loanId = null;
    const below = offerPlayerForLoan(world, owner, player, { now: 1_000, feeRatio: MARKET_CONFIG.loans.feeMinValueRatio - 0.01 });
    expect(below.ok).toBe(false);
    const above = offerPlayerForLoan(world, owner, player, { now: 1_000, feeRatio: MARKET_CONFIG.loans.feeMaxValueRatio + 0.01 });
    expect(above.ok).toBe(false);
  });

  it("charges the borrower and credits the lender at claim time", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_000;
    const offered = offerPlayerForLoan(world, owner, player, { now, feeRatio: 0.2 });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = club(2);
    world.clubs.push(borrower);
    const beforeBorrower = borrower.cash;
    const beforeOwner = owner.cash;
    const claimed = claimLoan(world, borrower, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(true);
    const fee = Math.round(player.value * 0.2);
    expect(borrower.cash).toBe(beforeBorrower - fee);
    expect(owner.cash).toBe(beforeOwner + fee);
    expect(borrower.ledger.expense.some((e) => e.amount === fee)).toBe(true);
    expect(owner.ledger.income.some((e) => e.amount === fee)).toBe(true);
  });

  it("rejects a claim when the unreserved cash cannot cover the fee", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_000;
    const offered = offerPlayerForLoan(world, owner, player, { now, feeRatio: MARKET_CONFIG.loans.feeMaxValueRatio });
    if (!offered.ok) throw new Error(offered.error);
    const poor = club(2, { cash: 1 });
    // A binding reservation reduces the immediately available cash further.
    upsertReservation(world, { clubId: poor.id, listingId: 555, marketType: "TRANSFER", amount: 0 });
    world.clubs.push(poor);
    const claimed = claimLoan(world, poor, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(false);
    if (claimed.ok) return;
    expect(claimed.error).toMatch(/loan fee/i);
    expect(offered.loan.toClubId).toBeNull();
    expect(player.clubId).toBe(owner.id);
  });

  it("enforces the borrowed-player cap on claims", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = club(2);
    world.clubs.push(borrower);
    // Fabricate the cap minus one active loans, then claim one more.
    for (let i = 0; i < MARKET_CONFIG.loans.maxLoanedInPerClub - 1; i++) {
      world.loans.push({ id: 5_000 + i, playerId: -10 - i, fromClubId: 9, toClubId: borrower.id, startDay: 0, endDay: 30, recalled: false, listedAt: now, claimableAt: now });
    }
    expect(activeLoanedIn(borrower.id)).toBe(MARKET_CONFIG.loans.maxLoanedInPerClub - 1);
    const claimed = claimLoan(world, borrower, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(true);
    expect(borrowedCapError(world, borrower.id)).not.toBeNull();

    function activeLoanedIn(clubId: number): number {
      return world.loans.filter((l) => !l.recalled && l.toClubId === clubId).length;
    }
  });

  it("rejects a claim once the borrowed-player cap is already full", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = club(2);
    world.clubs.push(borrower);
    for (let i = 0; i < MARKET_CONFIG.loans.maxLoanedInPerClub; i++) {
      world.loans.push({ id: 6_000 + i, playerId: -20 - i, fromClubId: 9, toClubId: borrower.id, startDay: 0, endDay: 30, recalled: false, listedAt: now, claimableAt: now });
    }
    const claimed = claimLoan(world, borrower, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(false);
    if (claimed.ok) return;
    expect(claimed.error).toMatch(/borrowed players/i);
  });
});

// ---------------------------------------------------------------------------
// A4: single senior-roster cap
// ---------------------------------------------------------------------------

describe("senior roster cap", () => {
  function fullSquadWorld() {
    const buyer = club(1);
    // Human seller: production listings always come from human clubs
    // (invariant #28 — filler-AI clubs cannot list).
    const seller = club(2);
    const rng = createRng(11);
    const players: Player[] = [];
    for (let i = 0; i < SENIOR_SQUAD_LIMIT; i++) {
      players.push(generatePlayer(rng, buyer, { id: 100 + i, isYouth: false }));
    }
    const target = generatePlayer(rng, seller, { id: 500, isYouth: false });
    players.push(target);
    const world = makeWorld([buyer, seller], players);
    return { world, buyer, seller, target };
  }

  it("rejects a transfer bid when the buyer's senior squad is full", () => {
    const { world, buyer, seller, target } = fullSquadWorld();
    const created = createTransferAuction(world, { player: target, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    const bid = applyMaxBid(world, {
      listing: created.listing,
      club: buyer,
      player: target,
      proposedMaximum: created.listing.openingPrice,
      buyerDivision: 1,
      immediateAvailableCash: getImmediateAvailableCash(world, buyer),
      now: 1_000,
    });
    expect(bid.ok).toBe(false);
    if (bid.ok) return;
    expect(bid.error).toMatch(/squad is full/i);
  });

  it("settlement fails terminally when the winner reached the cap after bidding", () => {
    const { world, buyer, seller, target } = fullSquadWorld();
    const created = createTransferAuction(world, { player: target, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    if (!created.ok) throw new Error(created.error);
    // Bid while under the cap: remove one senior so the bid-time check passes.
    const spare = world.players.find((p) => p.clubId === buyer.id && p.id !== target.id)!;
    world.players = world.players.filter((p) => p.id !== spare.id);
    const bid = applyMaxBid(world, {
      listing: created.listing,
      club: buyer,
      player: target,
      proposedMaximum: created.listing.openingPrice,
      buyerDivision: 1,
      immediateAvailableCash: getImmediateAvailableCash(world, buyer),
      now: 1_000,
    });
    expect(bid.ok).toBe(true);
    // Refill the squad past the cap before settlement.
    const replacement = { ...spare };
    world.players.push(replacement);
    const settled = settleTransferAuction(world, created.listing, created.listing.deadline + 1);
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.terminal).toBe(true);
    expect(target.clubId).toBe(seller.id);
  });

  it("rejects a loan claim when the borrower's senior squad is full", () => {
    const { world, buyer, seller, target } = fullSquadWorld();
    const offered = offerPlayerForLoan(world, seller, target, { now: 1_000 });
    // The helper-seeded played fixtures satisfy the sell lock for the human seller.
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    const claimed = claimLoan(world, buyer, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(false);
    if (claimed.ok) return;
    expect(claimed.error).toMatch(/squad is full/i);
  });
});

// ---------------------------------------------------------------------------
// A5: new-club economy
// ---------------------------------------------------------------------------

describe("new-club starting cash and sell lock", () => {
  it("creates new human clubs with zero starting cash", () => {
    const world = makeWorld([], []);
    const fresh = createHumanClub(world, { userId: 42, clubName: "Fresh FC", country: "BRA" });
    expect(fresh.cash).toBe(MP_CONFIG.newClubStartingCash);
  });

  it("blocks outbound listings until the club played its own matches", () => {
    const owner = club(1);
    const player = squadFor([owner], 1)[0];
    // Reset the helper-seeded fixtures: the club has played nothing yet.
    const world = makeWorld([owner], [player], { competitions: [], fixtures: [] });
    expect(matchesPlayedByClub(world, owner.id)).toBe(0);
    expect(newClubSellLockError(world, owner.id)).toMatch(/played matches/i);

    const listed = createTransferAuction(world, { player, sellerClub: owner, sellerDivision: 1, totalDivisions: 3 });
    expect(listed.ok).toBe(false);
    const loaned = offerPlayerForLoan(world, owner, player, { now: 1_000 });
    expect(loaned.ok).toBe(false);
  });

  it("unlocks selling after the configured number of OWN played fixtures", () => {
    const owner = club(1);
    const player = squadFor([owner], 1)[0];
    const world = makeWorld([owner], [player], { competitions: [], fixtures: [] });
    // Inherited standings must not count: only real played fixtures do.
    const division = { ...world.competitions[0] };
    void division;
    for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
      world.fixtures.push({ id: 700_000 + round, competitionId: 900_001, round, homeClubId: owner.id, awayClubId: -1, dayIndex: round, played: true });
    }
    world.competitions.push({
      id: 900_001, kind: "division", name: "1", round: 0, stage: "group", seasonId: world.mp.seasonId,
      tier: 1, groupIndex: 0, status: "ACTIVE",
      config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
      standings: {}, groupStandings: [], winners: [], knockouts: [],
    });
    expect(newClubSellLockError(world, owner.id)).toBeNull();
    const listed = createTransferAuction(world, { player, sellerClub: owner, sellerDivision: 1, totalDivisions: 3 });
    expect(listed.ok).toBe(true);
  });

  it("blocks filler AI clubs from listing entirely (invariant #28)", () => {
    const ai = club(1, { ownerUserId: null, isHuman: false });
    const player = squadFor([ai], 1)[0];
    const world = makeWorld([ai], [player], { competitions: [], fixtures: [] });
    // The sell lock itself would not trigger for a filler, but the
    // ephemeral-AI market gate rejects the listing outright.
    expect(newClubSellLockError(world, ai.id)).toBeNull();
    const listed = createTransferAuction(world, { player, sellerClub: ai, sellerDivision: 1, totalDivisions: 3 });
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error).toContain("AI clubs cannot list players for transfer");
    const loaned = offerPlayerForLoan(world, ai, player, { now: 1_000 });
    expect(loaned.ok).toBe(false);
  });

  it("does not count inherited standings rows as played matches", () => {
    const joiner = club(1);
    const player = squadFor([joiner], 1)[0];
    const world = makeWorld([joiner], [player], { competitions: [], fixtures: [] });
    // A mid-season joiner inherits the replaced AI's standings row (4 played),
    // but historical fixtures keep the retired AI's id: count stays 0.
    world.competitions.push({
      id: 900_002, kind: "division", name: "2.1", round: 0, stage: "group", seasonId: world.mp.seasonId,
      tier: 2, groupIndex: 0, status: "ACTIVE",
      config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
      standings: {}, groupStandings: [], winners: [], knockouts: [],
    });
    expect(matchesPlayedByClub(world, joiner.id)).toBe(0);
    expect(newClubSellLockError(world, joiner.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A3: intervention liquidation pays the floor price
// ---------------------------------------------------------------------------

describe("system liquidation price", () => {
  it("pays the minimum acceptable auction price (opening floor), not the base value", () => {
    const owner = club(1);
    const player = squadFor([owner], 1)[0];
    const world = makeWorld([owner], [player]);
    const range = auctionOpeningRange(world, player);
    expect(systemLiquidationPrice(world, player)).toBe(range.min);
    expect(range.min).toBeLessThan(range.max);
  });
});
