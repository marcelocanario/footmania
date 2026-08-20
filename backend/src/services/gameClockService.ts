import type { PrismaClient } from "@prisma/client";
import { gameConfig, configuredUtcHour } from "../config";
import { phaseForSeasonDayIndex } from "./seasonCalendar";
import { withGlobalLease, withGlobalLock } from "./lock";
import { loadGlobalWorld, persistWorld } from "./saveService";
import { executeGameDayEventsInLock, executeMandatoryEventsInLock, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "./scheduler";
import { rollover } from "./mpService";

export interface GameClockView {
  id: "WORLD";
  absoluteGameDay: number;
  seasonId: number;
  seasonNumber: number;
  seasonDayIndex: number;
  phase: "ACTIVE" | "INTERSEASON";
  lastAdvancedAt: Date;
  version: number;
}

export interface AdvanceGameDayOptions {
  source?: "AUTOMATIC" | "ADMIN";
  adminUserId?: number;
  force?: boolean;
  reason?: string;
  now?: Date;
  leaseHeld?: boolean;
}

function normalizeWorldClock(world: import("../game/types").World): void {
  const absoluteGameDay = world.mp.absoluteGameDay ?? Math.max(0, world.dayIndex);
  const seasonDayIndex = world.mp.seasonDayIndex ?? Math.max(0, Math.min(gameConfig.seasonDays - 1, world.dayIndex));
  world.mp.absoluteGameDay = absoluteGameDay;
  world.mp.seasonDayIndex = seasonDayIndex;
  world.mp.startAbsoluteGameDay ??= absoluteGameDay - seasonDayIndex;
  world.mp.seasonNumber ??= Math.max(1, world.year);
  world.mp.phase = phaseForSeasonDayIndex(seasonDayIndex, gameConfig);
  world.mp.clockVersion ??= 0;
  world.mp.seasonStartAt ??= world.mp.lastAdvancedAt ?? Date.now();
}

export async function ensureGameClock(prisma: PrismaClient, saveId: number, world?: import("../game/types").World): Promise<GameClockView> {
  const loaded = world ? { world } : await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("Global world unavailable");
  normalizeWorldClock(loaded.world);
  const now = loaded.world.mp.lastAdvancedAt ? new Date(loaded.world.mp.lastAdvancedAt) : new Date();
  const row = await prisma.gameClock.upsert({
    where: { saveId },
    update: {
      absoluteGameDay: loaded.world.mp.absoluteGameDay!,
      seasonId: loaded.world.mp.seasonId,
      seasonNumber: loaded.world.mp.seasonNumber!,
      seasonDayIndex: loaded.world.mp.seasonDayIndex!,
      phase: loaded.world.mp.phase!,
      lastAdvancedAt: now,
      version: loaded.world.mp.clockVersion ?? 0,
    },
    create: {
      id: "WORLD",
      saveId,
      absoluteGameDay: loaded.world.mp.absoluteGameDay!,
      seasonId: loaded.world.mp.seasonId,
      seasonNumber: loaded.world.mp.seasonNumber!,
      seasonDayIndex: loaded.world.mp.seasonDayIndex!,
      phase: loaded.world.mp.phase!,
      lastAdvancedAt: now,
      version: loaded.world.mp.clockVersion ?? 0,
    },
  });
  return toClockView(row);
}

function toClockView(row: { absoluteGameDay: number; seasonId: number; seasonNumber: number; seasonDayIndex: number; phase: string; lastAdvancedAt: Date; version: number }): GameClockView {
  return {
    id: "WORLD",
    absoluteGameDay: row.absoluteGameDay,
    seasonId: row.seasonId,
    seasonNumber: row.seasonNumber,
    seasonDayIndex: row.seasonDayIndex,
    phase: row.phase === "INTERSEASON" ? "INTERSEASON" : "ACTIVE",
    lastAdvancedAt: row.lastAdvancedAt,
    version: row.version,
  };
}

function nextMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The only service allowed to increment the multiplayer game clock. */
export async function advanceGameDay(prisma: PrismaClient, options: AdvanceGameDayOptions = {}): Promise<GameClockView> {
  return withGlobalLock(() => advanceGameDayInLock(prisma, options));
}

/**
 * Advance the clock when the caller already owns WORLD_CLOCK. This is used by
 * the durable scheduler event executor to avoid recursively waiting on the
 * same non-reentrant application lock.
 */
export async function advanceGameDayInLock(prisma: PrismaClient, options: AdvanceGameDayOptions = {}): Promise<GameClockView> {
  if (options.leaseHeld) return advanceGameDayUnlocked(prisma, options);
  return withGlobalLease(prisma, () => advanceGameDayUnlocked(prisma, { ...options, leaseHeld: true }), options.now ?? new Date());
}

async function advanceGameDayUnlocked(prisma: PrismaClient, options: AdvanceGameDayOptions = {}): Promise<GameClockView> {
    let loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("Global world unavailable");
    let world = loaded.world;
    normalizeWorldClock(world);
    const currentIndex = world.mp.seasonDayIndex!;
    const currentAbsolute = world.mp.absoluteGameDay!;
    const seasonBeforeMandatory = world.mp.seasonId;

    if (!options.force) {
      const unresolved = world.fixtures.filter((fixture) => fixture.scheduledSeasonDayIndex === currentIndex || (fixture.scheduledSeasonDayIndex === undefined && fixture.dayIndex === currentIndex)).some(
        (fixture) => !fixture.played && !world.liveMatches.some((match) => match.fixtureId === fixture.id && match.ended),
      );
      if (unresolved) throw new Error("Cannot advance while a scheduled match is unresolved");
    }

    await executeMandatoryEventsInLock(prisma, loaded.save.id, currentAbsolute, options.now ?? new Date());
    const afterMandatory = await loadGlobalWorld(prisma);
    if (!afterMandatory) throw new Error("World unavailable after mandatory scheduler events");
    loaded = afterMandatory;
    world = loaded.world;
    normalizeWorldClock(world);

    const now = options.now ?? new Date();
    const nextAbsolute = currentAbsolute + 1;
    if (currentIndex + 1 >= gameConfig.seasonDays) {
      // Mandatory scheduled events normally complete the rollover workflow
      // before this boundary. The fallback covers saves whose workflow events
      // have not been materialized yet without running a second rollover.
      if (world.mp.seasonId === seasonBeforeMandatory) {
       await rollover(prisma, { calendarBoundary: true, leaseHeld: true });
      }
      const fresh = await loadGlobalWorld(prisma);
      if (!fresh) throw new Error("World disappeared during season rollover");
      normalizeWorldClock(fresh.world);
      fresh.world.mp.absoluteGameDay = nextAbsolute;
       fresh.world.mp.seasonNumber = world.mp.seasonNumber ?? 1;
      fresh.world.mp.seasonDayIndex = 0;
       fresh.world.mp.startAbsoluteGameDay = nextAbsolute;
       fresh.world.mp.seasonStartAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      fresh.world.mp.phase = "ACTIVE";
      fresh.world.mp.lastAdvancedAt = now.getTime();
       fresh.world.mp.clockVersion = (world.mp.clockVersion ?? 0) + 1;
      await persistWorld(prisma, fresh.save.id, fresh.save.id, fresh.world, fresh.save.revision);
      await materializeSeasonEvents(prisma, fresh.save.id, fresh.world);
       await executeGameDayEventsInLock(prisma, fresh.save.id, nextAbsolute, now, "BEGIN_OF_DAY", true);
      const afterBegin = await loadGlobalWorld(prisma);
      if (!afterBegin) throw new Error("World unavailable after beginning the new season");
      await scheduleNextAutomaticAdvance(prisma, fresh.save.id, nextAbsolute, now);
      const row = await ensureGameClock(prisma, afterBegin.save.id, afterBegin.world);
      await writeAdminAudit(prisma, fresh.save.id, options, { absoluteGameDay: currentAbsolute, seasonDayIndex: currentIndex }, row);
      return row;
    }

    world.mp.absoluteGameDay = nextAbsolute;
    world.mp.seasonDayIndex = currentIndex + 1;
    world.mp.phase = phaseForSeasonDayIndex(world.mp.seasonDayIndex, gameConfig);
    world.mp.lastAdvancedAt = now.getTime();
    world.mp.clockVersion = (world.mp.clockVersion ?? 0) + 1;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    await materializeSeasonEvents(prisma, loaded.save.id, world);
    await executeGameDayEventsInLock(prisma, loaded.save.id, nextAbsolute, now, "BEGIN_OF_DAY", true);
    const afterBegin = await loadGlobalWorld(prisma);
    if (!afterBegin) throw new Error("World unavailable after beginning the new game day");
    await scheduleNextAutomaticAdvance(prisma, loaded.save.id, nextAbsolute, now);
    const row = await ensureGameClock(prisma, afterBegin.save.id, afterBegin.world);
    await writeAdminAudit(prisma, loaded.save.id, options, { absoluteGameDay: currentAbsolute, seasonDayIndex: currentIndex }, row);
    return row;
}

async function scheduleNextAutomaticAdvance(prisma: PrismaClient, saveId: number, nextAbsolute: number, now: Date): Promise<void> {
  await prisma.scheduledEvent.updateMany({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" }, data: { status: "CANCELLED", version: { increment: 1 } } });
  await scheduleEvent(prisma, {
    saveId,
    type: ScheduledEventType.GAME_DAY_ADVANCE,
    timeBasis: "REAL_TIME",
    dueAt: nextMidnight(now),
    priority: 10000,
    payload: { targetAbsoluteGameDay: nextAbsolute },
    idempotencyKey: `GAME_DAY_ADVANCE:${nextAbsolute + 1}`,
  });
}

async function writeAdminAudit(prisma: PrismaClient, saveId: number, options: AdvanceGameDayOptions, before: object, after: object): Promise<void> {
  if (options.source !== "ADMIN" || options.adminUserId === undefined) return;
  await prisma.adminSchedulerAudit.create({
    data: {
      saveId,
      adminUserId: options.adminUserId,
      action: options.force ? "FORCE_ADVANCE" : "ADVANCE_GAME_DAY",
      targetType: "WORLD_CLOCK",
      targetId: "WORLD",
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      reason: options.reason ?? null,
    },
  });
}

export function schedulerRolloverHourUtc(): number {
  return configuredUtcHour(gameConfig.scheduler.gameDayRolloverUtc);
}
