import type { JobContext, JobResult } from "./runner";
import { DAILY_TICK, missingDailyDates, processDailyDate, isValidDateKey, parseDateKey } from "../../game/daily";
import { persistWorld } from "../saveService";

/**
 * Daily processor (worker plan §2/§3/§4).
 *
 * Determines the last processed UTC date and replays every missing date
 * through today, persisting after EACH date. A crash halfway through a
 * multi-day recovery resumes from the last persisted date because
 * world.mp.lastDailyTickDate is persisted atomically with the world.
 *
 * Season boundaries are owned by the durable scheduler. This compatibility
 * job only replays legacy daily markers and never chooses a season from the
 * host calendar.
 */
export async function dailyProcessor(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;
  const now = new Date();

  // Migration: legacy saves only carry lastDailyTickDay (yyyymmdd). Derive the
  // date string once so catch-up starts from the day after that marker.
  if (!world.mp.lastDailyTickDate) {
    const legacy = world.mp.lastDailyTickDay;
    if (legacy && legacy > 0) {
      const y = Math.floor(legacy / 10000);
      const m = Math.floor((legacy % 10000) / 100);
      const d = legacy % 100;
      world.mp.lastDailyTickDate = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Use the persisted marker as the lower bound, then use the ledger to skip
  // dates already recorded after that marker. This preserves compatibility
  // with legacy saves that have no ledger history while still repairing gaps in
  // the new persisted trigger range.
  const executions = await ctx.prisma.dailyExecution.findMany({
    where: { saveId: ctx.saveId, seasonId: world.mp.seasonId, executionType: DAILY_TICK },
    select: { date: true },
  });
  const executedDates = new Set(executions.map((execution) => execution.date));
  const dates = missingDailyDates(world.mp.lastDailyTickDate, now);
  if (dates.length === 0) return { changed: false };
  let markerChanged = false;
  let processed = false;

  for (const date of dates) {
    if (!isValidDateKey(date)) continue;
    const day = parseDateKey(date);
    if (executedDates.has(date)) {
      if (!world.mp.lastDailyTickDate || date > world.mp.lastDailyTickDate) {
        world.mp.lastDailyTickDate = date;
        markerChanged = true;
      }
      continue;
    }
    const result = processDailyDate(world, { date, now: day.getTime() });
    world.mp.lastDailyTickDate = date;

    const dailyExecutions = result.executed.map((executionType) => ({
      seasonId: world.mp.seasonId,
      date,
      executionType,
    }));

    // Persist after every date so a crash resumes from the last completed one.
    await persistWorld(ctx.prisma, ctx.saveId, ctx.saveId, world, ctx.revision, { dailyExecutions });
    processed = true;
    // The persist bumped the revision; keep the local pointer in sync.
    const fresh = await ctx.prisma.save.findUnique({ where: { id: ctx.saveId }, select: { revision: true } });
    (ctx as { revision: number }).revision = fresh?.revision ?? ctx.revision;
  }

  if (markerChanged) {
    await persistWorld(ctx.prisma, ctx.saveId, ctx.saveId, world, ctx.revision);
    const fresh = await ctx.prisma.save.findUnique({ where: { id: ctx.saveId }, select: { revision: true } });
    (ctx as { revision: number }).revision = fresh?.revision ?? ctx.revision;
  }

  return { changed: markerChanged || processed, persisted: true };
}
