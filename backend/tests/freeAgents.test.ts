import { describe, it, expect } from "vitest";
import {
  applyFreeAgentBid,
  createFreeAgentListing,
  generateFreeAgentTerms,
  marketSalaryForPlayer,
  relistDueFreeAgents,
  settleDueFreeAgentListings,
  settleFreeAgentListing,
  contractSeasonsForAge,
} from "../src/game/freeAgents";
import { MARKET_CONFIG } from "../src/config";
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
    expect(l.demandedSalary).toBeGreaterThan(0);
    expect(l.demandedContractDays).toBeGreaterThan(0);
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

    const r1 = applyFreeAgentBid(world, { listing, club, player: fa, proposedMaximum: 1_000_000, safeMarketBudget: 50_000_000, now: 1_700_000_000_000 });
    expect(r1.ok).toBe(true);
    expect(listing.currentPrice).toBe(listing.openingPrice); // single bid
    const r2 = applyFreeAgentBid(world, { listing, club: club2, player: fa, proposedMaximum: 1_500_000, safeMarketBudget: 50_000_000, now: 1_700_000_000_000 });
    expect(r2.ok).toBe(true);
    // second-highest + increment
    expect(listing.currentPrice).toBeGreaterThan(1_000_000);
    expect(listing.leadingClubId).toBe(club2.id);
  });

  it("enforces SafeMarketBudget but has NO player-value cap (§43)", () => {
    const { world, listing, fa } = setupWorld();
    const rich = makeClubFn(1);
    world.clubs.push(rich);
    // value cap would reject >15M (1.5x), but FA allows well above value.
    const r = applyFreeAgentBid(world, { listing, club: rich, player: fa, proposedMaximum: 20_000_000, safeMarketBudget: 50_000_000, now: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    const poor = makeClubFn(2, { cash: 100_000 });
    const r2 = applyFreeAgentBid(world, { listing, club: poor, player: fa, proposedMaximum: 5_000_000, safeMarketBudget: 100, now: 1_700_000_000_000 });
    expect(r2.ok).toBe(false);
  });
});

describe("free-agent settlement (§44/§46)", () => {
  it("pays the system and signs the predefined contract", () => {
    const rng = createRng(1);
    const fa = freePlayer(rng, 1, { value: 10_000_000, salary: 800_000, age: 27 });
    const winner = makeClubFn(1, { cash: 50_000_000 });
    const world = makeWorld([winner], [fa]);
    const created = createFreeAgentListing(world, fa, { now: 1_700_000_000_000 });
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;
    const bidAt = 1_700_000_000_000 + 10_000;
    const r = applyFreeAgentBid(world, { listing, club: winner, player: fa, proposedMaximum: 1_500_000, safeMarketBudget: 50_000_000, now: bidAt });
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
    expect(fa.salary).toBe(listing.demandedSalary);
    expect(fa.contractDays).toBe(listing.demandedContractDays);
    expect(listing.status).toBe("COMPLETED");
    // Transaction recorded.
    expect(world.playerMarketHistory.length).toBe(1);
    expect(world.playerMarketHistory[0].type).toBe("FREE_AGENT_SIGNING");
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

    const settled = settleDueFreeAgentListings(world, now);
    expect(settled).toBe(1);
    expect(listing.status).toBe("CANCELLED");
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
    applyFreeAgentBid(world, { listing, club: winner, player: fa, proposedMaximum: 1_500_000, safeMarketBudget: 50_000_000, now: bidAt });
    const now = 1_700_000_000_000 + 100_000;
    listing.deadline = now - 1;

    const relisted = relistDueFreeAgents(world, now);
    expect(relisted).toBe(0);
  });
});