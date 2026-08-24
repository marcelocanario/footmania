import { describe, it, expect } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { initSeason, createDivision, createFillerAI, ensureDivisionFull } from "../src/game/multiplayer";
import { isEphemeralAI } from "../src/game/club";
import { SENIOR_SQUAD_LIMIT } from "../src/game/constants";
import { gameConfig, MP_CONFIG } from "../src/config";
import type { Loan, TransferAuction } from "../src/game/types";
import { settlePlayerPayroll } from "../src/game/payroll";
import { processGameDayPayroll, processGameDayStart, processGameDayWeekly } from "../src/game/daily";
import { processSeasonEndContracts, processSeasonalAcademyIntake, commitSeasonRollover } from "../src/game/season";
import { removeFillerClubs } from "../src/services/mpService";
import type { World } from "../src/game/types";
import { FEATURED_COUNTRIES } from "../src/game/countries";

function worldWithAI(seed = 42): World {
  const world = generateWorld(seed);
  initSeason(world, { year: 2026, month: 1 }, 1);
  return world;
}

describe("ephemeral filler-AI clubs (invariant #28)", () => {
  it("generates a full senior roster with no academy players and zero cash", () => {
    const world = worldWithAI(1);
    const ai = createFillerAI(world, 1, 1);
    expect(isEphemeralAI(ai)).toBe(true);
    expect(FEATURED_COUNTRIES.some((country) => country.code === ai.country)).toBe(true);
    expect(ai.cash).toBe(0);
    const seniors = world.players.filter((p) => p.clubId === ai.id && !p.isYouth);
    const youth = world.players.filter((p) => p.clubId === ai.id && p.isYouth);
    expect(seniors.length).toBe(SENIOR_SQUAD_LIMIT);
    expect(youth).toHaveLength(0);
    // Contracts outlast the single season: no expiry can fire mid-season.
    expect(seniors.every((p) => p.contractDays > 0)).toBe(true);
  });

  it("never pays wages and never enters financial interventions across a payroll", () => {
    const world = worldWithAI(2);
    const ai = world.clubs.find((c) => isEphemeralAI(c))!;
    processGameDayPayroll(world, 6, Date.UTC(2026, 0, 7));
    expect(ai.cash).toBe(0);
    expect(ai.ledger.expense).toHaveLength(0);
    expect(world.financialInterventions.filter((i) => i.clubId === ai.id)).toHaveLength(0);
    // Direct settlement calls are also inert.
    const player = world.players.find((p) => p.clubId === ai.id)!;
    expect(settlePlayerPayroll(world, player, 30)).toBe(0);
    expect(player.payrollPaidAmount).toBe(0);
  });

  it("does not renew, expire or promote AI players in the weekly cycle", () => {
    const world = worldWithAI(3);
    const ai = world.clubs.find((c) => isEphemeralAI(c))!;
    const snapshot = (w: World) =>
      w.players
        .filter((p) => p.clubId === ai.id)
        .map((p) => ({ id: p.id, salary: p.salary, contractDays: p.contractDays }))
        .sort((a, b) => a.id - b.id);

    const before = snapshot(world);
    processGameDayStart(world, 6, Date.UTC(2026, 0, 7));
    processGameDayWeekly(world, 6); // weeklyUpdate + contractCycle
    expect(snapshot(world)).toEqual(before);
    expect(world.players.some((p) => p.clubId === ai.id && p.isYouth)).toBe(false);
  });

  it("is skipped by the seasonal academy intake and roster top-up", () => {
    const world = worldWithAI(4);
    const ai = world.clubs.find((c) => isEphemeralAI(c))!;
    world.mp.seasonId = 7;
    const idsBefore = new Set(world.players.filter((p) => p.clubId === ai.id).map((p) => p.id));
    expect(idsBefore.size).toBe(SENIOR_SQUAD_LIMIT);

    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    commitSeasonRollover(world);

    const after = world.players.filter((p) => p.clubId === ai.id);
    expect(after.map((p) => p.id).sort((a, b) => a - b)).toEqual([...idsBefore].sort((a, b) => a - b));
    expect(after.every((p) => !p.isYouth)).toBe(true);
  });

  it("cannot list, bid or claim through the shared market transitions (invariant #28)", async () => {
    const world = worldWithAI(6);
    const ai = world.clubs.find((c) => isEphemeralAI(c))!;
    const human = createHumanClub(world, { userId: 9601, clubName: "Human FC", country: "BRA" });
    const aiPlayer = world.players.find((p) => p.clubId === ai.id && !p.isYouth)!;
    const humanPlayer = world.players.find((p) => p.clubId === human.id && !p.isYouth)!;
    const { applyMaxBid } = await import("../src/game/market");
    const { offerPlayerForLoan, claimLoan } = await import("../src/game/loans");
    const { applyFreeAgentBid, createFreeAgentListing } = await import("../src/game/freeAgents");

    // Satisfy the new-club outbound sell lock so HUMAN listings succeed.
    const division = world.competitions.find((candidate) => candidate.kind === "division")!;
    for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
      world.fixtures.push({
        id: world.nextId++,
        competitionId: division.id,
        round,
        homeClubId: human.id,
        awayClubId: -human.id,
        dayIndex: round,
        played: true,
      });
    }

    // Selling / loaning out is rejected outright.
    const listed = await import("../src/game/market").then(({ createTransferAuction }) =>
      createTransferAuction(world, { player: aiPlayer, sellerClub: ai, sellerDivision: 1, totalDivisions: 1 }),
    );
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error).toContain("AI clubs cannot list players for transfer");
    const offered = offerPlayerForLoan(world, ai, aiPlayer, { now: Date.now() });
    expect(offered.ok).toBe(false);
    if (!offered.ok) expect(offered.error).toContain("AI clubs cannot list players for loan");

    // Bidding on a human transfer listing is rejected outright.
    const humanListing = await import("../src/game/market").then(({ createTransferAuction }) =>
      createTransferAuction(world, { player: humanPlayer, sellerClub: human, sellerDivision: 1, totalDivisions: 1 }),
    );
    if (!humanListing.ok) throw new Error(humanListing.error);
    const bid = applyMaxBid(world, {
      listing: humanListing.listing,
      club: ai,
      player: humanPlayer,
      proposedMaximum: 1_000_000,
      buyerDivision: 1,
      immediateAvailableCash: 10_000_000,
    });
    expect(bid.ok).toBe(false);
    if (!bid.ok) expect(bid.error).toContain("AI clubs cannot bid");

    // Bidding on human free-agent supply is rejected outright (different
    // player than the transfer listing above: one listing per player).
    const fa = world.players.find((p) => p.clubId === human.id && !p.isYouth && p.id !== humanPlayer.id)!;
    fa.clubId = null;
    fa.onSale = false;
    const faListing = createFreeAgentListing(world, fa, { now: Date.now() });
    if (!faListing.ok) throw new Error(faListing.error);
    const faBid = applyFreeAgentBid(world, { listing: faListing.listing, club: ai, player: fa, proposedMaximum: 100_000, immediateAvailableCash: 10_000_000 });
    expect(faBid.ok).toBe(false);
    if (!faBid.ok) expect(faBid.error).toContain("AI clubs cannot sign free agents");

    // A legacy loan listing posted by a human cannot be claimed by AI either.
    const ownerClub = human;
    const ownerPlayer = world.players.find((p) => p.clubId === ownerClub.id && !p.isYouth && p.loanId === null && p.id !== humanPlayer.id)!;
    const offeredByHuman = offerPlayerForLoan(world, ownerClub, ownerPlayer, { now: Date.now() });
    if (!offeredByHuman.ok) throw new Error(offeredByHuman.error);
    offeredByHuman.loan.claimableAt = Date.now() - 1;
    const claimed = claimLoan(world, ai, offeredByHuman.loan, { now: Date.now() });
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.error).toContain("AI clubs cannot claim loans");
  });

  it("is replaced wholesale by fresh teams at rollover (never survives a season)", () => {
    const world = worldWithAI(5);
    const beforeIds = world.clubs.filter((c) => isEphemeralAI(c)).map((c) => c.id);
    expect(beforeIds.length).toBeGreaterThan(0);

    // DIVISION_RESTRUCTURE destroys every surviving filler...
    removeFillerClubs(world);
    expect(world.clubs.some((c) => isEphemeralAI(c))).toBe(false);
    for (const id of beforeIds) {
      expect(world.clubs.some((c) => c.id === id)).toBe(false);
      expect(world.players.some((p) => p.clubId === id)).toBe(false);
    }

    // ...and the rebuilt division is filled with brand-new fillers.
    const ref = { year: 2026, month: 2 };
    const div = createDivision(world, { tier: 1, groupIndex: 0, seasonId: 99, ref });
    ensureDivisionFull(world, div);
    const fresh = world.clubs.filter((c) => isEphemeralAI(c));
    expect(fresh).toHaveLength(8);
    expect(fresh.every((c) => !beforeIds.includes(c.id))).toBe(true);
    expect(fresh.every((c) => c.cash === 0)).toBe(true);
  });

  it("never receives sale or loan-fee cash, even via force-settled or legacy listings", async () => {
    const world = worldWithAI(7);
    const ai = world.clubs.find((c) => isEphemeralAI(c))!;
    const human = createHumanClub(world, { userId: 9602, clubName: "Buyer FC", country: "BRA" });
    human.cash = 10_000_000;
    const { applyMaxBid, settleTransferAuction } = await import("../src/game/market");
    const { claimLoan } = await import("../src/game/loans");
    const now = Date.now();

    // Raw pre-B3 state: an active transfer listing owned by the filler with a
    // live human bid. Force-settling it must charge the buyer but never credit
    // the ephemeral seller (invariant #28).
    const aiPlayer = world.players.find((p) => p.clubId === ai.id && !p.isYouth)!;
    const listing: TransferAuction = {
      id: world.nextId++,
      playerId: aiPlayer.id,
      sellerClubId: ai.id,
      playerValueAtListing: aiPlayer.value,
      openingPrice: 100_000,
      bidIncrement: 10_000,
      sellerDivisionAtListing: 1,
      totalDivisionsAtListing: 1,
      currentPrice: 100_000,
      leadingClubId: null,
      createdAt: now,
      deadline: now + 3_600_000,
      originalDeadline: now + 3_600_000,
      status: "ACTIVE",
      completedAt: null,
      winningClubId: null,
      finalPrice: null,
      cancelledAt: null,
      softClosed: false,
    };
    world.transferAuctions.push(listing);
    const bid = applyMaxBid(world, {
      listing,
      club: human,
      player: aiPlayer,
      proposedMaximum: 1_000_000,
      buyerDivision: 1,
      immediateAvailableCash: human.cash,
    });
    if (!bid.ok) throw new Error(bid.error);
    const cashBeforeSettlement = human.cash;
    const settled = settleTransferAuction(world, listing, now, { forceClose: true });
    expect(settled.ok).toBe(true);
    if (!settled.ok || settled.finalPrice === null) throw new Error("force settlement failed");
    expect(aiPlayer.clubId).toBe(human.id);
    expect(human.cash).toBe(cashBeforeSettlement - settled.finalPrice);
    expect(ai.cash).toBe(0);
    expect(ai.ledger.income).toHaveLength(0);

    // A legacy AI-owned loan listing with a fee burns the fee on claim instead
    // of crediting the filler lender.
    const loanPlayer = world.players.find((p) => p.clubId === ai.id && !p.isYouth && p.id !== aiPlayer.id)!;
    const loan: Loan = {
      id: world.nextId++,
      playerId: loanPlayer.id,
      fromClubId: ai.id,
      toClubId: null,
      startDay: 0,
      endDay: gameConfig.seasonDays - 1,
      recalled: false,
      feeAmount: 250_000,
      listedAt: now,
      claimableAt: now - 1_000,
    };
    world.loans.push(loan);
    const claimed = claimLoan(world, human, loan, { now });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.error);
    expect(loanPlayer.clubId).toBe(human.id);
    expect(human.cash).toBe(cashBeforeSettlement - settled.finalPrice - 250_000);
    expect(ai.cash).toBe(0);
    expect(ai.ledger.income).toHaveLength(0);
  });
});
