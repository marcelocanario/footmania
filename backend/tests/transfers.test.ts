import { describe, it, expect } from "vitest";
import { aiBid, auctionAvailableCash, createAuction, freeAgentSigningBonus, isEligibleAuctionBidder, releasePlayer, resolveAuction, transferPlayer } from "../src/game/transfers";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club } from "../src/game/types";
import { gameConfig } from "../src/config";
import { makeWorld } from "./helpers";

function makeClub(id: number, overrides: Partial<Club> = {}): Club {
  return {
    id,
    name: `Club ${id}`,
    shortName: `C${id}`,
    ownerUserId: null,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    level: 20,
    cash: 10_000_000,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    boardConfidence: 50,
    fanConfidence: 70,
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

describe("free-agent compensation", () => {
  it("uses salary rather than market value and increases with overall", () => {
    const low = freeAgentSigningBonus({ salary: 100_000, overall: 50 });
    const high = freeAgentSigningBonus({ salary: 100_000, overall: 80 });
    expect(low).toBe(275_000);
    expect(high).toBe(350_000);
    expect(freeAgentSigningBonus({ salary: 200_000, overall: 50 })).toBe(low * 2);
  });
});

describe("auction resolution", () => {
  it("does not count cash committed to another auction twice", () => {
    const club = makeClub(1, { cash: 1_000_000 });
    const other = makeClub(2);
    const rng = createRng(5);
    const playerA = generatePlayer(rng, other, { id: 1 });
    const playerB = generatePlayer(rng, other, { id: 2 });
    const world = makeWorld([club, other], [playerA, playerB], { dayIndex: 5 });
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
    const world = makeWorld([seller, buyer], [player], { dayIndex: 5 });

    const listingId = createAuction(rng, world, player.id, seller.id, world.dayIndex + 7);
    expect(listingId).toBeGreaterThan(0);
    expect(player.onSale).toBe(true);
    expect(player.salePrice).toBeNull();

    world.auctions[0].bids.push({ clubId: buyer.id, amount: 100_000 });
    const winner = resolveAuction(world, listingId);
    expect(winner).toBe(buyer.id);
    expect(seller.cash).toBe(10_000_000 + 100_000 - Math.round(player.salary * 5 / gameConfig.seasonDays));
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
    const world = makeWorld([seller], [player], { dayIndex: 5 });
    const listingId = createAuction(rng, world, player.id, seller.id, world.dayIndex + 7);
    expect(player.onSale).toBe(true);
    expect(resolveAuction(world, listingId)).toBeNull();
    expect(world.auctions).toHaveLength(0);
    expect(player.onSale).toBe(false);
  });
});

describe("releasePlayer", () => {
  it("pays the release clause and moves a senior player to free agency", () => {
    const club = makeClub(1, { cash: 5_000_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1 });
    player.releaseClause = 1_000_000;
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(1_000_000);
    expect(club.cash).toBe(4_000_000 - Math.round(player.salary * 5 / gameConfig.seasonDays));
    expect(club.ledger.expense.filter((e) => e.code === 2 && e.label.includes(player.name))).toHaveLength(1);
    expect(player.clubId).toBeNull();
    expect(player.onSale).toBe(false);
    expect(player.salePrice).toBeNull();
    expect(world.news.some((n) => n.text.includes(`${player.name} was released`))).toBe(true);
  });

  it("rejects a release the club cannot afford", () => {
    const club = makeClub(1, { cash: 100_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1 });
    player.releaseClause = 1_000_000;
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(false);
    expect(player.clubId).toBe(club.id);
    expect(club.cash).toBe(100_000);
  });

  it("releases youth players for free", () => {
    const club = makeClub(1, { cash: 0 });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1, isYouth: true });
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(0);
    expect(player.clubId).toBeNull();
  });

  it("rejects a player who does not belong to the club", () => {
    const club = makeClub(1);
    const other = makeClub(2);
    const rng = createRng(9);
    const player = generatePlayer(rng, other, { id: 1 });
    const world = makeWorld([club, other], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(false);
    expect(player.clubId).toBe(other.id);
  });

  it("does not release a player who is on loan to the club", () => {
    const owner = makeClub(1);
    const receiving = makeClub(2, { cash: 100_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, owner, { id: 1 });
    player.clubId = receiving.id;
    player.loanId = 10;
    player.releaseClause = 1_000_000;
    const world = makeWorld([owner, receiving], [player], { dayIndex: 5 });
    world.loans.push({ id: 10, playerId: player.id, fromClubId: owner.id, toClubId: receiving.id, startDay: 1, endDay: 20, recalled: false });

    const result = releasePlayer(world, player, receiving);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("A player on loan cannot be released");
    expect(player.clubId).toBe(receiving.id);
    expect(player.loanId).toBe(10);
    expect(world.loans[0].recalled).toBe(false);
    expect(world.news).toHaveLength(0);
  });

  it("rejects transfers and auctions for players on loan", () => {
    const owner = makeClub(1);
    const buyer = makeClub(2, { cash: 2_000_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, owner, { id: 1 });
    player.loanId = 10;
    const world = makeWorld([owner, buyer], [player], { dayIndex: 5 });

    expect(transferPlayer(world, player, buyer, 500_000)).toBe(false);
    expect(createAuction(rng, world, player.id, owner.id, world.dayIndex + 7)).toBe(-1);
    expect(player.clubId).toBe(owner.id);
    expect(player.loanId).toBe(10);
    expect(player.onSale).toBe(false);
    expect(owner.cash).toBe(10_000_000);
    expect(buyer.cash).toBe(2_000_000);
  });
});

describe("isEligibleAuctionBidder", () => {
  const listing = { sellerClubId: 10, bids: [] as { clubId: number }[] };

  it("excludes the human club, the seller, and clubs already bidding", () => {
    expect(isEligibleAuctionBidder(listing, makeClub(1, { isHuman: true }))).toBe(false);
    expect(isEligibleAuctionBidder(listing, makeClub(10))).toBe(false);
    const taken = makeClub(20);
    expect(isEligibleAuctionBidder({ sellerClubId: 10, bids: [{ clubId: 20 }] }, taken)).toBe(false);
  });

  it("allows an eligible club that has not bid yet", () => {
    expect(isEligibleAuctionBidder(listing, makeClub(20))).toBe(true);
    expect(isEligibleAuctionBidder({ sellerClubId: null, bids: [] }, makeClub(20))).toBe(true);
  });
});
