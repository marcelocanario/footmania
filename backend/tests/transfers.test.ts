import { describe, it, expect } from "vitest";
import { aiBid, auctionAvailableCash, createAuction, isEligibleAuctionBidder, resolveAuction } from "../src/game/transfers";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";

function makeClub(id: number, overrides: Partial<Club> = {}): Club {
  return {
    id,
    name: `Club ${id}`,
    shortName: `C${id}`,
    stateCode: "SP",
    division: 1,
    reputation: 4,
    level: 20,
    cash: 10_000_000,
    loanBalance: 0,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    boardConfidence: 50,
    fanConfidence: 70,
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}

function makeWorld(clubs: Club[], players: Player[]): World {
  return {
    seed: 1,
    year: 2026,
    dayIndex: 5,
    dayOfWeek: 0,
    nextId: 1000,
    clubs,
    players,
    competitions: [],
    fixtures: [],
    matches: [],
    news: [],
    auctions: [],
    loans: [],
    seasonAwards: [],
    records: [],
    managerHistory: [],
    ticketPrices: {},
    stadiumUpgrades: [],
    tvDeals: [],
    humanClubId: null,
    seasonSummary: null,
    rng: createRng(42),
    contractWarnings: [],
    liveMatch: null,
  };
}

describe("aiBid", () => {
  it("never opens below the minimum bid", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const listing = { minBid: 1_000_000, bids: [] as { clubId: number; amount: number }[] };
    for (let seed = 0; seed < 100; seed++) {
      const bid = aiBid(createRng(seed), club, listing, 2_000_000);
      if (bid !== null) expect(bid).toBeGreaterThanOrEqual(listing.minBid);
    }
  });

  it("escalates above the current bid and never exceeds 2.5x minBid", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const listing = { minBid: 1_000_000, bids: [{ clubId: 2, amount: 1_500_000 }] };
    for (let seed = 0; seed < 100; seed++) {
      const bid = aiBid(createRng(seed), club, listing, 2_000_000);
      if (bid !== null) {
        expect(bid).toBeGreaterThan(1_500_000);
        expect(bid).toBeLessThanOrEqual(2_500_000);
      }
    }
  });

  it("returns null rather than overpaying past the ceiling", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const listing = { minBid: 1_000_000, bids: [{ clubId: 2, amount: 3_000_000 }] };
    const bid = aiBid(createRng(1), club, listing, 2_000_000);
    expect(bid).toBeNull();
  });

  it("returns null when the club cannot afford the bid", () => {
    const club = makeClub(1, { cash: 500_000 });
    const listing = { minBid: 1_000_000, bids: [] as { clubId: number; amount: number }[] };
    const bid = aiBid(createRng(1), club, listing, 2_000_000);
    expect(bid).toBeNull();
  });

  it("skips clubs whose squad is deep at the position", () => {
    const club = makeClub(1, { cash: 10_000_000 });
    const rng = createRng(7);
    const gks = [0, 1, 2, 3, 4, 5].map((i) => generatePlayer(rng, club, { position: 0, id: i + 1 }));
    const listing = { minBid: 1_000_000, bids: [] as { clubId: number; amount: number }[] };
    expect(aiBid(rng, club, listing, 2_000_000, 0, gks)).toBeNull();
    const thin = gks.slice(0, 3);
    const bid = aiBid(rng, club, listing, 2_000_000, 0, thin);
    if (bid !== null) expect(bid).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe("auction resolution", () => {
  it("does not count cash committed to another auction twice", () => {
    const club = makeClub(1, { cash: 1_000_000 });
    const other = makeClub(2);
    const rng = createRng(5);
    const playerA = generatePlayer(rng, other, { id: 1 });
    const playerB = generatePlayer(rng, other, { id: 2 });
    const world = makeWorld([club, other], [playerA, playerB]);
    const first = createAuction(rng, world, playerA.id, other.id, world.dayIndex + 7);
    const second = createAuction(rng, world, playerB.id, other.id, world.dayIndex + 7);
    world.auctions.find((a) => a.id === first)!.bids.push({ clubId: club.id, amount: 700_000 });
    expect(auctionAvailableCash(world, club.id, second)).toBe(300_000);
    expect(aiBid(createRng(1), club, { minBid: 400_000, bids: [] }, 400_000, undefined, undefined, auctionAvailableCash(world, club.id, second))).toBeNull();
  });

  it("moves the winning fee exactly once (buyer pays once, seller receives once)", () => {
    const seller = makeClub(10);
    const buyer = makeClub(20, { cash: 20_000_000 });
    const rng = createRng(5);
    const player = generatePlayer(rng, seller, { id: 1 });
    const world = makeWorld([seller, buyer], [player]);

    const listingId = createAuction(rng, world, player.id, seller.id, world.dayIndex + 7);
    expect(listingId).toBeGreaterThan(0);
    expect(player.onSale).toBe(true);
    expect(player.salePrice).toBeNull();

    world.auctions[0].bids.push({ clubId: buyer.id, amount: 100_000 });
    const winner = resolveAuction(world, listingId);
    expect(winner).toBe(buyer.id);
    expect(seller.cash).toBe(10_000_000 + 100_000);
    expect(buyer.cash).toBe(20_000_000 - 100_000);
    expect(player.clubId).toBe(buyer.id);
    expect(player.onSale).toBe(false);
    expect(world.auctions).toHaveLength(0);
    expect(seller.ledger.income.filter((e) => e.code === 3)).toHaveLength(1);
    expect(buyer.ledger.expense.filter((e) => e.code === 1)).toHaveLength(1);
  });

  it("returns null and removes the listing when there are no bids", () => {
    const seller = makeClub(10);
    const rng = createRng(5);
    const player = generatePlayer(rng, seller, { id: 1 });
    const world = makeWorld([seller], [player]);
    const listingId = createAuction(rng, world, player.id, seller.id, world.dayIndex + 7);
    expect(player.onSale).toBe(true);
    expect(resolveAuction(world, listingId)).toBeNull();
    expect(world.auctions).toHaveLength(0);
    expect(player.onSale).toBe(false);
  });
});

describe("isEligibleAuctionBidder", () => {
  const listing = { sellerClubId: 10, bids: [] as { clubId: number }[] };

  it("excludes the human club, division 3+, the seller, and clubs already bidding", () => {
    expect(isEligibleAuctionBidder(listing, makeClub(1, { isHuman: true }))).toBe(false);
    expect(isEligibleAuctionBidder(listing, makeClub(2, { division: 3 }))).toBe(false);
    expect(isEligibleAuctionBidder(listing, makeClub(10))).toBe(false);
    const taken = makeClub(20);
    expect(isEligibleAuctionBidder({ sellerClubId: 10, bids: [{ clubId: 20 }] }, taken)).toBe(false);
  });

  it("allows an eligible club that has not bid yet", () => {
    expect(isEligibleAuctionBidder(listing, makeClub(20))).toBe(true);
    expect(isEligibleAuctionBidder({ sellerClubId: null, bids: [] }, makeClub(20, { division: 2 }))).toBe(true);
  });
});
