import type { JobContext, JobResult } from "./runner";
import { withGlobalLease, withGlobalLock } from "../lock";
import { advanceGameDayInLock, ensureGameClock, schedulerRolloverHourUtc } from "../gameClockService";
import { executeDueEventsInLock, executeGameDayEventsInLock, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../scheduler";
import { loadGlobalWorldMutable } from "../saveService";
import { isWorldPausedGlobally } from "../seasonPause";

/** Durable scheduler loop. It owns materialization and real-time event claims;
 * domain handlers remain in their respective game services. */
export async function schedulerProcessor(ctx: Pick<JobContext, "prisma"> & Partial<Pick<JobContext, "now">>): Promise<JobResult> {
  const now = new Date(ctx.now ?? Date.now());
  // Season pause: the world clock is frozen — no events, no day advancement.
  if (await isWorldPausedGlobally(ctx.prisma)) return { changed: false };
  const save = await ctx.prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
  if (!save) return { changed: false };
  const clockSnapshot = await ctx.prisma.gameClock.findUnique({ where: { saveId: save.id } });
  const due = await ctx.prisma.scheduledEvent.findFirst({
    where: {
      saveId: save.id,
      status: { in: ["PENDING", "FAILED"] },
      OR: [
        { timeBasis: "REAL_TIME", dueAt: { lte: now } },
        ...(clockSnapshot ? [{ timeBasis: "GAME_DAY", dueAbsoluteGameDay: { lte: clockSnapshot.absoluteGameDay } }] : []),
      ],
    },
    select: { id: true, timeBasis: true },
  });
  const boundaryDue = clockSnapshot ? missedRolloverBoundaries(clockSnapshot.lastAdvancedAt, now, schedulerRolloverHourUtc()) > 0 : true;
  if (!due && !boundaryDue) return { changed: false };
  const needsGameDayEvents = boundaryDue || due?.timeBasis === "GAME_DAY";

  const result = await withGlobalLock(() => withGlobalLease(ctx.prisma, async () => {
      const loaded = await loadGlobalWorldMutable(ctx.prisma);
      if (!loaded) return { saveId: null, executed: 0 };
      const clock = await ensureGameClock(ctx.prisma, loaded.save.id, loaded.world);
       if (needsGameDayEvents) {
         await materializeSeasonEvents(ctx.prisma, loaded.save.id, loaded.world);
         await executeGameDayEventsInLock(ctx.prisma, loaded.save.id, clock.absoluteGameDay, now, "BEGIN_OF_DAY", true, loaded);
         await executeGameDayEventsInLock(ctx.prisma, loaded.save.id, clock.absoluteGameDay, now, "INTRADAY", true, loaded);
       }
      const existingAdvance = await ctx.prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
      if (!existingAdvance) {
        const dueAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (now.getUTCHours() >= schedulerRolloverHourUtc() ? 1 : 0), schedulerRolloverHourUtc()));
        await scheduleEvent(ctx.prisma, { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, timeBasis: "REAL_TIME", dueAt, priority: 10000, idempotencyKey: `GAME_DAY_ADVANCE:${clock.absoluteGameDay + 1}` });
      }
       let executed = await executeDueEventsInLock(ctx.prisma, loaded.save.id, now, { excludeTypes: new Set([ScheduledEventType.GAME_DAY_ADVANCE]) });
       let current = await loadGlobalWorldMutable(ctx.prisma);
       if (!current) return { saveId: loaded.save.id, executed };
       const currentClock = await ensureGameClock(ctx.prisma, current.save.id, current.world);
       const missingDays = missedRolloverBoundaries(currentClock.lastAdvancedAt, now, schedulerRolloverHourUtc());
       if (missingDays > 3) {
         await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
         return { saveId: loaded.save.id, executed };
       }
       await ctx.prisma.setting.deleteMany({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" } });
        try {
          for (let i = 0; i < missingDays; i++) {
            executed += await executeDueEventsInLock(ctx.prisma, loaded.save.id, now, { excludeTypes: new Set([ScheduledEventType.GAME_DAY_ADVANCE]) });
            await advanceGameDayInLock(ctx.prisma, { source: "AUTOMATIC", now, leaseHeld: true });
            current = await loadGlobalWorldMutable(ctx.prisma);
            if (!current) break;
          }
        } catch (error) {
          await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
          throw error;
        }
       executed += await executeDueEventsInLock(ctx.prisma, loaded.save.id, now);
       return { saveId: loaded.save.id, executed };
     }));
   if (result.saveId === null) return { changed: false };
    return { changed: result.executed > 0, persisted: true };
}

function missedRolloverBoundaries(lastAdvancedAt: Date, now: Date, rolloverHourUtc: number): number {
  const last = lastAdvancedAt.getTime();
  const lastBoundary = Date.UTC(lastAdvancedAt.getUTCFullYear(), lastAdvancedAt.getUTCMonth(), lastAdvancedAt.getUTCDate(), rolloverHourUtc);
  const firstBoundary = lastBoundary <= last ? lastBoundary + 24 * 60 * 60 * 1000 : lastBoundary;
  if (firstBoundary > now.getTime()) return 0;
  return Math.floor((now.getTime() - firstBoundary) / (24 * 60 * 60 * 1000)) + 1;
}
