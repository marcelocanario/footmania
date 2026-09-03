import type { JobContext, JobResult } from "./runner";
import { withGlobalLease, withGlobalLock } from "../lock";
import { advanceGameDayInLock, ensureGameClock } from "../gameClockService";
import { executeDueEventsInLock, executeGameDayEventsInLock, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../scheduler";
import { loadGlobalWorldMutable } from "../saveService";
import { isWorldPausedGlobally } from "../seasonPause";
import { boundariesElapsed, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "../dayBoundary";

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
  const boundaryAt = clockSnapshot
    ? clockSnapshot.lastBoundaryAt !== null
      ? clockSnapshot.lastBoundaryAt.getTime()
      : dayBoundaryAtOrBefore(clockSnapshot.lastAdvancedAt.getTime())
    : null;
  const boundaryDue = boundaryAt !== null ? boundariesElapsed(boundaryAt, now.getTime()) > 0 : true;
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
        // Same derivation as scheduleNextAutomaticAdvance: exactly one boundary
        // after the current game day's start, so the fallback row and the row
        // the advance path writes are byte-identical.
        const dueAt = new Date(nextDayBoundaryAfter(clock.lastBoundaryAt.getTime()));
        await scheduleEvent(ctx.prisma, { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, timeBasis: "REAL_TIME", dueAt, priority: 10000, idempotencyKey: `GAME_DAY_ADVANCE:${clock.absoluteGameDay + 1}` });
      }
       let executed = await executeDueEventsInLock(ctx.prisma, loaded.save.id, now, { excludeTypes: new Set([ScheduledEventType.GAME_DAY_ADVANCE]) });
       let current = await loadGlobalWorldMutable(ctx.prisma);
       if (!current) return { saveId: loaded.save.id, executed };
       const currentClock = await ensureGameClock(ctx.prisma, current.save.id, current.world);
       const missingDays = boundariesElapsed(currentClock.lastBoundaryAt.getTime(), now.getTime());
       if (missingDays > 3) {
         await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
         return { saveId: loaded.save.id, executed };
       }
        await ctx.prisma.setting.deleteMany({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" } });
         try {
            for (let i = 0; i < missingDays; i++) {
              executed += await executeDueEventsInLock(ctx.prisma, loaded.save.id, now, { excludeTypes: new Set([ScheduledEventType.GAME_DAY_ADVANCE]) });
              // Diagnostic: before each automatic day advance, log unresolved fixtures if any
              // Note: spillover live matches are *not* blocking — only fixtures with
              // no liveMatch at all (future/failed) block rollover.
              const preAdvance = await loadGlobalWorldMutable(ctx.prisma);
              if (preAdvance) {
                const idx = preAdvance.world.mp.seasonDayIndex ?? preAdvance.world.dayIndex;
                const dayFixtures = preAdvance.world.fixtures.filter((f) => f.scheduledSeasonDayIndex === idx || (f.scheduledSeasonDayIndex === undefined && f.dayIndex === idx));
                const unresolvedPre = dayFixtures.filter((f) => !f.played && !preAdvance.world.liveMatches.some((m) => m.fixtureId === f.id));
                if (unresolvedPre.length > 0) {
                  console.warn(`[scheduler] day advance blocked: ${unresolvedPre.length} unresolved for seasonDayIndex ${idx} (attempt ${i + 1}/${missingDays})`, unresolvedPre.map((f) => ({ fixtureId: f.id, round: f.round, home: f.homeClubId, away: f.awayClubId, kickoffAt: f.kickoffAt ? new Date(f.kickoffAt).toISOString() : null, played: f.played, live: preAdvance.world.liveMatches.find((m) => m.fixtureId === f.id) ? { ended: preAdvance.world.liveMatches.find((m) => m.fixtureId === f.id)!.ended, minute: preAdvance.world.liveMatches.find((m) => m.fixtureId === f.id)!.minute } : null })));
                }
              }
              await advanceGameDayInLock(ctx.prisma, { source: "AUTOMATIC", now, leaseHeld: true });
              current = await loadGlobalWorldMutable(ctx.prisma);
              if (!current) break;
            }
          } catch (error) {
            const isUnresolvedBlock = error instanceof Error && error.message.includes("scheduled match is unresolved");
            // Spillover / future-fixture blocks are expected mid-day — don't
            // flag admin review, just wait for next tick. Only true domain
            // errors (stale lease, missing prerequisite, etc.) need review.
            if (isUnresolvedBlock) {
              const diag = await loadGlobalWorldMutable(ctx.prisma).catch(() => null);
              if (diag) {
                const idx = diag.world.mp.seasonDayIndex ?? diag.world.dayIndex;
                const dayFixtures = diag.world.fixtures.filter((f) => f.scheduledSeasonDayIndex === idx || (f.scheduledSeasonDayIndex === undefined && f.dayIndex === idx));
                const unresolved = dayFixtures.filter((f) => !f.played && !diag.world.liveMatches.some((m) => m.fixtureId === f.id));
                console.warn(`[scheduler] day advance deferred (will retry): seasonDayIndex ${idx} unresolved=${unresolved.length} liveSpillover=${dayFixtures.length - unresolved.length}`, { unresolved: unresolved.map((f) => ({ id: f.id, kickoffAt: f.kickoffAt ? new Date(f.kickoffAt).toISOString() : null })) });
              } else {
                console.warn(`[scheduler] day advance deferred: ${error instanceof Error ? error.message : String(error)}`);
              }
              return { saveId: loaded.save.id, executed };
            }
            // Attach scheduler context to help diagnose which match blocked the rollover
            const diag = await loadGlobalWorldMutable(ctx.prisma).catch(() => null);
            if (diag) {
              const idx = diag.world.mp.seasonDayIndex ?? diag.world.dayIndex;
              const dayFixtures = diag.world.fixtures.filter((f) => f.scheduledSeasonDayIndex === idx || (f.scheduledSeasonDayIndex === undefined && f.dayIndex === idx));
              const unresolved = dayFixtures.filter((f) => !f.played && !diag.world.liveMatches.some((m) => m.fixtureId === f.id));
              console.error(`[scheduler] advanceGameDay failed at seasonDayIndex ${idx} absolute ${diag.world.mp.absoluteGameDay} missingDays=${missingDays} unresolved=${unresolved.length}`, { unresolved: unresolved.map((f) => ({ id: f.id, kickoffAt: f.kickoffAt ? new Date(f.kickoffAt).toISOString() : null, played: f.played, live: diag.world.liveMatches.find((m) => m.fixtureId === f.id) ?? null })), error: error instanceof Error ? error.message : String(error) });
            }
            await ctx.prisma.setting.upsert({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, update: { value: "1" }, create: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });
            throw error;
          }
       executed += await executeDueEventsInLock(ctx.prisma, loaded.save.id, now);
       return { saveId: loaded.save.id, executed };
     }));
   if (result.saveId === null) return { changed: false };
    return { changed: result.executed > 0, persisted: true };
}
