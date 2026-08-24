import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

import { makeClub, makeWorld } from "./helpers";
import { applyResumeShift, isPaused, pausedInstant } from "../src/services/seasonPause";
import type { LiveMatchState, TransferAuction, FreeAgentListing, Loan, Fixture } from "../src/game/types";

const PAUSED_AT = 1_000_000;
const SHIFT = 50_000;

function activeAuction(overrides: Partial<TransferAuction> = {}): TransferAuction {
  return {
    id: 1,
    playerId: 1,
    sellerClubId: 1,
    playerValueAtListing: 1000,
    openingPrice: 500,
    bidIncrement: 10,
    sellerDivisionAtListing: 1,
    totalDivisionsAtListing: 1,
    currentPrice: 500,
    leadingClubId: null,
    createdAt: PAUSED_AT - 10,
    deadline: PAUSED_AT + 1000,
    originalDeadline: PAUSED_AT + 1000,
    status: "ACTIVE",
    completedAt: null,
    winningClubId: null,
    finalPrice: null,
    cancelledAt: null,
    softClosed: false,
    ...overrides,
  };
}

function activeListing(overrides: Partial<FreeAgentListing> = {}): FreeAgentListing {
  return {
    id: 2,
    playerId: 2,
    playerValueAtListing: 800,
    openingPrice: 300,
    bidIncrement: 5,
    currentPrice: 300,
    leadingClubId: null,
    relistStage: 0,
    createdAt: PAUSED_AT - 10,
    deadline: PAUSED_AT + 2000,
    status: "ACTIVE",
    completedAt: null,
    winningClubId: null,
    finalPrice: null,
    previousListingId: null,
    blockedClubId: null,
    unclaimedSince: PAUSED_AT - 10,
    softClosed: false,
    ...overrides,
  };
}

function openLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 3,
    playerId: 3,
    fromClubId: 1,
    toClubId: null,
    startDay: 0,
    endDay: 30,
    recalled: false,
    feeAmount: 10,
    listedAt: PAUSED_AT - 5,
    claimableAt: PAUSED_AT + 3000,
    ...overrides,
  };
}

/** Only the pacing fields matter here; the engine owns the rest. */
function liveMatch(overrides: Partial<LiveMatchState> = {}): LiveMatchState {
  return {
    matchId: 9,
    lastAdvancedAt: PAUSED_AT + 100,
    halftimeStartedAt: null,
    ended: false,
    ...overrides,
  } as unknown as LiveMatchState;
}

describe("season pause (freeze timers)", () => {
  it("reports pause state", () => {
    const world = makeWorld([makeClub()], []);
    expect(isPaused(world)).toBe(false);
    expect(pausedInstant(world)).toBeNull();

    world.mp.pausedAt = PAUSED_AT;
    expect(isPaused(world)).toBe(true);
    expect(pausedInstant(world)).toBe(PAUSED_AT);
  });

  it("shifts every active real-time anchor by the frozen interval", () => {
    const world = makeWorld([makeClub()], []);
    const fixture = {
      id: 11,
      competitionId: 900_001,
      round: 0,
      homeClubId: 1,
      awayClubId: -1,
      dayIndex: 0,
      played: false,
      kickoffAt: PAUSED_AT + 4000,
    } as Fixture;
    const playedFixture = { ...fixture, id: 12, played: true };
    world.fixtures.push(fixture, playedFixture);
    world.transferAuctions.push(activeAuction(), activeAuction({ status: "COMPLETED", deadline: PAUSED_AT - 999 }));
    world.freeAgentListings.push(activeListing());
    world.loans.push(openLoan());
    world.liveMatches.push(liveMatch());
    const club = world.clubs[0];
    club.lastMeaningfulActivityAt = PAUSED_AT - 20_000;
    club.abandonmentEligibleAt = PAUSED_AT - 5_000;
    club.liveMatchAt = PAUSED_AT + 100;
    world.mp.lastAdvancedAt = PAUSED_AT - 60 * 60 * 1000;
    world.mp.seasonStartAt = PAUSED_AT - 3 * 24 * 60 * 60 * 1000;

    applyResumeShift(world, SHIFT);

    // Unplayed kickoffs move; completed fixtures stay immutable.
    expect(fixture.kickoffAt).toBe(PAUSED_AT + 4000 + SHIFT);
    expect(playedFixture.kickoffAt).toBe(PAUSED_AT + 4000);

    expect(world.transferAuctions[0].deadline).toBe(PAUSED_AT + 1000 + SHIFT);
    expect(world.transferAuctions[0].originalDeadline).toBe(PAUSED_AT + 1000 + SHIFT);
    // Settled listings are history and must not move.
    expect(world.transferAuctions[1].deadline).toBe(PAUSED_AT - 999);

    const listing = world.freeAgentListings[0];
    expect(listing.deadline).toBe(PAUSED_AT + 2000 + SHIFT);
    expect(listing.unclaimedSince).toBe(PAUSED_AT - 10 + SHIFT);

    const loan = world.loans[0];
    expect(loan.claimableAt).toBe(PAUSED_AT + 3000 + SHIFT);
    expect(loan.listedAt).toBe(PAUSED_AT - 5 + SHIFT);

    expect(world.liveMatches[0].lastAdvancedAt).toBe(PAUSED_AT + 100 + SHIFT);
    expect(club.liveMatchAt).toBe(PAUSED_AT + 100 + SHIFT);
    expect(club.lastMeaningfulActivityAt).toBe(PAUSED_AT - 20_000 + SHIFT);
    expect(club.abandonmentEligibleAt).toBe(PAUSED_AT - 5_000 + SHIFT);

    // lastAdvancedAt moves WITH the shift so rollover boundary detection sees
    // zero missed days after a long pause.
    expect(world.mp.lastAdvancedAt).toBe(PAUSED_AT - 60 * 60 * 1000 + SHIFT);
    expect(world.mp.seasonStartAt).toBe(PAUSED_AT - 3 * 24 * 60 * 60 * 1000 + SHIFT);
  });

  it("keeps halftime anchors and is a no-op for zero shifts", () => {
    const world = makeWorld([makeClub()], []);
    world.liveMatches.push(liveMatch({ halftimeStartedAt: PAUSED_AT + 50 }));
    applyResumeShift(world, 0);
    expect(world.liveMatches[0].lastAdvancedAt).toBe(PAUSED_AT + 100);

    applyResumeShift(world, SHIFT);
    expect(world.liveMatches[0].halftimeStartedAt).toBe(PAUSED_AT + 50 + SHIFT);
  });
});
