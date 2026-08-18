import type { JobContext, JobResult } from "./runner";
import { DAILY_TICK, missingDailyDates, processDailyDate, isValidDateKey, parseDateKey } from "../../game/daily";
import { rollover } from "../mpService";
import { seasonRefFor } from "../../game/clock";
import { persistWorld } from "../saveService";

/**
 * Daily processor (worker plan §2/§3/§4).
 *
 * Determines the last processed UTC date and replays every missing date
 * through today, persisting after EACH date. A crash halfway through a
 * multi-day recovery resumes from the last persisted date because
 * world.mp.lastDailyTickDate is persisted atomically with the world.
 *
 * Month-boundary coordination (plan §4):
 *  - dates in the world's current calendar month replay daily events;
 *  - when a month boundary is crossed the season is rolled over first
 *    (atomic + idempotent), then the new season's daily dates are processed.
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

  // Coordinates: the season currently active in the world vs. the calendar.
  const ref = seasonRefFor(now);
  const worldOrder = world.mp.seasonYear * 12 + (world.mp.seasonMonth - 1);
  const realOrder = ref.year * 12 + (ref.month - 1);

  // A future admin-controlled season must not be advanced by the real clock.
  if (worldOrder > realOrder) return { changed: false };

  // If the world is behind the calendar, roll over to the current month first.
  if (world.mp.seasonId !== 0 && worldOrder < realOrder) {
    await rollover(ctx.prisma);
    return { changed: true, persisted: true };
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
    const dateRef = seasonRefFor(day);
    // Only dates inside the current season's month are processed here; a
    // rollover happens first when a boundary is crossed.
    if (dateRef.year !== world.mp.seasonYear || dateRef.month !== world.mp.seasonMonth) {
      continue;
    }
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
