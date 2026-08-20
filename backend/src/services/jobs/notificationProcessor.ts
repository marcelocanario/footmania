import type { JobContext, JobResult } from "./runner";
import { evaluateInactivity } from "../../game/multiplayer";
import { NOTIFICATIONS, missingDailyDates, parseDateKey } from "../../game/daily";
import { persistWorld } from "../saveService";

/**
 * Notification processor (worker plan §1).
 *
 * Evaluates inactivity and emits warning notifications for every missed UTC
 * date. Each date is persisted with a NOTIFICATIONS execution row before the
 * next date is attempted, so downtime recovery resumes exactly where it left
 * off. `evaluateInactivity` is stage-aware, so repeated execution is safe.
 */
export async function notificationProcessor(ctx: JobContext): Promise<JobResult> {
  const { world } = ctx;

  const now = new Date();

  const executions = await ctx.prisma.dailyExecution.findMany({
    where: { saveId: ctx.saveId, seasonId: world.mp.seasonId, executionType: NOTIFICATIONS },
    select: { date: true },
  });
  const executedDates = new Set(executions.map((execution) => execution.date));
  const dates = missingDailyDates(null, now);
  let processed = 0;

  for (const date of dates) {
    if (executedDates.has(date)) continue;
    const day = parseDateKey(date);
    world.year = world.mp.seasonYear;
    world.dayIndex = day.getUTCDate();
    world.dayOfWeek = day.getUTCDay();
    // Persist even when no news is emitted: inactivity state changes and the
    // execution marker must survive a restart.
    evaluateInactivity(world, day.getTime());
    await persistWorld(ctx.prisma, ctx.saveId, ctx.saveId, world, ctx.revision, {
      dailyExecutions: [{ seasonId: world.mp.seasonId, date, executionType: NOTIFICATIONS }],
    });
    const fresh = await ctx.prisma.save.findUnique({ where: { id: ctx.saveId }, select: { revision: true } });
    (ctx as { revision: number }).revision = fresh?.revision ?? ctx.revision;
    executedDates.add(date);
    processed++;
  }

  return { changed: processed > 0, persisted: processed > 0 };
}
