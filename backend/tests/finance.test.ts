import { describe, it, expect } from "vitest";
import {
  activeBidCommitments,
  aiAffordableCommitment,
  evaluateAIDecision,
  financialState,
  getCommitmentTotals,
  getFinancialCushion,
  getImmediateAvailableCash,
  remainingSalaryCommitments,
  runFinancialIntervention,
  selectLiquidationSubset,
} from "../src/game/finance";
import { createTransferAuction, applyMaxBid, upsertReservation } from "../src/game/market";
import { applyFreeAgentBid } from "../src/game/freeAgents";
import { startStadiumUpgrade } from "../src/game/season";
import { processDailyDate } from "../src/game/daily";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function makeClubFn(id: number, overrides: Partial<Club> = {}): Club {
  return makeClub({ id, isHuman: true, cash: 100_000_000, ...overrides });
}

function clubPlayer(rng: ReturnType<typeof createRng>, club: Club, id: number, overrides: Partial<Player> = {}): Player {
  const p = generatePlayer(rng, club, { id, isYouth: false });
  return { ...p, ...overrides, clubId: club.id };
}

describe("financial cushion (§2/§62)", () => {
  it("cash 10M, bids 2M, remaining salary 6M => cushion +2M", () => {
    const club = makeClubFn(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    upsertReservation(world, { clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 2_000_000 });
    const rng = createRng(1);
    const p = clubPlayer(rng, club, 10, { salary: 6_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    world.players.push(p);
    expect(getFinancialCushion(world, club)).toBe(2_000_000);
  });

  it("cash 10M, bids 4M, remaining salary 8M => cushion -2M", () => {
    const club = makeClubFn(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    upsertReservation(world, { clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 4_000_000 });
    const rng = createRng(2);
    const p = clubPlayer(rng, club, 10, { salary: 8_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    world.players.push(p);
    expect(getFinancialCushion(world, club)).toBe(-2_000_000);
  });

  it("does not include loaned-out players but includes loaned-in wages (§5)", () => {
    const club = makeClubFn(1);
    const other = makeClubFn(2);
    const rng = createRng(3);
    const loanedOut = clubPlayer(rng, club, 10, { salary: 5_000_000, payrollPaidThroughDay: 0 });
    const loanedIn = clubPlayer(rng, other, 11, { salary: 3_000_000, payrollPaidThroughDay: 0 });
    loanedIn.clubId = club.id;
    loanedIn.loanId = 100;
    const world = makeWorld([club, other], [loanedOut, loanedIn]);
    world.loans.push({ id: 100, playerId: loanedIn.id, fromClubId: other.id, toClubId: club.id, startDay: 1, endDay: 30, recalled: false, listedAt: 1, claimableAt: 1 });
    world.loans.push({ id: 101, playerId: loanedOut.id, fromClubId: club.id, toClubId: other.id, startDay: 1, endDay: 30, recalled: false, listedAt: 1, claimableAt: 1 });
    loanedOut.clubId = other.id;
    loanedOut.loanId = 101;
    // loanedOut.clubId = other.id already set; fix ownership below.
    world.players.find((p) => p.id === loanedOut.id)!.clubId = other.id;
    world.players.find((p) => p.id === loanedOut.id)!.loanId = 101;

    const salaries = remainingSalaryCommitments(world, club);
    expect(salaries).toBe(3_000_000); // only the loaned-in wage counts
  });
});

describe("immediate available cash (§9/§64)", () => {
  it("cash 10M, reservations 8M => only 2M immediately available", () => {
    const club = makeClubFn(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    upsertReservation(world, { clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 8_000_000 });
    expect(getImmediateAvailableCash(world, club)).toBe(2_000_000);
  });

  it("a stadium-style expense over the immediate cash is rejected", () => {
    const club = makeClubFn(1, { cash: 10_000_000 });
    const world = makeWorld([club], []);
    upsertReservation(world, { clubId: 1, listingId: 1, marketType: "TRANSFER", amount: 8_000_000 });
    // 3M upgrade cost exceeds the 2M immediately available.
    const res = startStadiumUpgrade(world, club);
    expect(res.error).toMatch(/unreserved cash/i);
  });
});

describe("human vs AI (§63)", () => {
  function riskyWorld(): { world: World; buyer: Club; player: Player } {
    const seller = makeClubFn(9, { cash: 5_000_000, isHuman: false });
    const buyer = makeClubFn(1, { cash: 10_000_000, isHuman: true });
    const rng = createRng(9);
    const p = clubPlayer(rng, seller, 10, { salary: 8_000_000, value: 8_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    const world = makeWorld([seller, buyer], [p]);
    return { world, buyer, player: p };
  }

  it("a human may bid into a negative cushion as long as immediate cash allows", () => {
    const { world, buyer, player } = riskyWorld();
    const seller = world.clubs.find((c) => c.id !== buyer.id)!;
    const listed = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 2, totalDivisions: 3, openingPrice: 6_000_000 });
    if (!listed.ok) throw new Error(listed.error);
    const res = applyMaxBid(world, {
      listing: listed.listing,
      club: buyer,
      player,
      proposedMaximum: 7_000_000,
      buyerDivision: 1,
      immediateAvailableCash: getImmediateAvailableCash(world, buyer),
    });
    expect(res.ok).toBe(true);
    // The human's cushion is now negative but the bid was allowed.
    expect(getFinancialCushion(world, buyer)).toBeLessThan(0);
  });

  it("an AI rejects the same action via evaluateAIDecision", () => {
    const club = makeClubFn(1, { cash: 10_000_000, isHuman: false });
    const world = makeWorld([club], []);
    const rng = createRng(9);
    const p = clubPlayer(rng, club, 10, { salary: 8_000_000, payrollPaidThroughDay: 0 });
    world.players.push(p);
    // Adding a 5M bid + 2M acquisition salary would push cushion below 0.
    const ok = evaluateAIDecision(world, club, { immediateCost: 0, newBidCommitments: 5_000_000, additionalSalary: 2_000_000 });
    expect(ok).toBe(false);
  });

  it("includes existing contingent salary when evaluating another AI decision", () => {
    const buyer = makeClubFn(1, { cash: 8_000_000, isHuman: false });
    const seller = makeClubFn(2, { cash: 5_000_000 });
    const player = clubPlayer(createRng(10), seller, 20, { salary: 6_000_000, value: 4_000_000 });
    const world = makeWorld([buyer, seller], [player]);
    const listed = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 2, totalDivisions: 3 });
    if (!listed.ok) throw new Error(listed.error);
    const bid = applyMaxBid(world, {
      listing: listed.listing,
      club: buyer,
      player,
      proposedMaximum: 4_000_000,
      buyerDivision: 1,
      immediateAvailableCash: buyer.cash,
    });
    expect(bid.ok).toBe(true);
    expect(getFinancialCushion(world, buyer)).toBeLessThan(0);
    expect(evaluateAIDecision(world, buyer, { immediateCost: 0, newBidCommitments: 0, additionalSalary: 0 })).toBe(false);
  });

  it("AI free-agent valuation caps at the cushion-safe ceiling", () => {
    const club = makeClubFn(1, { cash: 10_000_000, isHuman: false });
    const world = makeWorld([club], []);
    const rng = createRng(9);
    const p = clubPlayer(rng, club, 10, { salary: 8_000_000, payrollPaidThroughDay: 0 });
    world.players.push(p);
    const affordable = aiAffordableCommitment(world, club, 5_000_000);
    // cash 10M - salaries 8M - acquisition salary commitment ~ (5M * remaining/30)
    expect(affordable).toBeLessThan(2_000_000);
    expect(affordable).toBeGreaterThanOrEqual(0);
  });
});

describe("contingent salary from leading bids (§6)", () => {
  it("includes a leading transfer auction's salary until outbid", () => {
    const buyer = makeClubFn(1, { cash: 50_000_000 });
    const seller = makeClubFn(2, { cash: 5_000_000 });
    const rng = createRng(5);
    const p = clubPlayer(rng, seller, 20, { salary: 4_000_000, value: 10_000_000, payrollPaidThroughDay: 0 });
    const world = makeWorld([buyer, seller], [p]);
    const listed = createTransferAuction(world, { player: p, sellerClub: seller, sellerDivision: 2, totalDivisions: 3, openingPrice: 6_000_000 });
    if (!listed.ok) throw new Error(listed.error);
    const bid = applyMaxBid(world, { listing: listed.listing, club: buyer, player: p, proposedMaximum: 6_000_000, buyerDivision: 1, immediateAvailableCash: 50_000_000 });
    expect(bid.ok).toBe(true);
    if (!bid.ok) throw new Error(bid.error);
    expect(bid.leading).toBe(true);
    // Leading a binding auction adds a contingent salary commitment.
    expect(getCommitmentTotals(world, buyer).contingentSalary).toBeGreaterThan(0);
  });

  it("removes the contingent salary when outbid", () => {
    const buyer = makeClubFn(1, { cash: 50_000_000 });
    const buyer2 = makeClubFn(3, { cash: 60_000_000 });
    const seller = makeClubFn(2, { cash: 5_000_000 });
    const rng = createRng(6);
    const p = clubPlayer(rng, seller, 20, { salary: 4_000_000, value: 10_000_000, payrollPaidThroughDay: 0 });
    const world = makeWorld([buyer, buyer2, seller], [p]);
    const listed = createTransferAuction(world, { player: p, sellerClub: seller, sellerDivision: 2, totalDivisions: 3, openingPrice: 6_000_000 });
    if (!listed.ok) throw new Error(listed.error);
    applyMaxBid(world, { listing: listed.listing, club: buyer, player: p, proposedMaximum: 6_000_000, buyerDivision: 1, immediateAvailableCash: 50_000_000 });
    const outbidding = applyMaxBid(world, { listing: listed.listing, club: buyer2, player: p, proposedMaximum: 9_000_000, buyerDivision: 1, immediateAvailableCash: 60_000_000 });
    expect(outbidding.ok).toBe(true);
    if (!outbidding.ok) throw new Error(outbidding.error);
    expect(outbidding.leading).toBe(true);
    // The first club no longer leads → contingent salary removed.
    expect(getCommitmentTotals(world, buyer).contingentSalary).toBe(0);
  });
});

describe("financial states (§17)", () => {
  it("classifies SAFE / AT_RISK / NEGATIVE_CASH", () => {
    const safe = makeClubFn(1, { cash: 10_000_000 });
    const worldSafe = makeWorld([safe], []);
    expect(financialState(worldSafe, safe)).toBe("SAFE");

    const atRisk = makeClubFn(2, { cash: 10_000_000 });
    const worldAtRisk = makeWorld([atRisk], []);
    const rng = createRng(1);
    const p = clubPlayer(rng, atRisk, 10, { salary: 20_000_000, payrollPaidThroughDay: 0 });
    worldAtRisk.players.push(p);
    expect(financialState(worldAtRisk, atRisk)).toBe("AT_RISK");

    const negative = makeClubFn(3, { cash: -1_000_000 });
    const worldNeg = makeWorld([negative], []);
    expect(financialState(worldNeg, negative)).toBe("NEGATIVE_CASH");
  });
});

describe("subset selection (§45-§48/§69/§70)", () => {
  it("solves the closest adequate combination", () => {
    const mk = (id: number, eff: number) => ({ player: { id } as Player, effectiveRecovery: eff });
    const candidates = [mk(1, 9_000_000), mk(2, 6_000_000), mk(3, 4_500_000), mk(4, 3_000_000)];
    const selected = selectLiquidationSubset(candidates, 10_000_000);
    const recovery = selected.reduce((s, i) => s + candidates[i].effectiveRecovery, 0);
    // B + C = 10.5M (minimal overshoot) rather than A + D = 12M.
    expect(recovery).toBe(10_500_000);
  });

  it("uses effective recovery (price + salary relief - replacement salary)", () => {
    // A: liquidation 4M, salary relief 3M, replacement salary 1M → eff 6M.
    const candidates = [{ player: { id: 1 } as Player, effectiveRecovery: 6_000_000 }];
    const selected = selectLiquidationSubset(candidates, 5_500_000);
    expect(selected).toEqual([0]);
  });

  it("breaks ties by fewest players", () => {
    const mk = (id: number, eff: number) => ({ player: { id } as Player, effectiveRecovery: eff });
    // Required 10M: {A,B} = 10M (2 players) vs {C,D,E} = 10M (3 players).
    const candidates = [mk(1, 5_000_000), mk(2, 5_000_000), mk(3, 4_000_000), mk(4, 3_000_000), mk(5, 3_000_000)];
    const selected = selectLiquidationSubset(candidates, 10_000_000);
    expect(selected.length).toBe(2);
  });

  it("never selects a candidate with non-positive recovery (§48)", () => {
    const mk = (id: number, eff: number) => ({ player: { id } as Player, effectiveRecovery: eff });
    const candidates = [mk(1, -1_000_000), mk(2, 5_000_000)];
    const selected = selectLiquidationSubset(candidates, 5_000_000);
    expect(selected).toEqual([1]);
  });
});

describe("financial intervention execution (§50-§54)", () => {
  function distressedClub(): { world: World; club: Club } {
    const club = makeClubFn(1, { cash: 2_000_000 });
    const rng = createRng(11);
    // Two senior players with heavy remaining wages.
    const p1 = clubPlayer(rng, club, 10, { salary: 6_000_000, value: 8_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    const p2 = clubPlayer(rng, club, 11, { salary: 5_000_000, value: 7_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    const world = makeWorld([club], [p1, p2]);
    world.mp.seasonId = 1;
    return { world, club };
  }

  it("system-liquidates players, pays the normal opening price, and replaces them", () => {
    const { world, club } = distressedClub();
    const result = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7, now: 1_700_000_000_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const intervention = result.intervention;
    // Cash increased by liquidation revenue.
    expect(intervention.systemLiquidationRevenue).toBeGreaterThan(0);
    expect(intervention.entries.length).toBeGreaterThan(0);
    // Each departed player got a same-position replacement.
    for (const entry of intervention.entries) {
      if (entry.kind === "SYSTEM_LIQUIDATION") {
        expect(entry.replacementPlayerId).not.toBeNull();
      }
    }
    // Liquidated players are now free agents (clubId null).
    const liquidated = intervention.entries.filter((e) => e.kind === "SYSTEM_LIQUIDATION");
    for (const entry of liquidated) {
      const player = world.players.find((p) => p.id === entry.playerId);
      expect(player?.clubId).toBeNull();
    }
    // The club retains its surplus and the intervention is auditable.
    expect(intervention.cashAfter).toBeGreaterThanOrEqual(0);
    expect(world.financialInterventions).toHaveLength(1);
  });

  it("is idempotent per (clubId, seasonId, payrollCycleId) (§52)", () => {
    const { world, club } = distressedClub();
    const first = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(first.ok).toBe(true);
    const second = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(second.ok).toBe(false);
    expect(world.financialInterventions).toHaveLength(1);
  });

  it("generates the same replacement profiles for the same intervention key (§41/§74)", () => {
    const firstWorld = distressedClub();
    const secondWorld = distressedClub();
    const first = runFinancialIntervention(firstWorld.world, firstWorld.club, { seasonId: 1, payrollCycleId: 7 });
    const second = runFinancialIntervention(secondWorld.world, secondWorld.club, { seasonId: 1, payrollCycleId: 7 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const profiles = (world: World, intervention: { entries: { replacementPlayerId: number | null }[] }) => intervention.entries
      .map((entry) => entry.replacementPlayerId)
      .filter((id): id is number => id !== null)
      .map((id) => {
        const player = world.players.find((candidate) => candidate.id === id)!;
        return { position: player.position, overall: player.overall, salary: player.salary, contractDays: player.contractDays, name: player.name };
      });
    expect(profiles(firstWorld.world, first.intervention)).toEqual(profiles(secondWorld.world, second.intervention));
  });

  it("replacement players cannot be system-liquidated again in the same season (§31/§75)", () => {
    const { world, club } = distressedClub();
    const first = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(first.ok).toBe(true);
    // Try to liquidate again on another payroll cycle.
    const second = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 14 });
    expect(second.ok).toBe(true);
    const secondIntervention = second.ok ? second.intervention : null;
    // No replacement from the first intervention may be system-liquidated.
    const replacementIds = first.ok
      ? first.intervention.entries.map((e) => e.replacementPlayerId).filter((id): id is number => id !== null)
      : [];
    for (const id of replacementIds) {
      const entry = secondIntervention?.entries.find((e) => e.playerId === id);
      expect(entry).toBeUndefined();
    }
  });

  it("creates free-agent listings that block the former club (§35/§72)", () => {
    const { world, club } = distressedClub();
    const result = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(result.ok).toBe(true);
    const created = world.freeAgentListings.filter((l) => l.status === "ACTIVE");
    expect(created.length).toBeGreaterThan(0);
    for (const listing of created) {
      expect(listing.blockedClubId).toBe(club.id);
      // The former club cannot bid on the listing.
      const player = world.players.find((p) => p.id === listing.playerId)!;
      const bid = applyFreeAgentBid(world, { listing, club, player, proposedMaximum: 1_000_000, immediateAvailableCash: 100_000_000 });
      expect(bid.ok).toBe(false);
    }
  });

  it("excludes loaned-in and loaned-out players from system liquidation (§28/§68)", () => {
    const club = makeClubFn(1, { cash: 2_000_000 });
    const other = makeClubFn(2, { cash: 50_000_000 });
    const rng = createRng(12);
    const p1 = clubPlayer(rng, club, 10, { salary: 6_000_000, value: 8_000_000, payrollPaidThroughDay: 0 });
    const p2 = clubPlayer(rng, club, 11, { salary: 5_000_000, value: 7_000_000, payrollPaidThroughDay: 0 });
    // p1 is loaned OUT to `other`.
    p1.clubId = other.id;
    p1.loanId = 100;
    const world = makeWorld([club, other], [p1, p2]);
    world.loans.push({ id: 100, playerId: p1.id, fromClubId: club.id, toClubId: other.id, startDay: 1, endDay: 30, recalled: false, listedAt: 1, claimableAt: 1 });
    // p2 is loaned IN from `other`.
    const p3 = clubPlayer(rng, other, 12, { salary: 5_000_000, value: 7_000_000, payrollPaidThroughDay: 0 });
    p3.clubId = club.id;
    p3.loanId = 101;
    world.players.push(p3);
    world.loans.push({ id: 101, playerId: p3.id, fromClubId: other.id, toClubId: club.id, startDay: 1, endDay: 30, recalled: false, listedAt: 1, claimableAt: 1 });

    const result = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const liquidated = result.intervention.entries.filter((e) => e.kind === "SYSTEM_LIQUIDATION").map((e) => e.playerId);
    expect(liquidated).not.toContain(p1.id); // loaned out
    expect(liquidated).not.toContain(p3.id); // loaned in
  });

  it("cancels no-bid outgoing auctions and settles ones with bids (§23-§26/§67)", () => {
    const club = makeClubFn(1, { cash: 2_000_000 });
    const buyer = makeClubFn(2, { cash: 50_000_000 });
    const rng = createRng(13);
    const p1 = clubPlayer(rng, club, 10, { salary: 6_000_000, value: 8_000_000, payrollPaidThroughDay: 0 });
    const p2 = clubPlayer(rng, club, 11, { salary: 5_000_000, value: 7_000_000, payrollPaidThroughDay: 0 });
    const world = makeWorld([club, buyer], [p1, p2]);
    // p1 is listed with no bids; p2 is listed with a bid.
    const noBid = createTransferAuction(world, { player: p1, sellerClub: club, sellerDivision: 2, totalDivisions: 3 });
    const withBid = createTransferAuction(world, { player: p2, sellerClub: club, sellerDivision: 2, totalDivisions: 3, openingPrice: 4_500_000 });
    if (!noBid.ok || !withBid.ok) throw new Error("listing failed");
    const bid = applyMaxBid(world, { listing: withBid.listing, club: buyer, player: p2, proposedMaximum: 5_000_000, buyerDivision: 1, immediateAvailableCash: 50_000_000 });
    expect(bid.ok).toBe(true);

    const result = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(result.ok).toBe(true);
    // No-bid listing cancelled; with-bid settled at the clearing price.
    expect(noBid.listing.status).toBe("CANCELLED");
    const cancelledEntry = result.ok ? result.intervention?.entries.find((entry) => entry.kind === "FORCED_AUCTION_CANCELLED") : undefined;
    expect(cancelledEntry?.replacementPlayerId).toBeNull();
    expect(withBid.listing.status).toBe("COMPLETED");
    expect(withBid.listing.winningClubId).toBe(buyer.id);
    expect(withBid.listing.finalPrice).toBe(withBid.listing.openingPrice);
    const settledEntry = result.ok ? result.intervention?.entries.find((entry) => entry.kind === "FORCED_AUCTION") : undefined;
    expect(settledEntry?.replacementPlayerId).not.toBeNull();
  });

  it("keeps the club able to cover remaining commitments after intervention (§21)", () => {
    const { world, club } = distressedClub();
    const result = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(result.ok).toBe(true);
    const cushion = getFinancialCushion(world, club);
    expect(cushion).toBeGreaterThanOrEqual(0);
  });
});

describe("provisional clubs (§7/§76)", () => {
  it("uses the funded upcoming-season salary horizon while wages are frozen", () => {
    const club = makeClubFn(1, { cash: 50_000_000, competitionState: "PROVISIONAL" });
    const rng = createRng(14);
    const p = clubPlayer(rng, club, 10, { salary: 5_000_000, payrollPaidThroughDay: 0 });
    const world = makeWorld([club], [p]);
    world.mp.seasonId = 1;
    expect(remainingSalaryCommitments(world, club)).toBe(5_000_000);
    expect(getFinancialCushion(world, club)).toBe(45_000_000);
    // No intervention while salaries are frozen.
    const res = runFinancialIntervention(world, club, { seasonId: 1, payrollCycleId: 7 });
    expect(res.ok).toBe(false);
  });
});

describe("payroll grace period (§19/§65/§66)", () => {
  it("records one intervention execution type when multiple clubs intervene on the same payroll date", () => {
    const firstClub = makeClubFn(1, { cash: -1_000_000 });
    const secondClub = makeClubFn(2, { cash: -2_000_000 });
    const world = makeWorld([firstClub, secondClub], []);
    world.mp.seasonId = 1;

    const result = processDailyDate(world, { date: "2026-01-07", now: Date.UTC(2026, 0, 7) });

    expect(world.financialInterventions).toHaveLength(2);
    expect(result.executed.filter((type) => type === "FINANCIAL_INTERVENTION")).toHaveLength(1);
  });

  it("does not intervene when the first payroll turns cash negative, but does at the next negative payroll", () => {
    const club = makeClubFn(1, { cash: 500_000 });
    const player = clubPlayer(createRng(15), club, 10, { salary: 3_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    const world = makeWorld([club], [player]);
    world.mp.seasonId = 1;

    processDailyDate(world, { date: "2026-01-07", now: Date.UTC(2026, 0, 7) });
    expect(club.cash).toBeLessThan(0);
    expect(world.financialInterventions).toHaveLength(0);

    processDailyDate(world, { date: "2026-01-14", now: Date.UTC(2026, 0, 14) });
    expect(world.financialInterventions).toHaveLength(1);
  });

  it("skips intervention when income restores cash during the grace period", () => {
    const club = makeClubFn(1, { cash: 500_000 });
    const player = clubPlayer(createRng(16), club, 10, { salary: 3_000_000, payrollPaidThroughDay: 0, payrollPaidAmount: 0, payrollPeriodStartDay: 0 });
    const world = makeWorld([club], [player]);
    world.mp.seasonId = 1;
    processDailyDate(world, { date: "2026-01-07", now: Date.UTC(2026, 0, 7) });
    club.cash += 5_000_000;
    processDailyDate(world, { date: "2026-01-14", now: Date.UTC(2026, 0, 14) });
    expect(club.cash).toBeGreaterThanOrEqual(0);
    expect(world.financialInterventions).toHaveLength(0);
  });
});
