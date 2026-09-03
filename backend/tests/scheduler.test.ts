import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { gameConfig, MP_CONFIG, scaleReferenceSeasonFlow } from "../src/config";
import { ensureGlobalSave, loadGlobalWorld, persistWorld } from "../src/services/saveService";
import { ensureCurrentSeason } from "../src/services/mpService";
import {
  executeScheduledEvent,
  executeDueEvents,
  materializeSeasonEvents,
  rolloverEventKey,
  scheduleEvent,
  ScheduledEventType,
} from "../src/services/scheduler";
import { advanceGameDay } from "../src/services/gameClockService";
import { ROLLOVER_WORKFLOW_STEPS } from "../src/services/seasonRolloverService";
import { calendarValues } from "../src/services/seasonCalendar";
import { DAY_MS, boundariesElapsed, dayBoundaryAtOrBefore } from "../src/services/dayBoundary";
import { CLUBS_PER_DIVISION, enterLaunchHold, placeNewClub, shouldReleaseLaunchHold } from "../src/game/multiplayer";
import { createHumanClub } from "../src/game/worldgen";
import { applyLaunchHoldResume, applyResumeShift, syncLaunchHoldResumeRows } from "../src/services/seasonPause";

const prisma = new PrismaClient();

async function freshWorld() {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  await ensureCurrentSeason(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

describe("durable scheduler", () => {
  beforeEach(async () => {
    await prisma.scheduledEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates one row for concurrent idempotent scheduling", async () => {
    const { saveId } = await freshWorld();
    const input = {
      saveId,
      type: ScheduledEventType.BEGIN_GAME_DAY,
      timeBasis: "GAME_DAY" as const,
      dueAbsoluteGameDay: 0,
      idempotencyKey: "BEGIN_GAME_DAY:test:0",
    };

    const events = await Promise.all(Array.from({ length: 5 }, () => scheduleEvent(prisma, input)));
    expect(new Set(events.map((event) => event.id)).size).toBe(1);
    expect(await prisma.scheduledEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
  });

  it("materializes a season repeatedly without duplicating events", async () => {
    const { saveId, world } = await freshWorld();
    await materializeSeasonEvents(prisma, saveId, world);
    const firstCount = await prisma.scheduledEvent.count({ where: { saveId } });
    await materializeSeasonEvents(prisma, saveId, world);
    const secondCount = await prisma.scheduledEvent.count({ where: { saveId } });
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBe(firstCount);
  });

  it("uses the monotonic world day rather than the host month", async () => {
    const { saveId, world } = await freshWorld();
    world.mp.seasonYear = 2099;
    world.mp.seasonMonth = 2;
    world.mp.startAbsoluteGameDay = 400;
    world.mp.absoluteGameDay = 400;
    await materializeSeasonEvents(prisma, saveId, world);

    const first = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: `BEGIN_GAME_DAY:${world.mp.seasonId}:400` } });
    expect(first.dueAbsoluteGameDay).toBe(400);
    const rollover = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("SEASON_ROLLOVER", world.mp.seasonId) } });
    expect(rollover.dueAbsoluteGameDay).toBe(400 + gameConfig.seasonDays - 1);
  });

  it("places inter-season workflow events at the configured boundary", async () => {
    const { saveId, world } = await freshWorld();
    await materializeSeasonEvents(prisma, saveId, world);
    const calendar = calendarValues();
    const start = world.mp.startAbsoluteGameDay ?? 0;
    const transition = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("INTERSEASON_START", world.mp.seasonId) } });
    const fixtures = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("NEXT_SEASON_FIXTURE_GENERATION", world.mp.seasonId) } });
    const validation = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("NEXT_SEASON_STRUCTURE_VALIDATE", world.mp.seasonId) } });
    expect(transition.dueAbsoluteGameDay).toBe(start + calendar.interseasonStartIndex);
    expect(fixtures.dueAbsoluteGameDay).toBe(transition.dueAbsoluteGameDay);
    expect(validation.dueAbsoluteGameDay).toBe(start + calendar.seasonDays - 1);
  });

  it("converts legacy season flows exactly once at the save boundary", async () => {
    const { saveId } = await freshWorld();
    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("world did not load");
    const player = loaded.world.players[0];
    if (!player) throw new Error("generated world has no player");
    player.salary = 100;
    loaded.world.mp.calendarMigrationVersion = 0;
    await persistWorld(prisma, saveId, saveId, loaded.world, loaded.save.revision);

    await ensureCurrentSeason(prisma);
    const migrated = await loadGlobalWorld(prisma);
    if (!migrated) throw new Error("migrated world did not load");
    const converted = migrated.world.players.find((candidate) => candidate.id === player.id)?.salary;
    expect(converted).toBe(scaleReferenceSeasonFlow(100));
    expect(migrated.world.mp.calendarMigrationVersion).toBe(1);

    await ensureCurrentSeason(prisma);
    const replayed = await loadGlobalWorld(prisma);
    expect(replayed?.world.players.find((candidate) => candidate.id === player.id)?.salary).toBe(converted);
  });

  it("materializes executable rollover steps with prerequisite enforcement", async () => {
    const { saveId, world } = await freshWorld();
    await materializeSeasonEvents(prisma, saveId, world);

    for (const step of ROLLOVER_WORKFLOW_STEPS) {
      const event = await prisma.scheduledEvent.findUnique({ where: { idempotencyKey: rolloverEventKey(step, world.mp.seasonId) } });
      expect(event?.type).toBe(step);
      expect(event?.entityType).toBe("SEASON");
      expect(event?.entityId).toBe(String(world.mp.seasonId));
    }

    const promotion = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("PROMOTION_RELEGATION", world.mp.seasonId) } });
    await expect(executeScheduledEvent(prisma, promotion.id, { ignoreDueTime: true, now: new Date() })).rejects.toThrow("INTERSEASON_START");
    const failed = await prisma.scheduledEvent.findUniqueOrThrow({ where: { id: promotion.id } });
    expect(failed.status).toBe("FAILED");
  });

  it("runs the full rollover coordinator in order and resumes idempotently", async () => {
    const { saveId, world } = await freshWorld();
    await materializeSeasonEvents(prisma, saveId, world);
    const sourceSeasonId = world.mp.seasonId;
    const coordinator = await prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: rolloverEventKey("SEASON_ROLLOVER", sourceSeasonId) } });

    const completed = await executeScheduledEvent(prisma, coordinator.id, { ignoreDueTime: true, now: new Date() });
    expect(completed.status).toBe("COMPLETED");
    const workflow = await prisma.scheduledEvent.findMany({ where: { saveId, idempotencyKey: { in: ROLLOVER_WORKFLOW_STEPS.map((step) => rolloverEventKey(step, sourceSeasonId)) } } });
    expect(workflow).toHaveLength(ROLLOVER_WORKFLOW_STEPS.length);
    expect(workflow.every((event) => event.status === "COMPLETED")).toBe(true);

    const after = await loadGlobalWorld(prisma);
    expect(after?.world.mp.seasonId).not.toBe(sourceSeasonId);
    const allocations = after?.world.seasonAllocations.length ?? 0;
    const replay = await executeScheduledEvent(prisma, coordinator.id, { ignoreDueTime: true, now: new Date() });
    expect(replay.status).toBe("COMPLETED");
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.seasonAllocations.length).toBe(allocations);
  });

  it("executes a game-day advance through the locked durable path once", async () => {
    const { saveId } = await freshWorld();
    const event = await scheduleEvent(prisma, {
      saveId,
      type: ScheduledEventType.GAME_DAY_ADVANCE,
      timeBasis: "REAL_TIME",
      dueAt: new Date(Date.now() - 1),
      idempotencyKey: "GAME_DAY_ADVANCE:test:1",
    });

    const completed = await executeScheduledEvent(prisma, event.id, { now: new Date() });
    expect(completed.status).toBe("COMPLETED");
    const replay = await executeScheduledEvent(prisma, event.id, { now: new Date() });
    expect(replay.status).toBe("COMPLETED");
    expect(await prisma.scheduledEvent.count({ where: { saveId, status: "COMPLETED", type: ScheduledEventType.GAME_DAY_ADVANCE } })).toBe(1);
  });

  it("writes the pending day-advance row exactly one boundary after lastBoundaryAt with zero seconds", async () => {
    const { saveId } = await freshWorld();
    const event = await scheduleEvent(prisma, {
      saveId,
      type: ScheduledEventType.GAME_DAY_ADVANCE,
      timeBasis: "REAL_TIME",
      dueAt: new Date(Date.now() - 1),
      idempotencyKey: "GAME_DAY_ADVANCE:test:boundary",
    });

    const completed = await executeScheduledEvent(prisma, event.id, { now: new Date() });
    expect(completed.status).toBe("COMPLETED");

    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("world did not reload");
    const boundary = loaded.world.mp.lastBoundaryAt;
    expect(boundary).toBeDefined();
    const boundaryDate = new Date(boundary!);
    // The grid reference is always a zero-second boundary (the 6:13:52
    // symptom: the pending row must never carry raw milliseconds again).
    expect(boundaryDate.getUTCSeconds()).toBe(0);
    expect(boundaryDate.getUTCMilliseconds()).toBe(0);
    const pending = await prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
    expect(pending).not.toBeNull();
    expect(pending!.dueAt!.getTime()).toBe(boundary! + DAY_MS);
    expect(pending!.dueAt!.getUTCSeconds()).toBe(0);
    expect(pending!.dueAt!.getUTCMilliseconds()).toBe(0);
  });

  it("a deferred advance (blocked then resolved) does not move the boundary grid", async () => {
    const { saveId } = await freshWorld();
    // Block the rollover with a current-day fixture that has not started.
    const seeded = await loadGlobalWorld(prisma);
    if (!seeded) throw new Error("world did not load");
    const dayIndex = seeded.world.mp.seasonDayIndex ?? seeded.world.dayIndex;
    const blocker = seeded.world.fixtures.find((fixture) => !fixture.played)!;
    blocker.scheduledSeasonDayIndex = dayIndex;
    blocker.dayIndex = dayIndex;
    blocker.kickoffAt = Date.now() + 60 * 60 * 1000;
    await persistWorld(prisma, saveId, saveId, seeded.world, seeded.save.revision);

    await expect(advanceGameDay(prisma, { now: new Date(Date.now() + 60_000) })).rejects.toThrow("Cannot advance while a scheduled match is unresolved");

    // Resolve the blocker: the deferred advance finally runs at an
    // off-boundary instant and must still record the boundary grid, not the
    // wall-clock instant it physically ran at.
    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("world did not reload");
    loaded.world.fixtures.find((fixture) => fixture.id === blocker.id)!.played = true;
    await persistWorld(prisma, saveId, saveId, loaded.world, loaded.save.revision);
    const advancedAt = new Date();
    await advanceGameDay(prisma, { now: advancedAt });

    const after = await loadGlobalWorld(prisma);
    if (!after) throw new Error("world did not reload after advance");
    const boundary = after.world.mp.lastBoundaryAt!;
    expect(new Date(boundary).getUTCSeconds()).toBe(0);
    // The blocked advance finally landed at an off-boundary instant; the grid
    // still records the boundary, so the next advance is tomorrow's boundary.
    expect(boundary).toBe(dayBoundaryAtOrBefore(advancedAt.getTime()) + DAY_MS);
    const pending = await prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
    expect(pending!.dueAt!.getTime()).toBe(boundary + DAY_MS);
  });

  it("anchors an administrator-started match at execution time", async () => {
    const { saveId, world } = await freshWorld();
    const now = new Date(Date.now() + 60_000);
    const fixture = world.fixtures.find((candidate) => !candidate.played);
    if (!fixture) throw new Error("world did not generate an upcoming fixture");
    fixture.kickoffAt = now.getTime() + 60 * 60 * 1000;
    await persistWorld(prisma, saveId, saveId, world, (await prisma.save.findUniqueOrThrow({ where: { id: saveId }, select: { revision: true } })).revision);

    const event = await scheduleEvent(prisma, {
      saveId,
      type: ScheduledEventType.MATCH_START,
      timeBasis: "REAL_TIME",
      dueAt: new Date(fixture.kickoffAt),
      entityType: "MATCH",
      entityId: String(fixture.id),
      payload: { fixtureId: fixture.id },
      idempotencyKey: `MATCH_START:early:${fixture.id}`,
    });

    await executeScheduledEvent(prisma, event.id, { source: "ADMIN", ignoreDueTime: true, now });

    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("world did not reload");
    const live = loaded.world.liveMatches.find((candidate) => candidate.fixtureId === fixture.id);
    expect(live?.lastAdvancedAt).toBe(now.getTime());

    const completion = await prisma.scheduledEvent.findFirstOrThrow({
      where: { saveId, type: ScheduledEventType.MATCH_COMPLETE, entityType: "MATCH", entityId: String(fixture.id) },
    });
    expect(completion.dueAt?.getTime()).toBe(now.getTime() + MP_CONFIG.matchDurationMinutes * 60 * 1000);
  });

  it("recovers a stale running claim after a worker crash", async () => {
    const { saveId } = await freshWorld();
    const event = await scheduleEvent(prisma, {
      saveId,
      type: ScheduledEventType.BEGIN_GAME_DAY,
      timeBasis: "REAL_TIME",
      dueAt: new Date(Date.now() - 120_000),
      idempotencyKey: "BEGIN_GAME_DAY:stale-claim",
    });
    await prisma.scheduledEvent.update({ where: { id: event.id }, data: { status: "RUNNING", attempts: 1, startedAt: new Date(Date.now() - 120_000) } });

    expect(await executeDueEvents(prisma, saveId, new Date())).toBe(1);
    expect((await prisma.scheduledEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("COMPLETED");
  });

  it("launch-hold lift: re-times fixtures, syncs MATCH_START rows, and the first advance fires at seasonBoundary + 24h", async () => {
    const { saveId } = await freshWorld();
    // The join route's placement writes ownerUserId with an FK to User: the
    // roster needs real rows.
    const userIds = Array.from({ length: CLUBS_PER_DIVISION }, (_, i) => 950200 + i);
    await prisma.user.createMany({
      data: userIds.map((id) => ({ id, name: `Hold User ${id}`, email: `hold-scheduler-${id}@test.dev`, emailVerified: true })),
    });

    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("world did not load");
    enterLaunchHold(loaded.world, Date.now());
    await persistWorld(prisma, saveId, saveId, loaded.world, loaded.save.revision);
    loaded.save.revision += 1;

    // The N joins, placed at the frozen instant exactly like the route does
    // while the world is held (joins 1..N−1 never release it).
    const seasonId = loaded.world.mp.seasonId;
    const nextSeasonRef = { year: 2026, month: 2 };
    for (let i = 0; i < CLUBS_PER_DIVISION - 1; i++) {
      const club = createHumanClub(loaded.world, { userId: userIds[i], clubName: `Hold Club ${i}`, country: "BRA", preferredHours: Array.from({ length: 16 }, (_, s) => (s + i * 4) % 48) });
      const result = placeNewClub(loaded.world, club.id, loaded.world.mp.pausedAt!, seasonId, nextSeasonRef);
      expect(result.kind).toBe("active");
    }
    expect(shouldReleaseLaunchHold(loaded.world)).toBe(false);

    // The N-th join completes the roster: the route's lift decision fires and
    // the launch composition runs (raw shift, absolute boundary anchor,
    // flags cleared).
    const finalClub = createHumanClub(loaded.world, { userId: userIds[CLUBS_PER_DIVISION - 1], clubName: "Hold Final", country: "BRA", preferredHours: Array.from({ length: 16 }, (_, s) => (s + 12) % 48) });
    const finalResult = placeNewClub(loaded.world, finalClub.id, loaded.world.mp.pausedAt!, seasonId, nextSeasonRef);
    expect(finalResult.kind).toBe("active");
    expect(shouldReleaseLaunchHold(loaded.world)).toBe(true);
    const realNow = Date.now();
    applyResumeShift(loaded.world, Math.max(0, realNow - loaded.world.mp.pausedAt!), 0);
    applyLaunchHoldResume(loaded.world, realNow);
    loaded.world.mp.pausedAt = null;
    loaded.world.mp.awaitingLaunchRoster = false;
    loaded.world.mp.awaitingFirstHuman = false;

    await persistWorld(prisma, saveId, saveId, loaded.world, loaded.save.revision);
    // The route's row sync: fixtures + MATCH_START + advance row + clock row.
    await syncLaunchHoldResumeRows(prisma, saveId, loaded.world);
    await materializeSeasonEvents(prisma, saveId, loaded.world);

    const seasonBoundary = loaded.world.mp.seasonStartAt!;
    expect(seasonBoundary).toBeGreaterThan(Date.now());
    expect(new Date(seasonBoundary).getUTCSeconds()).toBe(0);
    expect(loaded.world.fixtures.length).toBeGreaterThan(0);
    for (const fixture of loaded.world.fixtures) {
      const dayStart = seasonBoundary + fixture.scheduledSeasonDayIndex! * DAY_MS;
      expect(fixture.kickoffAt!).toBeGreaterThanOrEqual(dayStart);
      expect(fixture.kickoffAt!).toBeLessThan(dayStart + DAY_MS);
      // Every pending MATCH_START row equals its fixture's re-timed kickoff.
      const row = await prisma.scheduledEvent.findFirst({
        where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(fixture.id), status: "PENDING" },
      });
      expect(row?.dueAt!.getTime()).toBe(fixture.kickoffAt!);
    }

    // The first advance fires at seasonBoundary + 24h: the pending row says
    // so, and the boundary trigger agrees exactly.
    const pending = await prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
    expect(pending?.dueAt!.getTime()).toBe(seasonBoundary + DAY_MS);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS)).toBe(1);
  });
});
