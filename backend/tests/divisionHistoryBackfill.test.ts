import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { ensureGlobalSave, loadGlobalWorld, loadGlobalWorldMutable, persistWorld } from "../src/services/saveService";
import { ensureCurrentSeason } from "../src/services/mpService";
import { divisionHistoryChunkInput, executeDueEvents, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { highestRankedReplaceableAI, placeNewClub, replaceClubInDivision, simulateThroughRound } from "../src/game/multiplayer";
import { createHumanClub } from "../src/game/worldgen";
import { executeRolloverStep } from "../src/services/seasonRolloverService";
import type { World } from "../src/game/types";

const prisma = new PrismaClient();

async function freshWorld() {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  await ensureCurrentSeason(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

// Club.ownerUserId has an FK to User: every userId this file's tests use
// (1-8 filling Division 1, plus each test's late joiner) needs a real row.
// High, deliberately-namespaced ids: User.id auto-increments, so low
// explicit ids like 1-8 can collide with rows other tests/setup code let
// the DB assign (e.g. the lazily-created "system" user in ensureGlobalSave).
const TEST_USER_IDS = [950001, 950002, 950003, 950004, 950005, 950006, 950007, 950008, 950097, 950098, 950099, 950100];

/** Fill Division 1 with 8 humans so the NEXT join is forced to create a
 *  brand-new Division 2.1 -- the only branch of placeNewClub this feature
 *  touches (an EXISTING replaceable division never defers anything). */
function fillDivisionOneWithHumans(world: World) {
  const div1 = world.competitions.find((c) => c.kind === "division")!;
  for (const userId of TEST_USER_IDS.slice(0, 8)) {
    const club = createHumanClub(world, { userId, clubName: `Human ${userId}`, country: "BRA" });
    replaceClubInDivision(world, div1, highestRankedReplaceableAI(world, div1)!, club.id);
    club.competitionState = "ACTIVE";
  }
}

describe("division history backfill (chunked, off the join request)", () => {
  beforeEach(async () => {
    await prisma.scheduledEvent.deleteMany();
    await prisma.user.deleteMany({ where: { id: { in: TEST_USER_IDS } } });
    await prisma.user.createMany({
      data: TEST_USER_IDS.map((id) => ({ id, name: `Test User ${id}`, email: `division-backfill-${id}@test.dev`, emailVerified: true })),
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("defers a new division's history to a background job instead of simulating it inline", async () => {
    const { saveId, world } = await freshWorld();
    const seasonId = world.mp.seasonId;
    fillDivisionOneWithHumans(world);
    // 3 rounds already played elsewhere in the season -- this is exactly the
    // "late joiner" scenario simulateDivisionThroughRound's synchronous
    // in-lock backfill existed to handle.
    simulateThroughRound(world, 3, Date.now());
    expect(world.mp.completedRounds).toBe(3);
    // In real play those 3 rounds are completed via real live matches over
    // real time, so manualRound is never set; simulateThroughRound is only a
    // test-setup shortcut for "3 rounds already happened". Clear it so the
    // rest of this test exercises the genuine production path -- notably the
    // chunked backfill handler's own bypassKickoffGate, not this leftover
    // admin override standing in for it.
    world.mp.manualRound = null;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[8], clubName: "Late Joiner FC", country: "BRA" });
    const result = placeNewClub(loaded.world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (result.kind !== "active") throw new Error("expected active placement");
    const division = loaded.world.competitions.find((c) => c.id === result.divisionId)!;

    // The join itself is already complete -- the human IS placed -- but the
    // division's own history has NOT been simulated inline.
    expect(division.status).toBe("SIMULATING_HISTORY");
    const divisionFixtures = loaded.world.fixtures.filter((f) => f.competitionId === division.id);
    expect(divisionFixtures.length).toBeGreaterThan(0);
    expect(divisionFixtures.every((f) => !f.played)).toBe(true);
    expect(loaded.world.matches.some((m) => m.competitionId === division.id)).toBe(false);

    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    // Mirrors what routes/multiplayer.ts's POST /mp/join does once the join
    // is persisted: enqueue the first backfill chunk.
    await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, division.id, 1, 3));

    // Drain every chunk the way the worker would, one scheduler tick at a
    // time -- each DIVISION_HISTORY_SIMULATE handler enqueues the next round
    // with dueAt "now", so it is not due within the SAME executeDueEvents
    // pass (that function snapshots its due set once) and needs a fresh call
    // per round, exactly like this repo's other self-scheduling event chains
    // (MATCH_START -> MATCH_COMPLETE) are driven in tests/scheduler.test.ts.
    let guard = 0;
    while ((await executeDueEvents(prisma, saveId, new Date())) > 0 && guard++ < 20) {
      // keep draining
    }

    const after = await loadGlobalWorld(prisma);
    if (!after) throw new Error("world did not load");
    const finalDivision = after.world.competitions.find((c) => c.id === division.id)!;
    expect(finalDivision.status).toBe("ACTIVE");
    const finalFixtures = after.world.fixtures.filter((f) => f.competitionId === division.id && f.round < 3);
    expect(finalFixtures.every((f) => f.played)).toBe(true);
    const finalMatches = after.world.matches.filter((m) => m.competitionId === division.id);
    expect(finalMatches.length).toBe(finalFixtures.length);
    // Standings reflect the backfilled rounds, same as an instant
    // simulateDivisionThroughRound call would have produced.
    for (const row of Object.values(finalDivision.standings)) {
      expect(row.played).toBe(3);
    }
  });

  it("is idempotent: replaying an already-completed chunk changes nothing", async () => {
    const { saveId, world } = await freshWorld();
    const seasonId = world.mp.seasonId;
    fillDivisionOneWithHumans(world);
    simulateThroughRound(world, 2, Date.now());
    // See the first test's comment: clear the admin-override leftover so the
    // backfill this test drains exercises its own kickoff-gate bypass.
    world.mp.manualRound = null;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[9], clubName: "Idempotency FC", country: "BRA" });
    const result = placeNewClub(loaded.world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (result.kind !== "active") throw new Error("expected active placement");
    const divisionId = result.divisionId;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    // Schedule and fully drain the SAME first chunk twice (the second call
    // returns the existing row by idempotency key -- scheduleEvent's own
    // documented contract).
    const event = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, divisionId, 1, 2));
    const again = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, divisionId, 1, 2));
    expect(again.id).toBe(event.id);

    let guard = 0;
    while ((await executeDueEvents(prisma, saveId, new Date())) > 0 && guard++ < 20) {
      // keep draining
    }
    const afterFirstDrain = await loadGlobalWorld(prisma);
    if (!afterFirstDrain) throw new Error("world did not load");
    const matchesAfterFirst = afterFirstDrain.world.matches.filter((m) => m.competitionId === divisionId).length;

    // A second, fresh drain of an already-COMPLETED chunk must not
    // re-simulate anything (simulateDivisionThroughRound only ever acts on
    // unplayed fixtures).
    guard = 0;
    while ((await executeDueEvents(prisma, saveId, new Date())) > 0 && guard++ < 20) {
      // keep draining
    }
    const afterSecondDrain = await loadGlobalWorld(prisma);
    if (!afterSecondDrain) throw new Error("world did not load");
    const matchesAfterSecond = afterSecondDrain.world.matches.filter((m) => m.competitionId === divisionId).length;
    expect(matchesAfterSecond).toBe(matchesAfterFirst);
  });

  it("materializeSeasonEvents does not create MATCH_START for a division still backfilling its history", async () => {
    const { saveId, world } = await freshWorld();
    const seasonId = world.mp.seasonId;
    fillDivisionOneWithHumans(world);
    simulateThroughRound(world, 3, Date.now());
    // See the first test's comment: clear the admin-override leftover so the
    // backfill this test drains exercises its own kickoff-gate bypass.
    world.mp.manualRound = null;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[10], clubName: "Race Guard FC", country: "BRA" });
    const result = placeNewClub(loaded.world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (result.kind !== "active") throw new Error("expected active placement");
    const divisionId = result.divisionId;
    // generateDivisionFixtures schedules kickoffs relative to the SEASON's
    // start, not to "now" -- so a freshly-created division's own fixtures
    // are not naturally past-due yet, even though (per fillDivisionOneWithHumans
    // + simulateThroughRound above) 3 rounds have already elapsed elsewhere
    // in the season. Force the round-1 kickoffs into the past directly, the
    // same way real elapsed wall-clock time would once the season has moved
    // on: this is exactly the condition that would otherwise race the
    // backfill chunker into starting a live match instead of an instant
    // history result.
    for (const f of loaded.world.fixtures) {
      if (f.competitionId === divisionId && f.round === 0) f.kickoffAt = Date.now() - 1000;
    }
    const pastDueFixtureIds = new Set(
      loaded.world.fixtures.filter((f) => f.competitionId === divisionId && !f.played && f.kickoffAt !== undefined && f.kickoffAt <= Date.now()).map((f) => f.id),
    );
    expect(pastDueFixtureIds.size).toBeGreaterThan(0);
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    const reloaded = await loadGlobalWorld(prisma);
    if (!reloaded) throw new Error("world did not load");
    await materializeSeasonEvents(prisma, saveId, reloaded.world);

    const matchStarts = await prisma.scheduledEvent.findMany({ where: { saveId, type: ScheduledEventType.MATCH_START } });
    const racedFixtureIds = matchStarts.filter((e) => pastDueFixtureIds.has(Number(JSON.parse(e.payloadJson).fixtureId))).map((e) => e.id);
    expect(racedFixtureIds.length).toBe(0);
  });

  it("does not place a second concurrent joiner into a division still backfilling its history", async () => {
    const { saveId, world } = await freshWorld();
    const seasonId = world.mp.seasonId;
    fillDivisionOneWithHumans(world);
    simulateThroughRound(world, 3, Date.now());
    world.mp.manualRound = null;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    // First joiner: no existing division has room, so a brand-new one is
    // created and left SIMULATING_HISTORY (its backfill chunks are not
    // drained here -- this test deliberately checks the state BEFORE any
    // chunk runs, since that is exactly the window a concurrent second
    // joiner could otherwise land in).
    const loadedA = await loadGlobalWorldMutable(prisma);
    if (!loadedA) throw new Error("world did not load");
    const joinerA = createHumanClub(loadedA.world, { userId: TEST_USER_IDS[8], clubName: "First Joiner FC", country: "BRA" });
    const resultA = placeNewClub(loadedA.world, joinerA.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (resultA.kind !== "active") throw new Error("expected active placement");
    const divisionAId = resultA.divisionId;
    const divisionA = loadedA.world.competitions.find((c) => c.id === divisionAId)!;
    expect(divisionA.status).toBe("SIMULATING_HISTORY");
    // Division A still has 6 more replaceable AI slots (8 filler AI minus
    // the one joinerA just replaced) -- exactly the condition that would
    // let firstReplaceableAIDivision find it for a second joiner if it did
    // not skip SIMULATING_HISTORY divisions.
    expect(highestRankedReplaceableAI(loadedA.world, divisionA)).not.toBeNull();
    await persistWorld(prisma, loadedA.save.id, loadedA.save.id, loadedA.world, loadedA.save.revision);

    // Second, concurrent joiner -- arrives before division A's backfill has
    // drained a single chunk.
    const loadedB = await loadGlobalWorldMutable(prisma);
    if (!loadedB) throw new Error("world did not load");
    const joinerB = createHumanClub(loadedB.world, { userId: TEST_USER_IDS[11], clubName: "Second Joiner FC", country: "BRA" });
    const resultB = placeNewClub(loadedB.world, joinerB.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (resultB.kind !== "active") throw new Error("expected active placement");
    const divisionBId = resultB.divisionId;

    // Must be a DIFFERENT division from A's, not a second club stuffed into
    // A's still-backfilling one.
    expect(divisionBId).not.toBe(divisionAId);
    const divisionB = loadedB.world.competitions.find((c) => c.id === divisionBId)!;
    expect(divisionB.status).toBe("SIMULATING_HISTORY");
    // Division A itself must be untouched by joiner B's placement.
    const divisionAAfter = loadedB.world.competitions.find((c) => c.id === divisionAId)!;
    expect(Object.keys(divisionAAfter.standings)).toContain(String(joinerA.id));
    expect(Object.keys(divisionAAfter.standings)).not.toContain(String(joinerB.id));
  });

  it("refuses to finalize season results while a division is still backfilling its history", async () => {
    const { world } = await freshWorld();
    fillDivisionOneWithHumans(world);
    // Simulate a division stuck mid-backfill (its DIVISION_HISTORY_SIMULATE
    // chunks never drained) instead of driving the full join flow -- the
    // guard under test only cares about the status flag at rollover time.
    const div1 = world.competitions.find((c) => c.kind === "division")!;
    div1.status = "SIMULATING_HISTORY";

    await expect(executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE")).rejects.toThrow(/still backfilling/);
    // Nothing committed: the guard must fire before any archiving work, so a
    // retry later (once the backfill drains) sees a clean, unstarted step.
    expect(world.mp.rolloverPhase).not.toBe("RESULTS_FINALIZED");
  });
});
