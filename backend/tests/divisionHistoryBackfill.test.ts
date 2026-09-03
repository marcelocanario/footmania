import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { ensureGlobalSave, loadGlobalWorld, loadGlobalWorldMutable, persistWorld, StaleWorldError } from "../src/services/saveService";
import { ensureCurrentSeason, issueAllocation } from "../src/services/mpService";
import { divisionHistoryChunkInput, executeDueEvents, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { createLiveMatchState } from "../src/game/match";
import { resumeSeason } from "../src/services/seasonPause";
import {
  createDivision,
  ensureDivisionFull,
  generateDivisionFixtures,
  highestRankedReplaceableAI,
  lowestActiveTier,
  placeNewClub,
  recordActivity,
  replaceClubInDivision,
  returnDormantClub,
  simulateThroughRound,
  syncClubSeasons,
  syncMemberships,
  tierOf,
} from "../src/game/multiplayer";
import { createHumanClub } from "../src/game/worldgen";
import { executeRolloverStep } from "../src/services/seasonRolloverService";
import { gameConfig } from "../src/config";
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
const TEST_USER_IDS = [950001, 950002, 950003, 950004, 950005, 950006, 950007, 950008, 950097, 950098, 950099, 950100, 950101, 950102, 950103, 950104, 950105];

const NEXT_SEASON = { year: 2026, month: 2 };

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

/** A mid-season world frozen by an admin pause: Division 1 is full of humans,
 *  3 rounds are completed (elsewhere in the season, pre-freeze) and the world
 *  clock is held at `frozenAt`. Joiners while paused therefore create/join
 *  the tier-2 edge with the freeze anchoring every timestamp. */
async function pausedMidSeasonWorld(frozenAt: number) {
  const { saveId, world } = await freshWorld();
  const seasonId = world.mp.seasonId;
  fillDivisionOneWithHumans(world);
  simulateThroughRound(world, 3, Date.now());
  // simulateThroughRound is a test-setup shortcut; clear its admin override
  // (see the first test's comment) and freeze the world at frozenAt instead.
  world.mp.manualRound = null;
  world.mp.pausedAt = frozenAt;
  await persistWorld(prisma, saveId, saveId, world, undefined);
  return { saveId, seasonId, frozenAt };
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

  it("defers a new division's history to a background job instead of simulating it inline (while running)", async () => {
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

  it("does not place a second concurrent joiner into a division still backfilling its history (while running)", async () => {
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

  it("places a paused joiner and schedules one chunk-1 event anchored at the frozen instant", async () => {
    const frozenAt = Date.now() - 60_000;
    const { saveId, seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[8], clubName: "Paused Joiner FC", country: "BRA" });
    const result = placeNewClub(loaded.world, joiner.id, frozenAt, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");
    const division = loaded.world.competitions.find((c) => c.id === result.divisionId)!;
    expect(division.status).toBe("SIMULATING_HISTORY");
    // The paused joiner replaced an AI slot inside the fresh division.
    expect(Object.keys(division.standings)).toContain(String(joiner.id));
    expect(loaded.world.clubs.find((c) => c.id === result.replacedClubId)).toBeUndefined();
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    // The route schedules the first chunk at the FROZEN instant, so the
    // resume shift lands it exactly on resumedAt instead of delaying it by
    // the paused interval after resume (correction 3).
    const event = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, division.id, 1, 3, new Date(frozenAt)));
    expect(event.dueAt!.getTime()).toBe(frozenAt);
    // Exactly one chunk-1 event exists -- a second paused joiner landing in
    // the same backfilling division re-schedules it as a no-op.
    const again = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, division.id, 1, 3, new Date(Date.now())));
    expect(again.id).toBe(event.id);
    expect(again.dueAt!.getTime()).toBe(frozenAt);
    expect(
      await prisma.scheduledEvent.count({ where: { idempotencyKey: `DIVISION_HISTORY_SIMULATE:${division.id}:1` } }),
    ).toBe(1);
  });

  it("places two consecutive paused joiners into the SAME backfilling division", async () => {
    const frozenAt = Date.now() - 60_000;
    const { saveId, seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loadedA = await loadGlobalWorldMutable(prisma);
    if (!loadedA) throw new Error("world did not load");
    const joinerA = createHumanClub(loadedA.world, { userId: TEST_USER_IDS[8], clubName: "First Paused FC", country: "BRA" });
    const resultA = placeNewClub(loadedA.world, joinerA.id, frozenAt, seasonId, NEXT_SEASON);
    if (resultA.kind !== "active") throw new Error("expected active placement");
    const divisionA = loadedA.world.competitions.find((c) => c.id === resultA.divisionId)!;
    expect(divisionA.status).toBe("SIMULATING_HISTORY");
    await persistWorld(prisma, loadedA.save.id, loadedA.save.id, loadedA.world, loadedA.save.revision);

    // Second joiner arrives while still paused, before any chunk drained --
    // the exact window the running-world test above refuses. While frozen,
    // completedRounds cannot advance, so the SIMULATING_HISTORY skip is
    // bypassed and the joiner lands in the SAME division.
    const loadedB = await loadGlobalWorldMutable(prisma);
    if (!loadedB) throw new Error("world did not load");
    const joinerB = createHumanClub(loadedB.world, { userId: TEST_USER_IDS[9], clubName: "Second Paused FC", country: "BRA" });
    const resultB = placeNewClub(loadedB.world, joinerB.id, frozenAt, seasonId, NEXT_SEASON);
    if (resultB.kind !== "active") throw new Error("expected active placement");
    expect(resultB.divisionId).toBe(resultA.divisionId);
    expect(loadedB.world.competitions.filter((c) => c.kind === "division" && tierOf(c) === 2).length).toBe(1);
    const divisionAfter = loadedB.world.competitions.find((c) => c.id === resultA.divisionId)!;
    expect(divisionAfter.status).toBe("SIMULATING_HISTORY");
    expect(Object.keys(divisionAfter.standings)).toContain(String(joinerA.id));
    expect(Object.keys(divisionAfter.standings)).toContain(String(joinerB.id));
    // No second chunk chain: joiner B re-scheduling chunk 1 for the shared
    // division returns the existing row.
    const event = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, resultA.divisionId, 1, 3, new Date(frozenAt)));
    const again = await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, resultA.divisionId, 1, 3, new Date(frozenAt)));
    expect(again.id).toBe(event.id);
  });

  it("grows a full paused pyramid by exactly one new division or group", async () => {
    const frozenAt = Date.now() - 60_000;
    const { seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    // 8 joiners fill tier-2 group 0 (created by the first of them)...
    let lastDivisionId: number | null = null;
    for (const userId of TEST_USER_IDS.slice(8, 16)) {
      const club = createHumanClub(loaded.world, { userId, clubName: `Paused ${userId}`, country: "BRA" });
      const result = placeNewClub(loaded.world, club.id, frozenAt, seasonId, NEXT_SEASON);
      if (result.kind !== "active") throw new Error("expected active placement");
      lastDivisionId = result.divisionId;
    }
    expect(loaded.world.competitions.filter((c) => c.kind === "division" && tierOf(c) === 2).length).toBe(1);
    expect(Object.keys(loaded.world.competitions.find((c) => c.id === lastDivisionId)!.standings).length).toBe(8);
    // ...so the ninth creates exactly ONE new group at the same tier (still
    // under MAX_DIVISIONS_PER_TIER(2) = 2), never a new tier or a second
    // division, and it stays SIMULATING_HISTORY.
    const lastClub = createHumanClub(loaded.world, { userId: TEST_USER_IDS[16], clubName: "Full Pyramid FC", country: "BRA" });
    const result = placeNewClub(loaded.world, lastClub.id, frozenAt, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");
    const tier2Divisions = loaded.world.competitions.filter((c) => c.kind === "division" && tierOf(c) === 2);
    expect(tier2Divisions.length).toBe(2);
    const newGroup = tier2Divisions.find((c) => c.id === result.divisionId)!;
    expect(newGroup.groupIndex).toBe(1);
    expect(newGroup.status).toBe("SIMULATING_HISTORY");
    expect(loaded.world.competitions.some((c) => c.kind === "division" && tierOf(c) === 3)).toBe(false);
    expect(lowestActiveTier(loaded.world, seasonId)).toBe(2);
  });

  it("re-enters a paused dormant club into the bottom tier's backfilling division", async () => {
    const frozenAt = Date.now() - 60_000;
    const { seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[8], clubName: "Anchor Joiner FC", country: "BRA" });
    const joinResult = placeNewClub(loaded.world, joiner.id, frozenAt, seasonId, NEXT_SEASON);
    if (joinResult.kind !== "active") throw new Error("expected active placement");

    const dormant = createHumanClub(loaded.world, { userId: TEST_USER_IDS[9], clubName: "Dormant Return FC", country: "BRA" });
    dormant.competitionState = "DORMANT";
    const result = returnDormantClub(loaded.world, dormant.id, frozenAt, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");
    // The return re-enters the SAME bottom-tier division a paused joiner just
    // created (the relaxed skip applies to returns too) and its activity
    // anchor is stamped at the frozen instant, not real now.
    expect(result.divisionId).toBe(joinResult.divisionId);
    expect(dormant.competitionState).toBe("ACTIVE");
    expect(dormant.lastMeaningfulActivityAt).toBe(frozenAt);
    const division = loaded.world.competitions.find((c) => c.id === result.divisionId)!;
    expect(Object.keys(division.standings)).toContain(String(dormant.id));
  });

  it("never replaces a filler whose live match is frozen mid-play while paused", async () => {
    const frozenAt = Date.now() - 60_000;
    const { seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    // Pre-create the division placeNewClub would create so its fillers exist
    // before the join and one pair can be frozen inside a live match.
    const ref = { year: loaded.world.mp.seasonYear, month: loaded.world.mp.seasonMonth };
    const division = createDivision(loaded.world, { tier: lowestActiveTier(loaded.world, seasonId) + 1, groupIndex: 0, seasonId, ref });
    ensureDivisionFull(loaded.world, division);
    const fixtures = generateDivisionFixtures(loaded.world, division, ref);
    loaded.world.fixtures.push(...fixtures);
    division.status = "SIMULATING_HISTORY";
    const [home, away] = Object.keys(division.standings)
      .map(Number)
      .map((id) => loaded.world.clubs.find((c) => c.id === id)!);
    loaded.world.liveMatches.push(
      createLiveMatchState(loaded.world.rng, home, away, loaded.world.players, {
        matchId: loaded.world.nextId++,
        fixtureId: fixtures[0].id,
        competitionId: division.id,
      }),
    );
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    const reloaded = await loadGlobalWorldMutable(prisma);
    if (!reloaded) throw new Error("world did not load");
    const joiner = createHumanClub(reloaded.world, { userId: TEST_USER_IDS[8], clubName: "Live Guard FC", country: "BRA" });
    const result = placeNewClub(reloaded.world, joiner.id, frozenAt, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");
    // A pause freezes in-flight matches for the whole freeze, so the paused
    // joiner is likely to meet one -- the existing live-match guard in
    // highestRankedReplaceableAI stays load-bearing and must protect both
    // sides of the frozen clash.
    expect(result.divisionId).toBe(division.id);
    expect(result.replacedClubId).not.toBe(home.id);
    expect(result.replacedClubId).not.toBe(away.id);
    // Assert against the division placeNewClub actually mutated (the reloaded
    // world), never the pre-persist object above -- that one is untouched by
    // the placement and would make these checks vacuous.
    const placedDivision = reloaded.world.competitions.find((c) => c.id === division.id)!;
    expect(Object.keys(placedDivision.standings)).toContain(String(home.id));
    expect(Object.keys(placedDivision.standings)).toContain(String(away.id));
    expect(Object.keys(placedDivision.standings)).toContain(String(joiner.id));
    expect(Object.keys(placedDivision.standings)).not.toContain(String(result.replacedClubId));
    // The frozen clash's clubs survive: retireFillerClub destroys whoever was
    // replaced, so a guard failure would delete one of these outright.
    expect(reloaded.world.clubs.find((c) => c.id === home.id)).toBeDefined();
    expect(reloaded.world.clubs.find((c) => c.id === away.id)).toBeDefined();
  });

  it("shifts a paused joiner's kickoffs and pending chunk to the resumed instant, then backfills after resume", async () => {
    const frozenAt = Date.now() - 60_000;
    const { saveId, seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joinerA = createHumanClub(loaded.world, { userId: TEST_USER_IDS[8], clubName: "Resume A FC", country: "BRA" });
    const resultA = placeNewClub(loaded.world, joinerA.id, frozenAt, seasonId, NEXT_SEASON);
    const joinerB = createHumanClub(loaded.world, { userId: TEST_USER_IDS[9], clubName: "Resume B FC", country: "BRA" });
    const resultB = placeNewClub(loaded.world, joinerB.id, frozenAt, seasonId, NEXT_SEASON);
    if (resultA.kind !== "active" || resultB.kind !== "active") throw new Error("expected active placement");
    expect(resultB.divisionId).toBe(resultA.divisionId);
    const divisionId = resultA.divisionId;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
    await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, divisionId, 1, 3, new Date(frozenAt)));

    const before = await loadGlobalWorld(prisma);
    if (!before) throw new Error("world did not load");
    const kickoffsBefore = new Map(
      before.world.fixtures.filter((f) => f.competitionId === divisionId && !f.played).map((f) => [f.id, f.kickoffAt]),
    );
    expect(kickoffsBefore.size).toBeGreaterThan(0);

    // Real resume through the service: shifts DB fixture rows AND pending
    // REAL_TIME events in one transaction.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resumed = await resumeSeason(prisma, { adminUserId: TEST_USER_IDS[0], reason: "paused backfill resume test" });
    expect(resumed.shiftMs).toBeGreaterThanOrEqual(30);

    const after = await loadGlobalWorld(prisma);
    if (!after) throw new Error("world did not load");
    expect(after.world.mp.pausedAt ?? null).toBeNull();
    for (const f of after.world.fixtures) {
      if (f.competitionId !== divisionId || f.played) continue;
      // Unplayed kickoffs move forward by exactly the frozen interval.
      expect(f.kickoffAt).toBe(kickoffsBefore.get(f.id)! + resumed.shiftMs);
    }
    // The chunk was anchored at the frozen instant, so the shift lands it
    // exactly on resumedAt (correction 3) -- it fires on the first tick.
    const chunkEvent = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: `DIVISION_HISTORY_SIMULATE:${divisionId}:1` } });
    expect(chunkEvent.dueAt!.getTime()).toBe(frozenAt + resumed.shiftMs);
    expect(chunkEvent.dueAt!.getTime()).toBe(resumed.resumedAt);

    // Drain the chunk chain the way the worker would, one tick at a time.
    let guard = 0;
    while ((await executeDueEvents(prisma, saveId, new Date(Date.now() + 5_000))) > 0 && guard++ < 20) {
      // keep draining
    }
    const final = await loadGlobalWorld(prisma);
    if (!final) throw new Error("world did not load");
    const finalDivision = final.world.competitions.find((c) => c.id === divisionId)!;
    expect(finalDivision.status).toBe("ACTIVE");
    expect(final.world.matches.filter((m) => m.competitionId === divisionId).length).toBeGreaterThan(0);
    for (const row of Object.values(finalDivision.standings)) {
      expect(row.played).toBe(3);
    }
    expect(Object.keys(finalDivision.standings)).toContain(String(joinerA.id));
    expect(Object.keys(finalDivision.standings)).toContain(String(joinerB.id));
  });

  it("anchors a paused joiner's activity to the frozen instant, and resume shifts it to the resumed instant", async () => {
    const frozenAt = Date.now() - 60_000;
    const { seasonId } = await pausedMidSeasonWorld(frozenAt);

    const loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("world did not load");
    const joiner = createHumanClub(loaded.world, { userId: TEST_USER_IDS[8], clubName: "Anchor FC", country: "BRA" });
    const result = placeNewClub(loaded.world, joiner.id, frozenAt, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");
    // The route threads its frozen `now` into recordActivity.
    recordActivity(loaded.world, TEST_USER_IDS[8], joiner.id, "join", undefined, frozenAt);
    expect(loaded.world.clubs.find((c) => c.id === joiner.id)!.lastMeaningfulActivityAt).toBe(frozenAt);
    await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

    const resumed = await resumeSeason(prisma, { adminUserId: TEST_USER_IDS[0], reason: "activity anchor test" });
    // resumeSeason's transaction is the ONLY place the shifted inactivity
    // anchors reach the database (it invalidates the world cache, so the next
    // load reads these rows back). A reload must therefore already show the
    // shift -- without it the club's abandonment countdown would keep running
    // through the freeze.
    const reloaded = await loadGlobalWorld(prisma);
    if (!reloaded) throw new Error("world did not load");
    const anchor = reloaded.world.clubs.find((c) => c.id === joiner.id)!.lastMeaningfulActivityAt;
    expect(anchor).toBe(frozenAt + resumed.shiftMs);
    expect(anchor).toBe(resumed.resumedAt);
  });

  it("recovers a join whose persist hit revision contention without duplicating allocations or queue rows", async () => {
    const { saveId, world } = await freshWorld();
    const seasonId = world.mp.seasonId;
    fillDivisionOneWithHumans(world);
    // Completed rounds matter only to place the joiner past the new-division
    // threshold; 2 rounds is enough for the brand-new-division branch.
    simulateThroughRound(world, 2, Date.now());
    world.mp.manualRound = null;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    // First attempt: build the club and place it against the then-current
    // world, exactly as POST /mp/join does on its first pass.
    const first = await loadGlobalWorldMutable(prisma);
    if (!first) throw new Error("world did not load");
    const now = Date.now();
    const joiner = createHumanClub(first.world, { userId: TEST_USER_IDS[8], clubName: "Retry FC", country: "BRA" });
    const result = placeNewClub(first.world, joiner.id, now, seasonId, NEXT_SEASON);
    if (result.kind !== "active") throw new Error("expected active placement");

    // A concurrent writer commits before this attempt: the persist below now
    // targets a stale revision, exactly the contention the route's retry is
    // built for. The discarded attempt must leave no residue.
    const concurrent = await loadGlobalWorldMutable(prisma);
    if (!concurrent) throw new Error("world did not load");
    concurrent.world.mp.completedRounds = 4;
    await persistWorld(prisma, concurrent.save.id, concurrent.save.id, concurrent.world, concurrent.save.revision);
    await expect(persistWorld(prisma, saveId, saveId, first.world, first.save.revision)).rejects.toBeInstanceOf(StaleWorldError);

    // Retry: restart from a fresh load and re-run the whole flow (correction
    // 5 -- a club rebuilt against the stale world would carry a stale
    // world.nextId and RNG position).
    const retry = await loadGlobalWorldMutable(prisma);
    if (!retry) throw new Error("world did not load");
    const retryJoiner = createHumanClub(retry.world, { userId: TEST_USER_IDS[8], clubName: "Retry FC", country: "BRA" });
    const retryResult = placeNewClub(retry.world, retryJoiner.id, now, seasonId, NEXT_SEASON);
    if (retryResult.kind !== "active") throw new Error("expected active placement");
    await issueAllocation(prisma, retry.world, retryJoiner.id, seasonId, retryResult.tier, {
      type: "ACTIVE_PRORATED",
      remainingRounds: Math.max(0, gameConfig.roundsPerSeason - retry.world.mp.completedRounds),
    });
    recordActivity(retry.world, TEST_USER_IDS[8], retryJoiner.id, "join", undefined, now);
    syncMemberships(retry.world, seasonId);
    syncClubSeasons(retry.world, seasonId);
    await persistWorld(prisma, retry.save.id, retry.save.id, retry.world, retry.save.revision);

    const after = await loadGlobalWorld(prisma);
    if (!after) throw new Error("world did not load");
    const club = after.world.clubs.find((c) => c.ownerUserId === TEST_USER_IDS[8]);
    expect(club).toBeDefined();
    expect(after.world.clubs.filter((c) => c.ownerUserId === TEST_USER_IDS[8]).length).toBe(1);
    // Exactly one allocation for the club's active placement and no queue row:
    // the discarded attempt persisted nothing and issueAllocation is idempotent.
    expect(after.world.seasonAllocations.filter((a) => a.clubId === club!.id)).toHaveLength(1);
    expect(after.world.mpQueue.filter((q) => q.clubId === club!.id)).toHaveLength(0);
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
