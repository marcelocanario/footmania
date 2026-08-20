import { describe, it, expect } from "vitest";
import {
  applyFreeAgentBid,
  createFreeAgentListing,
  generateFreeAgentTerms,
  freeAgentListingView,
  marketSalaryForPlayer,
  relistDueFreeAgents,
  processDueFreeAgentListing,
  settleDueFreeAgentListings,
  settleFreeAgentListing,
  contractSeasonsForAge,
} from "../src/game/freeAgents";
import { gameConfig, MARKET_CONFIG } from "../src/config";
import { getImmediateAvailableCash } from "../src/game/finance";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function makeClubFn(id: number, overrides: Partial<Club> = {}): Club {
  return makeClub({ id, isHuman: true, cash: 100_000_000, ...overrides });
}

function freePlayer(rng: ReturnType<typeof createRng>, id: number, overrides: Partial<Player> = {}): Player {
  const club = makeClubFn(999);
  const p = generatePlayer(rng, club, { id, isYouth: false });
  p.clubId = null;
  return { ...p, ...overrides, clubId: null };
}

describe("free-agent listing creation (§42)", () => {
  it("creates a listing with the configured opening multiplier and frozen terms", () => {
    const rng = createRng(1);
    const p = freePlayer(rng, 1, { value: 10_000_000, salary: 500_000, age: 25 });
    const world = makeWorld([makeClubFn(1)], [p]);

    const created = createFreeAgentListing(world, p, { now: 1_700_000_000_000 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const l = created.listing;
    expect(l.status).toBe("ACTIVE");
    // Opening = 10% of value (relistMultipliers[0]).
    expect(l.openingPrice).toBeGreaterThan(0);
    expect(l.openingPrice).toBeLessThanOrEqual(Math.round(10_000_000 * MARKET_CONFIG.freeAgents.relistMultipliers[0]) + 25_000);
    expect(l.salaryBaselineAtListing).toBeGreaterThan(0);
    expect(l.demandedSalary).toBeUndefined();
    expect(l.demandedContractDays).toBeUndefined();
  });

  it("rejects youth players and non-free agents", () => {
    const rng = createRng(1);
    const club = makeClubFn(1);
    const senior = generatePlayer(rng, club, { id: 1, isYouth: false });
    const world = makeWorld([club], [senior]);
    expect(createFreeAgentListing(world, senior, { now: 1 }).ok).toBe(false); // clubId !== null

    const youth = freePlayer(rng, 2, { isYouth: true });
    youth.clubId = null;
    const world2 = makeWorld([makeClubFn(1)], [youth]);
    expect(createFreeAgentListing(world2, youth, { now: 1 }).ok).toBe(false);
  });

  it("does not create duplicate active listings for the same player", () => {
    const rng = createRng(1);
    const p = freePlayer(rng, 1, { value: 5_000_000 });
    const world = makeWorld([makeClubFn(1)], [p]);
    expect(createFreeAgentListing(world, p, { now: 1 }).ok).toBe(true);
    expect(createFreeAgentListing(world, p, { now: 2 }).ok).toBe(false);
  });
});

describe("free-agent contract terms (§46)", () => {
  it("generates a deterministic salary from the live contract market", () => {
    const rng = createRng(1);
    const club = makeClubFn(1);
    const comparable = generatePlayer(rng, club, { id: 1, isYouth: false });
    comparable.clubId = club.id;
    comparable.value = 10_000_000;
    comparable.salary = 800_000;
    const fa = freePlayer(rng, 2, { value: 10_000_000, age: 27 });
    const world = makeWorld([club], [comparable, fa]);

    const s1 = marketSalaryForPlayer(world, fa, 0);
    const s2 = marketSalaryForPlayer(world, fa, 0);
    expect(s1).toBe(s2); // deterministic
    expect(s1).toBeGreaterThan(0);
  });

  it("contract duration depends on age and is clamped to 1..4 seasons", () => {
    expect(contractSeasonsForAge(18)).toBeGreaterThanOrEqual(1);
    expect(contractSeasonsForAge(18)).toBeLessThanOrEqual(4);
    expect(contractSeasonsForAge(38)).toBeGreaterThanOrEqual(1);
    expect(contractSeasonsForAge(38)).toBeLessThanOrEqual(4);
  });

  it("generateFreeAgentTerms returns frozen deterministic salary and contract", () => {
    const rng = createRng(1);
    const club = makeClubFn(1);
    const comparable = generatePlayer(rng, club, { id: 1, isYouth: false });
    comparable.clubId = club.id;
    comparable.value = 10_000_000;
    comparable.salary = 800_000;
    const fa = freePlayer(rng, 2, { value: 10_000_000, age: 27 });
    const world = makeWorld([club], [comparable, fa]);

    const a = generateFreeAgentTerms(world, fa, 0);
    const b = generateFreeAgentTerms(world, fa, 0);
    expect(a).toEqual(b);
  });

  it("exposes demand options from the frozen market salary baseline", () => {
    const fa = freePlayer(createRng(4), 4, { value: 10_000_000, salary: 800_000 });
    const world = makeWorld([makeClubFn(1)], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const view = freeAgentListingView(world, created.listing, null);
    expect(view.salaryBaseline).toBe(created.listing.salaryBaselineAtListing);
    expect(view.contractDemandsBySeason[1]).toBeGreaterThan(0);
    expect(view.contractDemandsBySeason[5]).toBeGreaterThanOrEqual(view.contractDemandsBySeason[1]);
  });
});

describe("free-agent proxy bidding (§43)", () => {
  function setupWorld() {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const world = makeWorld([], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    return { world, listing: created.listing, fa };
  }

  it("places a private max and computes the proxy current price", () => {
    const { world, listing, fa } = setupWorld();
    const club = makeClubFn(1);
    const club2 = makeClubFn(2);
    world.clubs.push(club, club2);

    const r1 = applyFreeAgentBid(world, { listing, club, player: fa, proposedMaximum: 1_000_000, immediateAvailableCash: 50_000_000, now: 1_700_000_000_000 });
    expect(r1.ok).toBe(true);
    expect(listing.currentPrice).toBe(listing.openingPrice); // single bid
    const r2 = applyFreeAgentBid(world, { listing, club: club2, player: fa, proposedMaximum: 1_500_000, immediateAvailableCash: 50_000_000, now: 1_700_000_000_000 });
    expect(r2.ok).toBe(true);
    // second-highest + increment
    expect(listing.currentPrice).toBeGreaterThan(1_000_000);
    expect(listing.leadingClubId).toBe(club2.id);
  });

  it("enforces immediate cash but has NO player-value cap (§43)", () => {
    const { world, listing, fa } = setupWorld();
    const rich = makeClubFn(1);
    world.clubs.push(rich);
    // value cap would reject >15M (1.5x), but FA allows well above value.
    const r = applyFreeAgentBid(world, { listing, club: rich, player: fa, proposedMaximum: 20_000_000, immediateAvailableCash: 50_000_000, now: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    const poor = makeClubFn(2, { cash: 100_000 });
    const r2 = applyFreeAgentBid(world, { listing, club: poor, player: fa, proposedMaximum: 5_000_000, immediateAvailableCash: 100, now: 1_700_000_000_000 });
    expect(r2.ok).toBe(false);
  });

  it("allows an active free-agent bidder to increase its maximum within total cash", () => {
    const { world, listing, fa } = setupWorld();
    const club = makeClubFn(1, { cash: 30_000_000 });
    world.clubs.push(club);
    expect(applyFreeAgentBid(world, {
      listing,
      club,
      player: fa,
      proposedMaximum: 20_000_000,
      immediateAvailableCash: getImmediateAvailableCash(world, club),
      now: 1_700_000_000_000,
    }).ok).toBe(true);
    const increased = applyFreeAgentBid(world, {
      listing,
      club,
      player: fa,
      proposedMaximum: 25_000_000,
      immediateAvailableCash: getImmediateAvailableCash(world, club),
      now: 1_700_000_000_001,
    });
    expect(increased.ok).toBe(true);
    expect(world.marketReservations.find((r) => r.clubId === club.id)?.amount).toBe(25_000_000);
  });

  it("stores bidder-specific terms and rejects changing them on a later raise", () => {
    const { world, listing, fa } = setupWorld();
    const club = makeClubFn(1);
    world.clubs.push(club);
    const first = applyFreeAgentBid(world, { listing, club, player: fa, proposedMaximum: 2_000_000, immediateAvailableCash: 50_000_000, contractSeasons: 3, now: 1_700_000_000_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.contractSeasons).toBe(3);
    expect(first.contractSalary).toBeGreaterThan(0);
    const acceptedSalary = first.contractSalary;
    world.mp.seasonDayIndex = 10;
    const increased = applyFreeAgentBid(world, { listing, club, player: fa, proposedMaximum: 2_050_000, immediateAvailableCash: 50_000_000, contractSeasons: 3, now: 1_700_000_000_001 });
    expect(increased.ok).toBe(true);
    if (increased.ok) expect(increased.contractSalary).toBe(acceptedSalary);
    const changed = applyFreeAgentBid(world, { listing, club, player: fa, proposedMaximum: 2_100_000, immediateAvailableCash: 50_000_000, contractSeasons: 4, now: 1_700_000_000_001 });
    expect(changed.ok).toBe(false);
    expect(changed.ok === false && changed.error).toMatch(/cannot be changed/);
  });
});

describe("free-agent settlement (§44/§46)", () => {
  it("pays the system and signs the winning bidder's contract", () => {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const winner = makeClubFn(1, { cash: 50_000_000 });
    const world = makeWorld([winner], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const bidAt = 1_700_000_000_000 + 10_000;
    const r = applyFreeAgentBid(world, { listing, club: winner, player: fa, proposedMaximum: 1_500_000, immediateAvailableCash: 50_000_000, contractSeasons: 3, now: bidAt });
    expect(r.ok).toBe(true);
    const settleAt = 1_700_000_000_000 + 100_000;
    listing.deadline = settleAt - 1;

    const result = settleFreeAgentListing(world, listing, settleAt);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.winnerClubId).toBe(winner.id);
    expect(winner.cash).toBe(50_000_000 - listing.finalPrice!);
    // Money leaves the economy: no other club received it.
    expect(fa.clubId).toBe(winner.id);
    expect(fa.salary).toBe(world.marketBids[0].contractSalary);
    expect(fa.contractDays).toBe(gameConfig.seasonDays * 4);
    expect(winner.ledger.expense.filter((entry) => entry.code === 4)).toHaveLength(0);
    expect(listing.status).toBe("COMPLETED");
    // Transaction recorded.
    expect(world.playerMarketHistory.length).toBe(1);
    expect(world.playerMarketHistory[0].type).toBe("FREE_AGENT_SIGNING");
    expect(world.playerMarketHistory[0].contractSeasons).toBe(3);
    expect(world.playerMarketHistory[0].contractSalary).toBe(fa.salary);
  });

  it("honors a binding signing bid after payroll makes the winner cash-negative", () => {
    const rng = createRng(2);
    const fa = freePlayer(rng, 2, { value: 10_000_000, salary: 800_000, age: 27 });
    const winner = makeClubFn(2, { cash: 50_000_000 });
    const world = makeWorld([winner], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const bid = applyFreeAgentBid(world, { listing, club: winner, player: fa, proposedMaximum: 1_500_000, immediateAvailableCash: 50_000_000, now: 1_700_000_000_001 });
    expect(bid.ok).toBe(true);
    winner.cash = -100;
    listing.deadline = 1_700_000_000_100;
    const result = settleFreeAgentListing(world, listing, listing.deadline + 1);
    expect(result.ok).toBe(true);
    expect(fa.clubId).toBe(winner.id);
    expect(winner.cash).toBeLessThan(0);
  });

  it("cancels a no-bid listing so it can relist (§54)", () => {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const world = makeWorld([makeClubFn(1)], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const now = 1_700_000_000_000 + 100_000;
    listing.deadline = now - 1;

    const processed = settleDueFreeAgentListings(world, now);
    expect(processed).toBe(0);
    expect(listing.status).toBe("CANCELLED");
    expect(world.freeAgentListings.filter((candidate) => candidate.status === "ACTIVE")).toHaveLength(1);
  });
});

describe("free-agent relisting (§54)", () => {
  it("re-lists a no-bid FA at a lower opening multiplier", () => {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const world = makeWorld([makeClubFn(1)], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const now = 1_700_000_000_000 + 100_000;
    listing.deadline = now - 1;

    const relisted = relistDueFreeAgents(world, now);
    expect(relisted).toBe(1);
    const active = world.freeAgentListings.filter((l) => l.status === "ACTIVE");
    expect(active.length).toBe(1);
    // Lower opening on the next stage.
    expect(active[0].openingPrice).toBeLessThanOrEqual(listing.openingPrice);
    expect(active[0].relistStage).toBe(1);
    expect(active[0].unclaimedSince).toBe(listing.unclaimedSince);
    expect(active[0].salaryBaselineAtListing).toBe(listing.salaryBaselineAtListing);
  });

  it("carries the former-club block across no-bid relists", () => {
    const fa = freePlayer(createRng(3), 3, { value: 10_000_000 });
    const formerClub = makeClubFn(3);
    const world = makeWorld([formerClub], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000, blockedClubId: formerClub.id });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const now = 1_700_000_000_000 + 100_000;
    listing.deadline = now - 1;
    expect(relistDueFreeAgents(world, now)).toBe(1);
    const active = world.freeAgentListings.find((candidate) => candidate.status === "ACTIVE");
    expect(active?.blockedClubId).toBe(formerClub.id);
  });

  it("does not relist a listing that had bids", () => {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const winner = makeClubFn(1, { cash: 50_000_000 });
    const world = makeWorld([winner], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const bidAt = 1_700_000_000_000 + 10_000;
    applyFreeAgentBid(world, { listing, club: winner, player: fa, proposedMaximum: 1_500_000, immediateAvailableCash: 50_000_000, now: bidAt });
    const now = 1_700_000_000_000 + 100_000;
    listing.deadline = now - 1;

    const relisted = relistDueFreeAgents(world, now);
    expect(relisted).toBe(0);
  });

  it("deletes an unclaimed free agent at the exact retention boundary", () => {
    const fa = freePlayer(createRng(9), 9, { value: 10_000_000 });
    const world = makeWorld([makeClubFn(1)], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const retentionAt = (listing.unclaimedSince ?? listing.createdAt) + gameConfig.freeAgentRetentionDays * 24 * 60 * 60 * 1000;
    listing.deadline = retentionAt - 1;
    const result = processDueFreeAgentListing(world, listing, retentionAt);
    expect(result.kind).toBe("DELETED");
    expect(world.players.some((player) => player.id === fa.id)).toBe(false);
    expect(world.freeAgentListings.some((candidate) => candidate.playerId === fa.id)).toBe(false);
  });
});
