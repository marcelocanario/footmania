import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { settleDueAuctions, aiBidDuringWindow } from "../src/game/world";
import { createAuction } from "../src/game/transfers";
import { initSeason } from "../src/game/multiplayer";
import type { World } from "../src/game/types";

describe("auction flow (engine)", () => {
  it("keeps a production auction open for its absolute duration", () => {
    const world = generateWorld(4243);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const seller = world.clubs[0];
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
    const before = Date.now();
    const duration = 7 * 24 * 60 * 60 * 1000;
    const listingId = createAuction(world.rng, world, player.id, seller.id, 28, before + duration);

    const listing = world.auctions.find((auction) => auction.id === listingId)!;
    expect(listing.endsAt).toBeGreaterThanOrEqual(before + duration);
    settleDueAuctions(world, before + duration - 1);
    expect(world.auctions.some((auction) => auction.id === listingId)).toBe(true);
    settleDueAuctions(world, before + duration + 1);
    expect(world.auctions.some((auction) => auction.id === listingId)).toBe(false);
  });

  it("resolves a human auction: player leaves squad, money moves exactly once", () => {
    const world = generateWorld(4242);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const human = world.clubs[0];
    human.isHuman = true;
    human.ownerUserId = 1;

    const player = world.players.find((p) => p.clubId === human.id && !p.isYouth && p.position !== 0)!;
    const sellDay = world.dayIndex;

    const cashBefore = new Map(world.clubs.map((c) => [c.id, c.cash]));
    const incomeBefore = new Map(world.clubs.map((c) => [c.id, c.ledger.income.reduce((s, e) => s + e.amount, 0)]));
    const expenseBefore = new Map(world.clubs.map((c) => [c.id, c.ledger.expense.reduce((s, e) => s + e.amount, 0)]));

    // Create the auction with a deadline on the current day so settlement runs
    // immediately via the minute-resolution worker path.
    const listingId = createAuction(world.rng, world, player.id, human.id, world.dayIndex);
    expect(player.onSale).toBe(true);

    settleDueAuctions(world, Date.now());

    expect(world.auctions.find((a) => a.id === listingId)).toBeUndefined();
    expect(player.clubId).not.toBe(human.id);
    expect(player.clubId).not.toBeNull();
    expect(player.onSale).toBe(false);

    const winner = world.clubs.find((c) => c.id === player.clubId)!;

    const feeIn = human.ledger.income.filter((e) => e.code === 3 && e.label.includes(player.name));
    const feeOut = winner.ledger.expense.filter((e) => e.code === 1 && e.label.includes(player.name));
    expect(feeIn).toHaveLength(1);
    expect(feeOut).toHaveLength(1);
    expect(feeIn[0].amount).toBe(feeOut[0].amount);
    expect(feeIn[0].amount).toBeGreaterThan(0);

    for (const club of [human, winner]) {
      const net = incomeBefore.get(club.id)! - expenseBefore.get(club.id)!;
      const after = club.ledger.income.reduce((s, e) => s + e.amount, 0) - club.ledger.expense.reduce((s, e) => s + e.amount, 0);
      const ledgerDelta = after - net;
      const cashDelta = club.cash - cashBefore.get(club.id)!;
      expect(cashDelta).toBe(ledgerDelta);
    }
  });

  it("AI clubs place bids during the auction window", () => {
    let withBids = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = generateWorld(seed);
      initSeason(world, { year: 2026, month: 1 }, 1);
      const human = world.clubs[0];
      human.isHuman = true;
      human.ownerUserId = 1;
      const seller = world.clubs.find((c) => c.ownerUserId === null)!;
      const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
      createAuction(world.rng, world, player.id, seller.id, world.dayIndex + 7);
      aiBidDuringWindow(world);
      const listing = world.auctions[0];
      expect(listing.bids.some((b) => b.clubId === human.id)).toBe(false);
      if (listing.bids.length > 0) withBids++;
    }
    expect(withBids).toBeGreaterThanOrEqual(10);
  });
});
