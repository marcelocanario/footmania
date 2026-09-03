import type { PrismaClient } from "@prisma/client";
import { gameConfig } from "../config";
import { calendarValues, phaseForSeasonDayIndex } from "./seasonCalendar";
import { withGlobalLease, withGlobalLock } from "./lock";
import { loadGlobalWorldMutable, persistWorld } from "./saveService";
import { executeGameDayEventsInLock, executeMandatoryEventsInLock, materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "./scheduler";
import { rollover } from "./mpService";
import { publishUserWorldEvent } from "./worldEvents";
import { DAY_MS, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "./dayBoundary";
import { isLaunchHold } from "./seasonPause";
import { CLUBS_PER_DIVISION } from "../game/multiplayer";

export interface GameClockView {
  id: "WORLD";
  absoluteGameDay: number;
  seasonId: number;
  seasonNumber: number;
  seasonDayIndex: number;
  phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
  interseasonDays: number;
  interseasonAfterMatchDays: number;
  interseasonBeforeNextSeasonDays: number;
  lastLeagueMatchDayIndex: number;
  interseasonStartIndex: number;
  preparationStartIndex: number;
  lastAdvancedAt: Date;
  /** The boundary instant this game day started at — always boundary-aligned. */
  lastBoundaryAt: Date;
  /** True while the season has played nothing (launch hold, pre- or post-lift). */
  launchHold: boolean;
  /** Boundary day 1 begins at while a launch hold is (or was just) in effect. */
  seasonStartsAt: number | null;
  /** Owned clubs (DORMANT included) toward the roster-hold release threshold. */
  launchHoldClubs: number;
  /** The roster-hold release threshold — CLUBS_PER_DIVISION. */
  launchHoldTarget: number;
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
  // Roster-hold migration: a world already sitting in the old first-human
  // hold carries the legacy flag; the new flag is authoritative from now on.
  world.mp.awaitingLaunchRoster ??= world.mp.awaitingFirstHuman;
  // The game-day grid reference: always the boundary instant (dayBoundary.ts).
  // lastAdvancedAt stays "when the advance physically ran" for display/audit.
  world.mp.lastBoundaryAt ??= dayBoundaryAtOrBefore(world.mp.lastAdvancedAt ?? Date.now());
  // Boundary-aligned: kickoffs are on the 30m UTC grid (00:00, 00:30...) and
  // the anchor for that grid is the day boundary itself. A raw seasonStartAt
  // at 18:26 would produce 18:26/18:56 slots. Align to the boundary unless
  // the world is currently paused — pause/shift preserves the exact wall-clock
  // mapping and will be re-anchored to the boundary at the next rollover
  // (seasonRolloverService). With the two-shift resume split every anchor is
  // boundary-aligned by construction, so this re-snap is normally a no-op.
  const isPaused = world.mp.pausedAt !== null && world.mp.pausedAt !== undefined;
  if (world.mp.seasonStartAt === null || world.mp.seasonStartAt === undefined) {
    world.mp.seasonStartAt = dayBoundaryAtOrBefore(world.mp.lastAdvancedAt ?? Date.now());
  } else if (!isPaused) {
    const aligned = dayBoundaryAtOrBefore(world.mp.seasonStartAt);
    if (aligned !== world.mp.seasonStartAt) world.mp.seasonStartAt = aligned;
  }
}

export async function ensureGameClock(prisma: PrismaClient, saveId: number, world?: import("../game/types").World): Promise<GameClockView> {
  const loaded = world ? { world } : await loadGlobalWorldMutable(prisma);
  if (!loaded) throw new Error("Global world unavailable");
  normalizeWorldClock(loaded.world);
  const now = loaded.world.mp.lastAdvancedAt ? new Date(loaded.world.mp.lastAdvancedAt) : new Date();
  const lastBoundaryAt = loaded.world.mp.lastBoundaryAt !== null && loaded.world.mp.lastBoundaryAt !== undefined ? new Date(loaded.world.mp.lastBoundaryAt) : now;
  const row = await prisma.gameClock.upsert({
    where: { saveId },
    update: {
      absoluteGameDay: loaded.world.mp.absoluteGameDay!,
      seasonId: loaded.world.mp.seasonId,
      seasonNumber: loaded.world.mp.seasonNumber!,
      seasonDayIndex: loaded.world.mp.seasonDayIndex!,
      phase: loaded.world.mp.phase!,
      lastAdvancedAt: now,
      lastBoundaryAt,
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
      lastBoundaryAt,
      version: loaded.world.mp.clockVersion ?? 0,
    },
  });
  return toClockView(row, loaded.world);
}

function toClockView(row: { absoluteGameDay: number; seasonId: number; seasonNumber: number; seasonDayIndex: number; phase: string; lastAdvancedAt: Date; lastBoundaryAt: Date | null; version: number }, world: import("../game/types").World): GameClockView {
  const calendar = calendarValues();
  const now = Date.now();
  const launchHold = isLaunchHold(world);
  // The boundary day 1 begins at. Once the hold has been lifted this is the
  // anchored mp.lastBoundaryAt (in the future); while still held it is the
  // projected start — the next boundary after now.
  let seasonStartsAt: number | null = null;
  if (launchHold) {
    const anchored = world.mp.lastBoundaryAt;
    seasonStartsAt = anchored !== null && anchored !== undefined && anchored > now ? anchored : nextDayBoundaryAfter(now);
  }
  return {
    id: "WORLD",
    absoluteGameDay: row.absoluteGameDay,
    seasonId: row.seasonId,
    seasonNumber: row.seasonNumber,
    seasonDayIndex: row.seasonDayIndex,
    phase: row.phase === "INTERSEASON" || row.phase === "POST_MATCH" ? row.phase : "ACTIVE",
    interseasonDays: calendar.interseasonDays,
    interseasonAfterMatchDays: calendar.interseasonAfterMatchDays,
    interseasonBeforeNextSeasonDays: calendar.interseasonBeforeNextSeasonDays,
    lastLeagueMatchDayIndex: calendar.lastLeagueMatchDayIndex,
    interseasonStartIndex: calendar.interseasonStartIndex,
    preparationStartIndex: calendar.preparationStartIndex,
    lastAdvancedAt: row.lastAdvancedAt,
    lastBoundaryAt: row.lastBoundaryAt ?? row.lastAdvancedAt,
    launchHold,
    seasonStartsAt,
    launchHoldClubs: world.clubs.filter((club) => club.ownerUserId !== null).length,
    launchHoldTarget: CLUBS_PER_DIVISION,
    version: row.version,
  };
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
    let loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("Global world unavailable");
    let world = loaded.world;
    normalizeWorldClock(world);
    const currentIndex = world.mp.seasonDayIndex!;
    const currentAbsolute = world.mp.absoluteGameDay!;
    const seasonBeforeMandatory = world.mp.seasonId;

    if (!options.force) {
      // Elegant fix: a live match (already started) is allowed to spill over
      // to the next calendar day — the scheduler should not block rollover
      // for a match that has already kicked off. Only fixtures with no
      // liveMatch at all (future or failed to start) block advancement.
      // This makes 23:30 + 35m = 00:05 spillover harmless, while still
      // preventing the day from skipping before today's fixtures have started.
      const dayFixtures = world.fixtures.filter((fixture) => fixture.scheduledSeasonDayIndex === currentIndex || (fixture.scheduledSeasonDayIndex === undefined && fixture.dayIndex === currentIndex));
      const unresolvedFixtures = dayFixtures.filter((fixture) => !fixture.played && !world.liveMatches.some((match) => match.fixtureId === fixture.id));
      if (unresolvedFixtures.length > 0) {
        const details = unresolvedFixtures.map((fixture) => {
          const live = world.liveMatches.find((match) => match.fixtureId === fixture.id);
          const scheduledAt = fixture.kickoffAt !== undefined ? new Date(fixture.kickoffAt).toISOString() : "no-kickoff";
          const nowIso = (options.now ?? new Date()).toISOString();
          return {
            fixtureId: fixture.id,
            competitionId: fixture.competitionId,
            round: fixture.round,
            homeClubId: fixture.homeClubId,
            awayClubId: fixture.awayClubId,
            dayIndex: fixture.dayIndex,
            scheduledSeasonDayIndex: fixture.scheduledSeasonDayIndex,
            played: fixture.played,
            kickoffAt: fixture.kickoffAt,
            kickoffAtIso: scheduledAt,
            liveMatch: live ? { matchId: live.matchId, ended: live.ended, minute: live.minute, half: live.half, matchClockSeconds: live.matchClockSeconds, lastAdvancedAt: live.lastAdvancedAt ? new Date(live.lastAdvancedAt).toISOString() : null, halftimeStartedAt: live.halftimeStartedAt ? new Date(live.halftimeStartedAt).toISOString() : null, period: live.period } : null,
            msUntilKickoff: fixture.kickoffAt !== undefined ? fixture.kickoffAt - (options.now ?? new Date()).getTime() : null,
            msSinceKickoff: fixture.kickoffAt !== undefined ? (options.now ?? new Date()).getTime() - fixture.kickoffAt : null,
          };
        });
        const debug = {
          currentIndex,
          currentAbsolute,
          seasonDayIndex: world.mp.seasonDayIndex,
          absoluteGameDay: world.mp.absoluteGameDay,
          seasonId: world.mp.seasonId,
          seasonNumber: world.mp.seasonNumber,
          now: (options.now ?? new Date()).toISOString(),
          seasonStartAt: world.mp.seasonStartAt ? new Date(world.mp.seasonStartAt).toISOString() : null,
          lastAdvancedAt: world.mp.lastAdvancedAt ? new Date(world.mp.lastAdvancedAt).toISOString() : null,
          totalDayFixtures: dayFixtures.length,
          totalFixtures: world.fixtures.length,
          unresolvedCount: unresolvedFixtures.length,
          unresolvedFixtures: details,
        };
        console.error(`[gameClock] Cannot advance: unresolved matches for seasonDayIndex ${currentIndex} (absolute ${currentAbsolute})`, JSON.stringify(debug, null, 2));
        const summary = unresolvedFixtures.map((fixture) => {
          const live = world.liveMatches.find((m) => m.fixtureId === fixture.id);
          const kickoff = fixture.kickoffAt ? new Date(fixture.kickoffAt).toISOString() : "none";
          return `fixture ${fixture.id} (comp ${fixture.competitionId} round ${fixture.round} ${fixture.homeClubId} vs ${fixture.awayClubId}) kickoff=${kickoff} played=${fixture.played} live=${live ? `matchId ${live.matchId} ended=${live.ended} minute=${live.minute}` : "none"}`;
        }).join("; ");
        throw new Error(`Cannot advance while a scheduled match is unresolved: ${summary} | debug=${JSON.stringify(debug)}`);
      }
    }

    await executeMandatoryEventsInLock(prisma, loaded.save.id, currentAbsolute, options.now ?? new Date(), loaded);
    world = loaded.world;
    normalizeWorldClock(world);

    const now = options.now ?? new Date();
    const nextAbsolute = currentAbsolute + 1;
    // The grid reference for the day that is about to start. Automatic
    // advances record exactly one boundary step, so a deferred advance that
    // finally lands at 04:17 still records the 00:00 boundary and the next
    // advance is tomorrow 00:00 — no drift and no "advance again" when a
    // blocked advance lands late. A manual/forced advance re-anchors to the
    // day containing now: the manual day is short, but the grid stays aligned.
    const isManual = options.source === "ADMIN" || options.force === true;
    const nextBoundary = isManual
      ? dayBoundaryAtOrBefore(now.getTime())
      : (world.mp.lastBoundaryAt ?? dayBoundaryAtOrBefore(world.mp.lastAdvancedAt ?? now.getTime())) + DAY_MS;
    if (currentIndex + 1 >= gameConfig.seasonDays) {
      // Mandatory scheduled events normally complete the rollover workflow
      // before this boundary. The fallback covers saves whose workflow events
      // have not been materialized yet without running a second rollover.
      if (world.mp.seasonId === seasonBeforeMandatory) {
       await rollover(prisma, { calendarBoundary: true, leaseHeld: true });
      }
      const fresh = await loadGlobalWorldMutable(prisma);
      if (!fresh) throw new Error("World disappeared during season rollover");
      normalizeWorldClock(fresh.world);
      fresh.world.mp.absoluteGameDay = nextAbsolute;
       fresh.world.mp.seasonNumber = world.mp.seasonNumber ?? 1;
      fresh.world.mp.seasonDayIndex = 0;
       fresh.world.mp.startAbsoluteGameDay = nextAbsolute;
       fresh.world.mp.lastBoundaryAt = nextBoundary;
       fresh.world.mp.seasonStartAt = nextBoundary;
      fresh.world.mp.phase = "ACTIVE";
       fresh.world.mp.lastAdvancedAt = now.getTime();
        fresh.world.mp.clockVersion = (world.mp.clockVersion ?? 0) + 1;
       await persistWorld(prisma, fresh.save.id, fresh.save.id, fresh.world, fresh.save.revision);
       fresh.save.revision += 1;
       await materializeSeasonEvents(prisma, fresh.save.id, fresh.world);
       await executeGameDayEventsInLock(prisma, fresh.save.id, nextAbsolute, now, "BEGIN_OF_DAY", true, fresh);
       await scheduleNextAutomaticAdvance(prisma, fresh.save.id, nextAbsolute, nextBoundary);
        const row = await ensureGameClock(prisma, fresh.save.id, fresh.world);
        await writeAdminAudit(prisma, fresh.save.id, options, { absoluteGameDay: currentAbsolute, seasonDayIndex: currentIndex }, row);
        publishDayAdvanced(fresh.world);
        return row;
    }

    world.mp.absoluteGameDay = nextAbsolute;
    world.mp.seasonDayIndex = currentIndex + 1;
    world.mp.phase = phaseForSeasonDayIndex(world.mp.seasonDayIndex, gameConfig);
    world.mp.lastAdvancedAt = now.getTime();
    world.mp.lastBoundaryAt = nextBoundary;
    world.mp.clockVersion = (world.mp.clockVersion ?? 0) + 1;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    loaded.save.revision += 1;
    await materializeSeasonEvents(prisma, loaded.save.id, world);
    await executeGameDayEventsInLock(prisma, loaded.save.id, nextAbsolute, now, "BEGIN_OF_DAY", true, loaded);
    await scheduleNextAutomaticAdvance(prisma, loaded.save.id, nextAbsolute, nextBoundary);
    const row = await ensureGameClock(prisma, loaded.save.id, loaded.world);
    await writeAdminAudit(prisma, loaded.save.id, options, { absoluteGameDay: currentAbsolute, seasonDayIndex: currentIndex }, row);
    publishDayAdvanced(loaded.world);
    return row;
}

function publishDayAdvanced(world: import("../game/types").World): void {
  for (const club of world.clubs) {
    if (club.ownerUserId !== null) publishUserWorldEvent(club.ownerUserId, { type: "dayAdvanced" });
  }
}

async function scheduleNextAutomaticAdvance(prisma: PrismaClient, saveId: number, nextAbsolute: number, lastBoundaryAt: number): Promise<void> {
  await prisma.scheduledEvent.updateMany({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" }, data: { status: "CANCELLED", version: { increment: 1 } } });
  await scheduleEvent(prisma, {
    saveId,
    type: ScheduledEventType.GAME_DAY_ADVANCE,
    timeBasis: "REAL_TIME",
    // The pending row is a display/audit mirror: the actual trigger is
    // boundariesElapsed(lastBoundaryAt, now) in the scheduler processor. Both
    // derive from the same boundary, so they can never disagree.
    dueAt: new Date(lastBoundaryAt + DAY_MS),
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
