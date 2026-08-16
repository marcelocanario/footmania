import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { advance, finalizeLiveMatch, aiBidDuringWindow } from "../src/game/world";
import { createAuction } from "../src/game/transfers";
import type { World } from "../src/game/types";

function runDays(world: World, targetDay: number) {
  let guard = 0;
  while (world.dayIndex < targetDay && guard++ < 200) {
    const result = advance(world);
    if (result.matchPending) finalizeLiveMatch(world);
  }
}

describe("auction flow (engine)", () => {
  it("resolves a human auction: player leaves squad, money moves exactly once", () => {
    const world = generateWorld(4242);
    const human = world.clubs[0];
    human.isHuman = true;
    world.humanClubId = human.id;

    const player = world.players.find((p) => p.clubId === human.id && !p.isYouth && !p.isStar && !p.worldClass && p.position !== 0)!;
    const sellDay = world.dayIndex;

    const cashBefore = new Map(world.clubs.map((c) => [c.id, c.cash]));
    const incomeBefore = new Map(world.clubs.map((c) => [c.id, c.ledger.income.reduce((s, e) => s + e.amount, 0)]));
    const expenseBefore = new Map(world.clubs.map((c) => [c.id, c.ledger.expense.reduce((s, e) => s + e.amount, 0)]));

    const listingId = createAuction(world.rng, world, player.id, human.id, world.dayIndex + 7);
    expect(player.onSale).toBe(true);

    runDays(world, sellDay + 8);

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
      const human = world.clubs[0];
      human.isHuman = true;
      world.humanClubId = human.id;
      const seller = world.clubs.find((c) => !c.isHuman)!;
      const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth && !p.isStar && !p.worldClass)!;
      createAuction(world.rng, world, player.id, seller.id, world.dayIndex + 7);
      aiBidDuringWindow(world);
      const listing = world.auctions[0];
      expect(listing.bids.some((b) => b.clubId === human.id)).toBe(false);
      if (listing.bids.length > 0) withBids++;
    }
    expect(withBids).toBeGreaterThanOrEqual(10);
  });
});
