import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-scheduler.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { gameConfig, scaleReferenceSeasonFlow } from "../src/config";
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
import { ROLLOVER_WORKFLOW_STEPS } from "../src/services/seasonRolloverService";
import { calendarValues } from "../src/services/seasonCalendar";

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
});
