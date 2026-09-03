import { PrismaClient } from "@prisma/client";
import { withGlobalLock, withGlobalLease } from "../src/services/lock";
import { loadGlobalWorldMutable, persistWorld } from "../src/services/saveService";
import { dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "../src/services/dayBoundary";
import { realignFixtureKickoff } from "../src/game/scheduling";
import { scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { isPaused, syncFixtureKickoffs } from "../src/services/seasonPause";
import { CLUBS_PER_DIVISION, humanOwnedClubCount } from "../src/game/multiplayer";

/**
 * Game-day-boundary repair migration (deterministic midnight grid).
 *
 * Tier A — invisible bookkeeping, ALWAYS applied. Only writes values the old
 * code already tolerated, none of them player-visible:
 *   1. mp.seasonStartAt is snapped to its containing boundary;
 *   2. mp.lastBoundaryAt is backfilled to the boundary of lastAdvancedAt;
 *   3. the pending GAME_DAY_ADVANCE row is re-derived to
 *      nextDayBoundaryAfter(lastBoundaryAt) and GameClock.lastBoundaryAt is
 *      mirrored;
 *   4. the SCHEDULER_REQUIRES_ADMIN_REVIEW flag is cleared so a wedged
 *      scheduler resumes.
 *
 * Tier B — kickoff re-alignment, REPORT-ONLY by default. Unplayed, not-yet-
 * kicked-off fixtures whose kickoff drifted out of their own game day are
 * re-anchored (same half-hour slot preserved) — but this changes when real
 * players' matches kick off, so it only happens with FOOTMANIA_REALIGN_KICKOFFS=1,
 * and only while the world is paused with no live match in progress.
 *
 * Idempotent: a second run performs no writes (a second run after Tier B was
 * applied reports nothing).
 */

const APPLY = process.env.FOOTMANIA_REALIGN_KICKOFFS === "1";

const prisma = new PrismaClient();

async function redriveAdvanceRow(saveId: number, desiredAt: number, absoluteGameDay: number): Promise<boolean> {
  const existing = await prisma.scheduledEvent.findFirst({
    where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: { in: ["PENDING", "FAILED"] } },
    orderBy: { dueAt: "asc" },
    select: { id: true, dueAt: true },
  });
  if (existing) {
    if (existing.dueAt?.getTime() === desiredAt) return false;
    await prisma.scheduledEvent.updateMany({
      where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: { in: ["PENDING", "FAILED"] } },
      data: { dueAt: new Date(desiredAt), version: { increment: 1 } },
    });
    return true;
  }
  // No live row. Clear any rows squatting on the canonical key, then insert.
  await prisma.scheduledEvent.updateMany({
    where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "CANCELLED", version: { increment: 1 } },
  });
  let inserted = await scheduleEvent(prisma, {
    saveId,
    type: ScheduledEventType.GAME_DAY_ADVANCE,
    timeBasis: "REAL_TIME",
    dueAt: new Date(desiredAt),
    priority: 10000,
    payload: { targetAbsoluteGameDay: absoluteGameDay + 1 },
    idempotencyKey: `GAME_DAY_ADVANCE:${absoluteGameDay + 1}`,
  });
  if (inserted.status !== "PENDING") {
    if (inserted.status === "CANCELLED") {
      // A leftover of a previous repair holding the canonical key: drop it
      // and retry once so a pending row always exists.
      await prisma.scheduledEvent.delete({ where: { id: inserted.id } });
      inserted = await scheduleEvent(prisma, {
        saveId,
        type: ScheduledEventType.GAME_DAY_ADVANCE,
        timeBasis: "REAL_TIME",
        dueAt: new Date(desiredAt),
        priority: 10000,
        payload: { targetAbsoluteGameDay: absoluteGameDay + 1 },
        idempotencyKey: `GAME_DAY_ADVANCE:${absoluteGameDay + 1}`,
      });
    } else {
      // A COMPLETED row already consumed this key (crash between an advance
      // and its re-schedule): keep the audit record and insert under a
      // versioned key instead. The scheduler's insert-if-missing sees the
      // pending row and skips, and the next advance cancels it with the rest.
      inserted = await scheduleEvent(prisma, {
        saveId,
        type: ScheduledEventType.GAME_DAY_ADVANCE,
        timeBasis: "REAL_TIME",
        dueAt: new Date(desiredAt),
        priority: 10000,
        payload: { targetAbsoluteGameDay: absoluteGameDay + 1 },
        idempotencyKey: `GAME_DAY_ADVANCE:${absoluteGameDay + 1}:boundary-repair`,
      });
    }
  }
  return true;
}

async function run(): Promise<void> {
  await withGlobalLock(async () => {
    const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
    if (!save) {
      console.log("[boundary-migration] no global Save; nothing to do");
      return;
    }
    await withGlobalLease(prisma, async () => {
      const loaded = await loadGlobalWorldMutable(prisma);
      if (!loaded) throw new Error("Global world unavailable");
      const world = loaded.world;
      const now = Date.now();
      let changed = false;

      // ---- Tier A: invisible bookkeeping ----------------------------------
      const alignedSeasonStart = dayBoundaryAtOrBefore(world.mp.seasonStartAt ?? world.mp.lastAdvancedAt ?? now);
      const alignedBoundary = dayBoundaryAtOrBefore(world.mp.lastAdvancedAt ?? now);
      if (world.mp.seasonStartAt !== alignedSeasonStart) {
        world.mp.seasonStartAt = alignedSeasonStart;
        changed = true;
      }
      if (world.mp.lastBoundaryAt !== alignedBoundary) {
        world.mp.lastBoundaryAt = alignedBoundary;
        changed = true;
      }
      if (await redriveAdvanceRow(loaded.save.id, nextDayBoundaryAfter(world.mp.lastBoundaryAt!), world.mp.absoluteGameDay ?? world.dayIndex)) changed = true;
      const clearedReview = await prisma.setting.deleteMany({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" } });
      if (clearedReview.count > 0) {
        console.log("[boundary-migration] cleared SCHEDULER_REQUIRES_ADMIN_REVIEW");
        changed = true;
      }
      const clockRow = await prisma.gameClock.findUnique({ where: { saveId: loaded.save.id }, select: { lastBoundaryAt: true } });
      if (clockRow && clockRow.lastBoundaryAt?.getTime() !== world.mp.lastBoundaryAt) {
        await prisma.gameClock.update({ where: { saveId: loaded.save.id }, data: { lastBoundaryAt: new Date(world.mp.lastBoundaryAt!) } });
        changed = true;
      }

      // ---- Tier A: arm the roster launch hold on an existing world ---------
      // enterLaunchHold only runs at a world reset or a rollover that ends
      // with zero humans, so a world that is ALREADY admin-paused pre-season
      // (its first-human hold long since lifted) would carry no hold flag:
      // shouldReleaseLaunchHold would return false forever and the world
      // would never auto-resume when the roster completes. Arming it here is
      // invisible to players — the world is paused either way; it only
      // changes what releases it. The paused precondition is what keeps this
      // from ever re-arming a hold after a lift.
      const ownedClubs = humanOwnedClubCount(world);
      const playedAny = world.fixtures.some((fixture) => fixture.played);
      const preSeason = (world.mp.completedRounds ?? 0) === 0 && !playedAny;
      const alreadyHeld = world.mp.awaitingLaunchRoster === true || world.mp.awaitingFirstHuman === true;
      console.log(
        `[boundary-migration] world state: paused=${isPaused(world)} ownedClubs=${ownedClubs}/${CLUBS_PER_DIVISION} ` +
          `completedRounds=${world.mp.completedRounds ?? 0} playedFixtures=${world.fixtures.filter((f) => f.played).length} ` +
          `seasonDayIndex=${world.mp.seasonDayIndex ?? world.dayIndex} launchHoldArmed=${alreadyHeld}`,
      );
      if (!alreadyHeld && isPaused(world) && preSeason && ownedClubs < CLUBS_PER_DIVISION) {
        world.mp.awaitingLaunchRoster = true;
        changed = true;
        console.log(
          `[boundary-migration] armed the launch hold: ${ownedClubs}/${CLUBS_PER_DIVISION} clubs owned, nothing played. ` +
            `The world now auto-resumes when the roster completes; admin resume refuses until then (use force to start early).`,
        );
      } else if (!alreadyHeld) {
        const why = !isPaused(world) ? "world is not paused" : !preSeason ? "season has already played" : `roster already complete (${ownedClubs}/${CLUBS_PER_DIVISION})`;
        console.log(`[boundary-migration] launch hold NOT armed: ${why}`);
      }

      // ---- Tier B: kickoff re-alignment (report or apply) -----------------
      const liveMatchIds = new Set(world.liveMatches.map((match) => match.fixtureId));
      const misaligned: { fixture: (typeof world.fixtures)[number]; current: number; proposed: number }[] = [];
      for (const fixture of world.fixtures) {
        if (fixture.played || fixture.kickoffAt === undefined) continue;
        if (liveMatchIds.has(fixture.id)) continue;
        const proposed = realignFixtureKickoff(fixture, world.mp.seasonStartAt!);
        if (proposed !== fixture.kickoffAt) misaligned.push({ fixture, current: fixture.kickoffAt, proposed });
      }
      if (misaligned.length > 0) {
        console.log(`[boundary-migration] ${misaligned.length} fixture(s) outside their own game day:`);
        for (const entry of misaligned) {
          const fixture = entry.fixture;
          console.log(
            `  fixture ${fixture.id} (${fixture.homeClubId} vs ${fixture.awayClubId}, comp ${fixture.competitionId} round ${fixture.round}) ` +
              `current ${new Date(entry.current).toISOString()} -> proposed ${new Date(entry.proposed).toISOString()} ` +
              `(delta ${Math.round((entry.proposed - entry.current) / 1000)}s)`,
          );
        }
      } else {
        console.log("[boundary-migration] all unplayed fixtures are inside their own game day");
      }

      if (APPLY) {
        if (misaligned.length === 0) {
          console.log("[boundary-migration] FOOTMANIA_REALIGN_KICKOFFS=1 set but nothing to re-align");
        } else {
          if (world.liveMatches.length > 0) {
            throw new Error("[boundary-migration] refusing to re-align kickoffs while a live match is in progress; pause the world and wait for live matches to finish first");
          }
          if (!isPaused(world)) {
            throw new Error("[boundary-migration] refusing to re-align kickoffs while the world is not paused; pause the world first so no kickoff moves out from under a started match");
          }
          for (const entry of misaligned) entry.fixture.kickoffAt = entry.proposed;
          changed = true;
        }
      } else if (misaligned.length > 0) {
        console.log("[boundary-migration] report only (set FOOTMANIA_REALIGN_KICKOFFS=1 to apply)");
      }

      if (changed) {
        await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        if (APPLY && misaligned.length > 0) {
          await syncFixtureKickoffs(prisma, loaded.save.id, misaligned.map((entry) => entry.fixture));
        }
        console.log("[boundary-migration] applied Tier A clock repair" + (APPLY && misaligned.length > 0 ? ` + re-aligned ${misaligned.length} kickoff(s)` : ""));
      } else {
        console.log("[boundary-migration] no-op — clock grid already aligned");
      }
    });
  });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });