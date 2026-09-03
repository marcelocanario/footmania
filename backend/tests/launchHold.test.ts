import { describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

import { makeClub, makeWorld } from "./helpers";
import { emptyStandingsRow } from "../src/game/league";
import { CLUBS_PER_DIVISION, createDivision, enterLaunchHold, ensureDivisionFull, generateDivisionFixtures, humanOwnedClubCount, shouldReleaseLaunchHold } from "../src/game/multiplayer";
import { applyLaunchHoldResume, applyResumeShift, isLaunchHold } from "../src/services/seasonPause";
import { DAY_MS, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "../src/services/dayBoundary";
import { roundDayIndex } from "../src/services/seasonCalendar";
import type { World } from "../src/game/types";

const BASE = Date.UTC(2026, 8, 2);

function ownedClubs(count: number, baseId = 100, baseUser = 1000, overrides: Partial<ReturnType<typeof makeClub>> = {}): ReturnType<typeof makeClub>[] {
  return Array.from({ length: count }, (_, i) =>
    makeClub({ id: baseId + i, ownerUserId: baseUser + i, ...overrides }),
  );
}

function heldWorldWithRoster(owned: number): World {
  const world = makeWorld(ownedClubs(owned), [], { fixtures: [] });
  enterLaunchHold(world, BASE);
  return world;
}

describe("launch hold (full roster)", () => {
  it("enters the hold and reports it via isLaunchHold", () => {
    const world = makeWorld([makeClub()], []); // seeded played fixtures exist
    expect(isLaunchHold(world)).toBe(false);
    enterLaunchHold(world, BASE);
    expect(world.mp.awaitingLaunchRoster).toBe(true);
    expect(world.mp.pausedAt).toBe(BASE);
    expect(isLaunchHold(world)).toBe(true);
    // Human clubs (including dormant ones) survive the hold; only filler AI
    // is removed.
    expect(humanOwnedClubCount(world)).toBe(1);
  });

  it("releases exactly at CLUBS_PER_DIVISION owned clubs, never one earlier", () => {
    const world = heldWorldWithRoster(CLUBS_PER_DIVISION - 1);
    expect(shouldReleaseLaunchHold(world)).toBe(false);
    world.clubs.push(makeClub({ id: 9000, ownerUserId: 9000 }));
    expect(humanOwnedClubCount(world)).toBe(CLUBS_PER_DIVISION);
    expect(shouldReleaseLaunchHold(world)).toBe(true);
  });

  it("counts DORMANT owned clubs toward the threshold", () => {
    const world = makeWorld(ownedClubs(CLUBS_PER_DIVISION - 1, 100, 1000, { competitionState: "DORMANT" }), [], { fixtures: [] });
    enterLaunchHold(world, BASE);
    expect(shouldReleaseLaunchHold(world)).toBe(false);
    world.clubs.push(makeClub({ id: 9000, ownerUserId: 9000, competitionState: "DORMANT" }));
    expect(shouldReleaseLaunchHold(world)).toBe(true);
  });

  it("never releases from the derived condition alone (no flag)", () => {
    // A pre-season world with no played fixture is a launch hold by the
    // derived test, but the roster-hold RELEASE requires the flag: an
    // admin-paused or force-released world must not be re-held.
    const world = makeWorld([], [], { fixtures: [] });
    expect(isLaunchHold(world)).toBe(true); // derived: nothing played
    expect(shouldReleaseLaunchHold(world)).toBe(false);
    world.clubs.push(...ownedClubs(CLUBS_PER_DIVISION));
    expect(shouldReleaseLaunchHold(world)).toBe(false); // flag never set
  });

  it("an abandonment during the hold does not release it, and one after the lift never re-arms it", () => {
    const world = heldWorldWithRoster(CLUBS_PER_DIVISION);
    // A club gone dormant during the hold stays owned (dormancy keeps
    // ownerUserId), so the roster can still complete...
    world.clubs[0].competitionState = "DORMANT";
    expect(shouldReleaseLaunchHold(world)).toBe(true); // still full
    // ...but a club truly gone (ownerless) leaves the hold in place.
    world.clubs[1].ownerUserId = null;
    expect(shouldReleaseLaunchHold(world)).toBe(false); // 7 of 8
    world.clubs[1].ownerUserId = 1001;

    // The lift (as the join route performs it) clears the flags...
    applyResumeShift(world, 0, 0);
    applyLaunchHoldResume(world, BASE);
    world.mp.pausedAt = null;
    world.mp.awaitingLaunchRoster = false;
    world.mp.awaitingFirstHuman = false;
    expect(world.mp.awaitingLaunchRoster).not.toBe(true);

    // ...and a departure after the lift never re-arms the hold, even if the
    // roster later completes again.
    world.clubs[1].ownerUserId = null;
    world.clubs[2].ownerUserId = null;
    expect(shouldReleaseLaunchHold(world)).toBe(false);
    world.clubs[1].ownerUserId = 9999;
    world.clubs[2].ownerUserId = 9998;
    expect(shouldReleaseLaunchHold(world)).toBe(false);
  });

  it("a world whose season has already played a fixture is not in a launch hold", () => {
    const world = makeWorld([makeClub()], []); // seedPlayedMatches marks some played
    expect(world.fixtures.some((f) => f.played)).toBe(true);
    expect(isLaunchHold(world)).toBe(false);
    expect(shouldReleaseLaunchHold(world)).toBe(false);
  });

  it("an early force release leaves the remaining slots as AI and re-times the fixtures", () => {
    const world = makeWorld([], [], { fixtures: [] });
    enterLaunchHold(world, BASE);
    world.mp.seasonStartAt = BASE;

    // Three managers joined during the hold; the division formed with AI
    // fillers and fixtures timed against the pre-hold anchor.
    for (const club of ownedClubs(3)) {
      world.clubs.push(club);
    }
    const comp = createDivision(world, { tier: 1, groupIndex: 0, seasonId: 1, ref: { year: 2026, month: 8 } });
    for (const club of world.clubs) comp.standings[club.id] = emptyStandingsRow(club.id);
    ensureDivisionFull(world, comp);
    const fixtures = generateDivisionFixtures(world, comp, { year: 2026, month: 8 });
    world.fixtures.push(...fixtures);
    comp.status = "ACTIVE";
    const fixtureIds = fixtures.map((f) => f.id);

    // resumeSeason's launch branch with force: raw shift, absolute anchor,
    // flags cleared. The roster stays under-strength.
    const resumedAt = BASE + 8 * DAY_MS + 23 * 3600 * 1000;
    applyResumeShift(world, 0, 0);
    applyLaunchHoldResume(world, resumedAt);
    world.mp.pausedAt = null;
    world.mp.awaitingLaunchRoster = false;
    world.mp.awaitingFirstHuman = false;

    const seasonBoundary = nextDayBoundaryAfter(resumedAt);
    expect(world.mp.seasonStartAt).toBe(seasonBoundary);
    expect(world.mp.lastBoundaryAt).toBe(seasonBoundary);
    expect(world.mp.awaitingLaunchRoster).not.toBe(true);
    // The remaining slots are still AI: 3 humans, 5 fillers.
    expect(humanOwnedClubCount(world)).toBe(3);
    expect(Object.keys(comp.standings).length).toBe(CLUBS_PER_DIVISION);
    // Fixtures kept their ids and were re-timed onto the boundary grid inside
    // their own game days (still deterministic for the partial roster).
    expect(world.fixtures.map((f) => f.id).sort((a, b) => a - b)).toEqual([...fixtureIds].sort((a, b) => a - b));
    for (const f of world.fixtures) {
      const dayStart = seasonBoundary + roundDayIndex(f.round) * DAY_MS;
      expect(f.kickoffAt!).toBeGreaterThanOrEqual(dayStart);
      expect(f.kickoffAt!).toBeLessThan(dayStart + DAY_MS);
      expect((f.kickoffAt! - dayStart) % (30 * 60 * 1000)).toBe(0);
    }
    // Day 1 has not started: the derived launch hold still reads true until a
    // match is played, and nothing is stranded.
    expect(isLaunchHold(world)).toBe(true);
    expect(dayBoundaryAtOrBefore(seasonBoundary)).toBe(seasonBoundary);
  });
});

describe("launch hold roster threshold reads CLUBS_PER_DIVISION, not a literal", () => {
  it("follows the configured division size when it differs from 8", async () => {
    vi.resetModules();
    // CLUBS_PER_DIVISION is `gameConfig.league.teams` captured at module
    // evaluation, so overriding the EXPORT cannot change what the module's own
    // functions read. Mock the config and re-evaluate the module instead —
    // that is what proves the threshold follows configuration.
    vi.doMock("../src/config", async (importOriginal) => {
      const mod = await importOriginal<typeof import("../src/config")>();
      return { ...mod, gameConfig: { ...mod.gameConfig, league: { ...mod.gameConfig.league, teams: 6 } } };
    });
    try {
      const mocked = await import("../src/game/multiplayer");
      expect(mocked.CLUBS_PER_DIVISION).toBe(6);
      const world = makeWorld(ownedClubs(5), [], { fixtures: [] });
      mocked.enterLaunchHold(world, BASE);
      expect(mocked.shouldReleaseLaunchHold(world)).toBe(false);
      world.clubs.push(makeClub({ id: 9100, ownerUserId: 9100 }));
      expect(mocked.shouldReleaseLaunchHold(world)).toBe(true);
      // A release point hardcoded at 8 would never fire with a 6-roster world.
      world.clubs[0].ownerUserId = null;
      world.clubs.push(makeClub({ id: 9101, ownerUserId: 9101 }));
      world.clubs.push(makeClub({ id: 9102, ownerUserId: 9102 }));
      expect(mocked.humanOwnedClubCount(world)).toBe(7);
      expect(mocked.shouldReleaseLaunchHold(world)).toBe(true); // 7 >= 6
    } finally {
      vi.doUnmock("../src/config");
      vi.resetModules();
    }
  });
});