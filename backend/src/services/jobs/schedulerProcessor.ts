import type { JobContext, JobResult } from "./runner";
import { withGlobalLease, withGlobalLock } from "../lock";
import { advanceGameDay, ensureGameClock, schedulerRolloverHourUtc } from "../gameClockService";
import { executeDueEvents, executeGameDayEventsInLock, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../scheduler";
import { loadGlobalWorld } from "../saveService";

/** Durable scheduler loop. It owns materialization and real-time event claims;
 * domain handlers remain in their respective game services. */
export async function schedulerProcessor(ctx: JobContext): Promise<JobResult> {
  const now = new Date(ctx.now ?? Date.now());
  const saveId = await withGlobalLock(() => withGlobalLease(ctx.prisma, async () => {
      const loaded = await loadGlobalWorld(ctx.prisma);
      if (!loaded) return null;
      const clock = await ensureGameClock(ctx.prisma, loaded.save.id, loaded.world);
      await materializeSeasonEvents(ctx.prisma, loaded.save.id, loaded.world);
      await executeGameDayEventsInLock(ctx.prisma, loaded.save.id, clock.absoluteGameDay, now, "BEGIN_OF_DAY", true);
      await executeGameDayEventsInLock(ctx.prisma, loaded.save.id, clock.absoluteGameDay, now, "INTRADAY", true);
      const existingAdvance = await ctx.prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
      if (!existingAdvance) {
        const dueAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (now.getUTCHours() >= schedulerRolloverHourUtc() ? 1 : 0), schedulerRolloverHourUtc()));
        await scheduleEvent(ctx.prisma, { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, timeBasis: "REAL_TIME", dueAt, priority: 10000, idempotencyKey: `GAME_DAY_ADVANCE:${clock.absoluteGameDay + 1}` });
      }
      return loaded.save.id;
    }));
  if (saveId === null) return { changed: false };
  const gameDayAdvanceOnly = new Set([ScheduledEventType.GAME_DAY_ADVANCE]);
  let executed = await executeDueEvents(ctx.prisma, saveId, now, { excludeTypes: gameDayAdvanceOnly });
  let loaded = await loadGlobalWorld(ctx.prisma);
  if (!loaded) return { changed: executed > 0, persisted: true };
  const clock = await ensureGameClock(ctx.prisma, loaded.save.id, loaded.world);
  const missingDays = missedRolloverBoundaries(clock.lastAdvancedAt, now, schedulerRolloverHourUtc());
  if (missingDays > 3) {
    await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
    return { changed: executed > 0, persisted: true };
  }
  await ctx.prisma.setting.deleteMany({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" } });
  try {
    for (let i = 0; i < missingDays; i++) {
      executed += await executeDueEvents(ctx.prisma, saveId, now, { excludeTypes: gameDayAdvanceOnly });
      await advanceGameDay(ctx.prisma, { source: "AUTOMATIC", now });
      loaded = await loadGlobalWorld(ctx.prisma);
      if (!loaded) break;
    }
  } catch (error) {
    await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
    throw error;
  }
  executed += await executeDueEvents(ctx.prisma, saveId, now);
  return { changed: executed > 0 || missingDays > 0, persisted: true };
}

function missedRolloverBoundaries(lastAdvancedAt: Date, now: Date, rolloverHourUtc: number): number {
  const last = lastAdvancedAt.getTime();
  const lastBoundary = Date.UTC(lastAdvancedAt.getUTCFullYear(), lastAdvancedAt.getUTCMonth(), lastAdvancedAt.getUTCDate(), rolloverHourUtc);
  const firstBoundary = lastBoundary <= last ? lastBoundary + 24 * 60 * 60 * 1000 : lastBoundary;
  if (firstBoundary > now.getTime()) return 0;
  return Math.floor((now.getTime() - firstBoundary) / (24 * 60 * 60 * 1000)) + 1;
}
