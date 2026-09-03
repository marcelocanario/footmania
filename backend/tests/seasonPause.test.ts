import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

import { makeClub, makeWorld } from "./helpers";
import { applyLaunchHoldResume, applyResumeShift, countStrandedKickoffs, isLaunchHold, isPaused, pausedInstant } from "../src/services/seasonPause";
import { DAY_MS, boundariesElapsed, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "../src/services/dayBoundary";
import { emptyStandingsRow } from "../src/game/league";
import { roundDayIndex } from "../src/services/seasonCalendar";
import type { Competition, LiveMatchState, TransferAuction, FreeAgentListing, Loan, Fixture } from "../src/game/types";

const PAUSED_AT = 1_000_000;
const RAW_SHIFT = 50_000;
// Sep 2 2026 00:00 UTC — a boundary instant.
const BASE = Date.UTC(2026, 8, 2);

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

/** A fixture on a half-hour slot of the given game day (season-day-index). */
function dayFixture(id: number, day: number, slot: number, anchor = BASE): Fixture {
  return {
    id,
    competitionId: 900_001,
    round: day,
    homeClubId: 1,
    awayClubId: -1,
    dayIndex: day,
    scheduledSeasonDayIndex: day,
    played: false,
    kickoffAt: anchor + day * DAY_MS + slot * 30 * 60 * 1000,
  } as Fixture;
}

describe("season pause (freeze timers)", () => {
  it("reports pause state and launch-hold state", () => {
    const world = makeWorld([makeClub()], [], { fixtures: [] });
    expect(isPaused(world)).toBe(false);
    expect(pausedInstant(world)).toBeNull();
    // No played fixtures and no completed rounds: a launch hold.
    expect(isLaunchHold(world)).toBe(true);

    world.mp.pausedAt = PAUSED_AT;
    expect(isPaused(world)).toBe(true);
    expect(pausedInstant(world)).toBe(PAUSED_AT);

    // Any played fixture ends the hold.
    world.fixtures.push(dayFixture(11, 0, 8));
    world.fixtures[0].played = true;
    expect(isLaunchHold(world)).toBe(false);

    // ...unless the world is still waiting for its first manager: archived
    // fixtures of earlier seasons linger, so the flag alone decides.
    world.mp.awaitingFirstHuman = true;
    expect(isLaunchHold(world)).toBe(true);
  });

  it("a pause crossing NO boundary leaves the kickoff grid untouched while real-time anchors shift by rawShift", () => {
    const world = makeWorld([makeClub()], []);
    const fixture = dayFixture(11, 0, 8);
    world.fixtures.push(fixture);
    world.transferAuctions.push(activeAuction());
    world.freeAgentListings.push(activeListing());
    world.loans.push(openLoan());
    world.liveMatches.push(liveMatch());
    const club = world.clubs[0];
    club.lastMeaningfulActivityAt = PAUSED_AT - 20_000;
    club.abandonmentEligibleAt = PAUSED_AT - 5_000;
    club.liveMatchAt = PAUSED_AT + 100;
    world.mp.lastAdvancedAt = PAUSED_AT - 60 * 60 * 1000;
    world.mp.seasonStartAt = BASE;
    world.mp.lastBoundaryAt = BASE;

    // gridShift = 0: the pause swallowed no boundary.
    applyResumeShift(world, RAW_SHIFT, 0);

    // The kickoff grid, the day anchor and the boundary grid stay put.
    expect(fixture.kickoffAt).toBe(BASE + 8 * 30 * 60 * 1000);
    expect(world.mp.seasonStartAt).toBe(BASE);
    expect(world.mp.lastBoundaryAt).toBe(BASE);
    expect(world.mp.lastAdvancedAt).toBe(PAUSED_AT - 60 * 60 * 1000);

    // Real-time timers move by the frozen interval, as before.
    expect(world.transferAuctions[0].deadline).toBe(PAUSED_AT + 1000 + RAW_SHIFT);
    expect(world.transferAuctions[0].originalDeadline).toBe(PAUSED_AT + 1000 + RAW_SHIFT);
    const listing = world.freeAgentListings[0];
    expect(listing.deadline).toBe(PAUSED_AT + 2000 + RAW_SHIFT);
    expect(listing.unclaimedSince).toBe(PAUSED_AT - 10 + RAW_SHIFT);
    const loan = world.loans[0];
    expect(loan.claimableAt).toBe(PAUSED_AT + 3000 + RAW_SHIFT);
    expect(loan.listedAt).toBe(PAUSED_AT - 5 + RAW_SHIFT);
    expect(world.liveMatches[0].lastAdvancedAt).toBe(PAUSED_AT + 100 + RAW_SHIFT);
    expect(club.liveMatchAt).toBe(PAUSED_AT + 100 + RAW_SHIFT);
    expect(club.lastMeaningfulActivityAt).toBe(PAUSED_AT - 20_000 + RAW_SHIFT);
    expect(club.abandonmentEligibleAt).toBe(PAUSED_AT - 5_000 + RAW_SHIFT);
  });

  it("a pause crossing THREE boundaries shifts fixtures and all three clock anchors by exactly 3 * DAY_MS", () => {
    const world = makeWorld([makeClub()], []);
    const fixture = dayFixture(11, 2, 12);
    const playedFixture = { ...dayFixture(12, 1, 4), played: true };
    world.fixtures.push(fixture, playedFixture);
    world.mp.lastAdvancedAt = BASE - 5 * DAY_MS;
    world.mp.seasonStartAt = BASE - 5 * DAY_MS;
    world.mp.lastBoundaryAt = BASE - 5 * DAY_MS;

    applyResumeShift(world, RAW_SHIFT, 3 * DAY_MS);

    // The unplayed kickoff moves with the grid; the slot within its day is
    // untouched (fixture was day 2 slot 12, now five days after the anchor).
    expect(fixture.kickoffAt).toBe(BASE + 5 * DAY_MS + 12 * 30 * 60 * 1000);
    // Completed fixtures stay immutable.
    expect(playedFixture.kickoffAt).toBe(BASE + DAY_MS + 4 * 30 * 60 * 1000);
    // All three clock anchors move by exactly the grid shift, and the
    // season anchor stays boundary-aligned.
    expect(world.mp.lastAdvancedAt).toBe(BASE - 5 * DAY_MS + 3 * DAY_MS);
    expect(world.mp.seasonStartAt).toBe(BASE - 5 * DAY_MS + 3 * DAY_MS);
    expect(world.mp.lastBoundaryAt).toBe(BASE - 5 * DAY_MS + 3 * DAY_MS);
    expect(dayBoundaryAtOrBefore(world.mp.seasonStartAt!)).toBe(world.mp.seasonStartAt);
  });

  it("a fixture whose match is live is not shifted with the grid", () => {
    const world = makeWorld([makeClub()], []);
    const liveFixture = dayFixture(11, 0, 6);
    const other = dayFixture(12, 1, 6);
    world.fixtures.push(liveFixture, other);
    world.liveMatches.push(liveMatch({ fixtureId: liveFixture.id }));
    world.mp.lastAdvancedAt = BASE - DAY_MS;
    world.mp.seasonStartAt = BASE - DAY_MS;
    world.mp.lastBoundaryAt = BASE - DAY_MS;

    applyResumeShift(world, RAW_SHIFT, DAY_MS);

    // The live fixture keeps its anchor (its pacing shifted by rawShift);
    // the unplayed fixture with no live match moves with the grid.
    expect(liveFixture.kickoffAt).toBe(BASE + 6 * 30 * 60 * 1000);
    expect(other.kickoffAt).toBe(BASE + 2 * DAY_MS + 6 * 30 * 60 * 1000);
    expect(world.liveMatches[0].lastAdvancedAt).toBe(PAUSED_AT + 100 + RAW_SHIFT);
  });

  it("keeps halftime anchors and is a no-op for zero shifts", () => {
    const world = makeWorld([makeClub()], []);
    world.liveMatches.push(liveMatch({ halftimeStartedAt: PAUSED_AT + 50 }));
    applyResumeShift(world, 0, 0);
    expect(world.liveMatches[0].lastAdvancedAt).toBe(PAUSED_AT + 100);

    applyResumeShift(world, RAW_SHIFT, 0);
    expect(world.liveMatches[0].halftimeStartedAt).toBe(PAUSED_AT + 50 + RAW_SHIFT);
  });

  it("cumulative-drift regression: three pause/resume cycles never leave the grid off the boundary", () => {
    const world = makeWorld([makeClub()], []);
    const fixture = dayFixture(11, 0, 8);
    world.fixtures.push(fixture);
    world.mp.lastAdvancedAt = BASE;
    world.mp.seasonStartAt = BASE;
    world.mp.lastBoundaryAt = BASE;

    // Three successive cycles, each resume at an awkward off-boundary instant.
    const cycles = [
      { pause: BASE + 2 * 3600 * 1000 + 13 * 60 * 1000, resume: BASE + 3 * 3600 * 1000 + 47 * 60 * 1000 },
      { pause: BASE + 5 * 3600 * 1000 + 1 * 60 * 1000, resume: BASE + 6 * 3600 * 1000 + 52 * 60 * 1000 },
      { pause: BASE + 22 * 3600 * 1000, resume: BASE + 24 * 3600 * 1000 + 17 * 60 * 1000 },
    ];
    for (const cycle of cycles) {
      const rawShift = cycle.resume - cycle.pause;
      const gridShift = boundariesElapsed(world.mp.lastBoundaryAt!, cycle.resume) * DAY_MS;
      applyResumeShift(world, rawShift, gridShift);
    }

    // The grid reference is boundary-aligned after every cycle...
    expect(dayBoundaryAtOrBefore(world.mp.lastBoundaryAt!)).toBe(world.mp.lastBoundaryAt);
    expect(dayBoundaryAtOrBefore(world.mp.seasonStartAt!)).toBe(world.mp.seasonStartAt);
    // ...and the pending advance row the resume would write is an exact
    // zero-second instant (the 6:13:52 -> 8:01:26 drift must not reproduce).
    const nextAdvance = nextDayBoundaryAfter(world.mp.lastBoundaryAt!);
    const d = new Date(nextAdvance);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
    // Exactly one boundary between the grid reference and the next advance.
    expect(boundariesElapsed(world.mp.lastBoundaryAt!, nextAdvance)).toBe(1);
  });

  it("lost-day regression: a resume crossing the rollover hour yields exactly one boundary, never two days out", () => {
    // lastBoundaryAt = Sep 2 00:00; pause starts Sep 2 23:00 and the resume
    // (Sep 3 00:47) carries lastAdvancedAt across the rollover hour. The old
    // code derived the boundary from the shifted lastAdvancedAt and silently
    // ran the current day for 48 h; the grid shift must not.
    const world = makeWorld([makeClub()], []);
    const pausedAt = BASE + 23 * 3600 * 1000; // Sep 2 23:00
    const resumedAt = BASE + DAY_MS + 47 * 60 * 1000; // Sep 3 00:47
    world.mp.lastAdvancedAt = BASE;
    world.mp.seasonStartAt = BASE;
    world.mp.lastBoundaryAt = BASE;

    const gridShift = boundariesElapsed(world.mp.lastBoundaryAt, resumedAt) * DAY_MS;
    applyResumeShift(world, resumedAt - pausedAt, gridShift);

    expect(world.mp.lastBoundaryAt).toBe(BASE + DAY_MS); // Sep 3 00:00
    // The current game day [Sep 3 00:00, Sep 4 00:00) is a normal single day:
    // exactly one boundary was consumed by the shift, none is pending inside
    // the resumed day, and exactly one more is due at the next rollover.
    expect(gridShift).toBe(DAY_MS);
    expect(boundariesElapsed(world.mp.lastBoundaryAt, resumedAt)).toBe(0);
    expect(nextDayBoundaryAfter(world.mp.lastBoundaryAt)).toBe(BASE + 2 * DAY_MS);
    expect(boundariesElapsed(world.mp.lastBoundaryAt, BASE + 2 * DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(world.mp.lastBoundaryAt, BASE + 2 * DAY_MS)).toBe(1);
  });

  it("launch hold: lifting at Sep 10 23:59 anchors the season to Sep 11 00:00 with nothing stranded", () => {
    const world = makeWorld([makeClub()], [], { fixtures: [] });
    const resumedAt = BASE + 8 * DAY_MS + 23 * 3600 * 1000 + 59 * 60 * 1000; // Sep 10 23:59
    // Divisions created during the hold anchored fixtures to the OLD seasonStartAt.
    world.mp.seasonStartAt = BASE - DAY_MS;
    world.mp.lastAdvancedAt = BASE - DAY_MS;
    world.mp.lastBoundaryAt = BASE - DAY_MS;
    // These belong to the division below, so the lift RE-TIMES them against
    // the roster. An orphan fixture (no matching division) is covered further
    // down: it still gets realigned onto the new anchor rather than left behind.
    const dayZero = { ...dayFixture(11, 0, 8, BASE - DAY_MS), competitionId: 501 };
    const dayOne = { ...dayFixture(12, 1, 16, BASE - DAY_MS), competitionId: 501 };
    const orphan = dayFixture(13, 0, 8, BASE - DAY_MS);
    const comp: Competition = {
      id: 501,
      kind: "division",
      name: "1",
      round: 0,
      stage: "group",
      seasonId: 1,
      tier: 1,
      groupIndex: 0,
      status: "ACTIVE",
      config: { clubs: [1], turns: 2, groups: [], bracket: [], promoted: 0, relegated: 0, groupQualifiers: 0 },
      standings: { 1: emptyStandingsRow(1) },
      groupStandings: [],
      winners: [],
      knockouts: [],
    };
    world.competitions.push(comp);
    world.fixtures.push(dayZero, dayOne, orphan);
    world.mp.completedRounds = 0;

    applyLaunchHoldResume(world, resumedAt);

    const seasonBoundary = nextDayBoundaryAfter(resumedAt);
    expect(seasonBoundary).toBe(BASE + 9 * DAY_MS); // Sep 11 00:00
    expect(world.mp.seasonStartAt).toBe(seasonBoundary);
    expect(world.mp.lastBoundaryAt).toBe(seasonBoundary);
    expect(world.mp.lastAdvancedAt).toBe(resumedAt);
    // Day indices stay untouched.
    expect(world.mp.seasonDayIndex ?? world.dayIndex).toBe(0);

    // Every fixture is re-timed onto the 30-minute boundary grid inside its
    // own game day (the roster is unconstrained here, so the seeded spread
    // chooses the slot — no match has played, so this is equivalent to a
    // fresh generation).
    // Re-timing places a fixture on its ROUND's canonical day (roundDayIndex),
    // which is how generation placed it too — not on the fixture's own label.
    for (const fixture of [dayZero, dayOne]) {
      const dayStart = seasonBoundary + roundDayIndex(fixture.round) * DAY_MS;
      expect(fixture.kickoffAt!).toBeGreaterThanOrEqual(dayStart);
      expect(fixture.kickoffAt!).toBeLessThan(dayStart + DAY_MS);
      expect((fixture.kickoffAt! - dayStart) % (30 * 60 * 1000)).toBe(0);
    }

    // The orphan is not part of any re-timed division, but it must still be
    // moved onto the new anchor — a fixture left pointing at the OLD
    // seasonStartAt would sit outside its game day and wedge the advance.
    expect(orphan.kickoffAt).toBe(seasonBoundary + 8 * 30 * 60 * 1000);

    // Nothing is stranded and no advance fires before Sep 12 00:00.
    expect(countStrandedKickoffs(world, resumedAt)).toBe(0);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS)).toBe(1);
  });

  it("launch-hold resume still shifts real-time anchors by the held interval", () => {
    // The launch-hold lift anchors the grid absolutely, but market deadlines
    // and inactivity countdowns created before the hold must still freeze
    // for exactly the held interval — otherwise they expire across it. This
    // is the composition resumeSeason (and liftLaunchHoldIfComplete) performs:
    // rawShift for real-time anchors, then the absolute grid anchor.
    const world = makeWorld([makeClub()], [], { fixtures: [] });
    const resumedAt = BASE + 8 * DAY_MS + 23 * 3600 * 1000 + 59 * 60 * 1000;
    const pausedAt = resumedAt - RAW_SHIFT;
    world.mp.seasonStartAt = BASE - DAY_MS;
    world.mp.lastAdvancedAt = BASE - DAY_MS;
    world.mp.lastBoundaryAt = BASE - DAY_MS;
    world.mp.completedRounds = 0;
    const auction = activeAuction({ deadline: pausedAt + 1000, originalDeadline: pausedAt + 1000, createdAt: pausedAt - 10 });
    world.transferAuctions.push(auction);
    world.clubs[0].lastMeaningfulActivityAt = pausedAt - 20_000;

    applyResumeShift(world, RAW_SHIFT, 0);
    applyLaunchHoldResume(world, resumedAt);

    expect(auction.deadline).toBe(pausedAt + 1000 + RAW_SHIFT);
    expect(world.clubs[0].lastMeaningfulActivityAt).toBe(pausedAt - 20_000 + RAW_SHIFT);
    expect(world.mp.lastBoundaryAt).toBe(nextDayBoundaryAfter(resumedAt));
    expect(world.mp.seasonStartAt).toBe(world.mp.lastBoundaryAt);
    expect(world.mp.lastAdvancedAt).toBe(resumedAt);
  });

  it("literal maintenance rule: resuming at Sep 10 23:59 ends the day at Sep 11 00:00, at Sep 11 00:01 at Sep 12 00:00", () => {
    // Case 1: a 1-minute day.
    const world = makeWorld([makeClub()], []);
    world.mp.lastBoundaryAt = BASE; // Sep 2 00:00
    const resumedLate = BASE + 8 * DAY_MS + 23 * 3600 * 1000 + 59 * 60 * 1000; // Sep 10 23:59
    const gridLate = boundariesElapsed(world.mp.lastBoundaryAt, resumedLate) * DAY_MS;
    applyResumeShift(world, 0, gridLate);
    expect(world.mp.lastBoundaryAt).toBe(BASE + 8 * DAY_MS); // Sep 10 00:00
    expect(nextDayBoundaryAfter(world.mp.lastBoundaryAt)).toBe(BASE + 9 * DAY_MS); // Sep 11 00:00

    // Case 2: a full day.
    const world2 = makeWorld([makeClub()], []);
    world2.mp.lastBoundaryAt = BASE;
    const resumedEarly = BASE + 9 * DAY_MS + 60 * 1000; // Sep 11 00:01
    const gridEarly = boundariesElapsed(world2.mp.lastBoundaryAt, resumedEarly) * DAY_MS;
    applyResumeShift(world2, 0, gridEarly);
    expect(world2.mp.lastBoundaryAt).toBe(BASE + 9 * DAY_MS); // Sep 11 00:00
    expect(nextDayBoundaryAfter(world2.mp.lastBoundaryAt)).toBe(BASE + 10 * DAY_MS); // Sep 12 00:00
  });

  it("stranded count: resuming at 23:59 under the literal rule reports the current-day kickoffs already in the past", () => {
    const world = makeWorld([makeClub()], []);
    world.mp.seasonDayIndex = 0;
    world.mp.lastBoundaryAt = BASE;
    // The whole current day's grid: all 48 half-hour slots already behind
    // 23:59, so every kickoff would resolve instantly under the literal rule.
    for (let slot = 0; slot < 48; slot++) world.fixtures.push(dayFixture(100 + slot, 0, slot));
    const resumedLate = BASE + 23 * 3600 * 1000 + 59 * 60 * 1000;
    expect(countStrandedKickoffs(world, resumedLate)).toBe(48);

    // Resuming just after the boundary: the current day is the new day and
    // every kickoff is still ahead.
    const world2 = makeWorld([makeClub()], []);
    world2.mp.seasonDayIndex = 0;
    world2.mp.lastBoundaryAt = BASE + DAY_MS;
    for (let slot = 0; slot < 48; slot++) world2.fixtures.push(dayFixture(200 + slot, 0, slot, BASE + DAY_MS));
    // AT the boundary nothing is behind yet. A minute later the 00:00 kickoff
    // already is — which is exactly what the warning is for.
    expect(countStrandedKickoffs(world2, BASE + DAY_MS)).toBe(0);
    expect(countStrandedKickoffs(world2, BASE + DAY_MS + 60 * 1000)).toBe(1);
  });

  it("counts only the CURRENT day's unplayed, not-live fixtures as stranded", () => {
    const world = makeWorld([makeClub()], []);
    world.mp.seasonDayIndex = 1;
    world.mp.lastBoundaryAt = BASE + DAY_MS;
    const past = dayFixture(1, 1, 4, BASE); // kickoff in the past
    const future = dayFixture(2, 1, 20, BASE); // kickoff ahead
    const played = { ...dayFixture(3, 1, 8, BASE), played: true };
    const live = dayFixture(4, 1, 12, BASE);
    const nextDay = dayFixture(5, 2, 6, BASE); // not the current day
    world.fixtures.push(past, future, played, live, nextDay);
    world.liveMatches.push(liveMatch({ fixtureId: live.id }));
    const now = BASE + DAY_MS + 6 * 3600 * 1000;
    expect(countStrandedKickoffs(world, now)).toBe(1);
  });
});
