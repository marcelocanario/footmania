import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { invalidateWorldCache, loadGlobalWorldMutable, persistWorld, StaleWorldError } from "./saveService";
import { withGlobalLease, withGlobalLock } from "./lock";
import { DAY_MS, boundariesElapsed, dayBoundaryAtOrBefore, nextDayBoundaryAfter } from "./dayBoundary";
import { retimeDivisionFixtures } from "../game/multiplayer";
import { realignFixtureKickoff } from "../game/scheduling";
import { scheduleEvent, ScheduledEventType } from "./scheduler";

/**
 * Admin season pause ("freeze timers" semantics, INVARIANTS-preserving).
 *
 * While `world.mp.pausedAt` is set, that instant IS the authoritative world
 * clock: worker jobs (scheduler + live matches), automatic day advancement and
 * schedule-dependent user mutations are gated. Nothing advances and nothing
 * expires during the freeze — there is deliberately NO catch-up.
 *
 * Joining and dormant-returning are DELIBERATELY EXEMPT from the gate: a paused
 * joiner places into the same division an unpaused join would, anchoring every
 * timestamp to the frozen instant (routes/multiplayer.ts resolves `now` as
 * pausedAt while paused), and the history backfill chunk is scheduled at the
 * frozen instant so the resume shift lands it exactly on resumedAt. Market,
 * contract and admin controls stay frozen. While the launch hold
 * (awaitingLaunchRoster) is active the pause IS the wait — joins 1..N−1 fill
 * the roster without releasing it, and the N-th join (or an admin force
 * resume) lifts it — with the shift measured against the real wall clock so
 * the season actually starts.
 *
 * Resume has two modes:
 *
 * 1. **Launch hold** — the season has played nothing yet
 *    (awaitingLaunchRoster, or completedRounds === 0 and no played fixture),
 *    which covers both the automatic roster hold and the
 *    admin "hold until Division 1 fills" workflow. The season begins at the
 *    NEXT boundary after the lift: seasonStartAt and lastBoundaryAt are
 *    anchored to it (in the future), lastAdvancedAt records the lift instant,
 *    and every active division's fixtures are RE-TIMED against the now-current
 *    roster (the one sanctioned kickoff re-scheduling: no match has played, so
 *    it is equivalent to generating the season fresh). boundariesElapsed
 *    returns 0 for a future anchor, so no advance fires during
 *    [resumedAt, seasonBoundary) and nothing is stranded: the world is fully
 *    interactive while day 1 has not started. Real-time anchors still shift by
 *    the held interval (rawShift), so nothing expires across the hold — only
 *    the game-day grid takes the absolute anchor instead of a day-multiple
 *    shift. The hold is pre-season only and never re-arms once lifted; an
 *    admin may force the release early with the roster still under-strength
 *    (the remaining slots stay AI).
 *
 * 2. **Maintenance pause** — the literal rule: the current game day always
 *    ends at the next boundary, however little of it remains. The single
 *    shift is split into two:
 *
 *        rawShift  = resumedAt - pausedAt                      // real-time
 *        gridShift = boundariesElapsed(lastBoundaryAt, resumedAt) * DAY_MS
 *
 *    `gridShift` (a whole multiple of 24 h, by construction) applies to the
 *    game-day grid — mp.seasonStartAt, mp.lastBoundaryAt, mp.lastAdvancedAt,
 *    unplayed fixtures that have NOT kicked off (no entry in liveMatches) and
 *    their pending MATCH_START rows. This is the minimal shift that preserves
 *    "resuming can never fast-forward game days" while keeping every anchor
 *    boundary-aligned, so normalizeWorldClock's re-snap becomes a no-op and
 *    the boundary grid cannot drift (a pause crossing the rollover hour can
 *    no longer silently swallow a game day).
 *
 *    `rawShift` applies to every other real-time anchor — auctions,
 *    free-agent listings, loans, live-match pacing + halftime anchors,
 *    club.liveMatchAt, inactivity anchors and every other pending REAL_TIME
 *    event (plus embedded payload stamps), exactly as before.
 *
 *    Deliberate tradeoff: a pause crossing NO boundary leaves the day's
 *    kickoff grid untouched (gridShift = 0), so kickoffs that fell inside the
 *    freeze window start immediately on resume rather than being pushed out.
 *    That is correct — the game day is atomic — and it is what keeps a
 *    10-minute maintenance pause from extending the current day by 24 h.
 *
 *    The pending GAME_DAY_ADVANCE row is excluded from BOTH shifts and
 *    re-derived as nextDayBoundaryAfter(lastBoundaryAt + gridShift), so it can
 *    never carry a raw millisecond delta again.
 *
 * Day counters never move, so resuming can never fast-forward game days.
 */

export const WORLD_PAUSED_STATUS = 409;
export const WORLD_PAUSED_MESSAGE = "The season is paused";

/** Route-shaped error for schedule-dependent mutations while paused. */
export const worldPausedError = { code: WORLD_PAUSED_STATUS, body: { error: WORLD_PAUSED_MESSAGE } } as const;

export function isPaused(world: World): boolean {
  return typeof world.mp.pausedAt === "number" && Number.isFinite(world.mp.pausedAt);
}

/** The frozen world instant while paused; null while running. */
export function pausedInstant(world: World): number | null {
  return isPaused(world) ? (world.mp.pausedAt as number) : null;
}

/**
 * True while the season has played nothing at all. This is the launch-hold
 * test: the roster hold (awaitingLaunchRoster, or its retired legacy name
 * awaitingFirstHuman) holds from reset/zero-human rollover until the full
 * roster owns the division slots; the derived condition (no completed round
 * and no played fixture) additionally stays true through the interval between
 * the lift and the boundary day 1 begins at, so both the admin panel and
 * joining players see the hold.
 *
 * The flag alone suffices for the hold itself: archived fixtures of earlier
 * seasons linger in the world (their divisions are ARCHIVED, never deleted),
 * so a world that rolled over into waiting mode with zero humans still carries
 * old played fixtures even though the new season has played nothing.
 */
export function isLaunchHold(world: World): boolean {
  if (world.mp.awaitingLaunchRoster === true || world.mp.awaitingFirstHuman === true) return true;
  return world.mp.completedRounds === 0 && !world.fixtures.some((fixture) => fixture.played);
}

/** Cheap worker-side gate: parse only the Save row instead of the whole world. */
export async function isWorldPausedGlobally(prisma: PrismaClient): Promise<boolean> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { mpStateJson: true } });
  if (!save?.mpStateJson) return false;
  try {
    const mp = JSON.parse(save.mpStateJson) as { pausedAt?: number | null };
    return typeof mp.pausedAt === "number" && Number.isFinite(mp.pausedAt);
  } catch {
    return false;
  }
}

/**
 * Unplayed fixtures belonging to the CURRENT game day whose kickoff (after
 * the resume shift) already lies in the past. On the next tick such a fixture
 * resolves instantly — a MATCH_START at a past kickoff schedules MATCH_COMPLETE
 * also in the past, so the round finalizes with nobody able to watch. This is
 * a warning, not a block: the literal rule is the intended behaviour.
 */
export function countStrandedKickoffs(world: World, now: number): number {
  const dayIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  const liveFixtureIds = new Set(world.liveMatches.map((match) => match.fixtureId));
  let stranded = 0;
  for (const fixture of world.fixtures) {
    if (fixture.played || fixture.kickoffAt === undefined) continue;
    if (liveFixtureIds.has(fixture.id)) continue;
    const ownsDay = fixture.scheduledSeasonDayIndex === dayIndex || (fixture.scheduledSeasonDayIndex === undefined && fixture.dayIndex === dayIndex);
    if (ownsDay && fixture.kickoffAt < now) stranded++;
  }
  return stranded;
}

/**
 * Launch-hold lift: anchor the season to the next boundary and re-time the
 * fixtures against the now-complete roster. Pure world mutation (DB column
 * sync happens in the caller's transaction) and exported for unit tests.
 *
 * Re-timing supersedes Part 1's preserve-the-existing-slot behaviour: at
 * generation the slots were unconstrained AI fillers, so the humans who
 * replaced them have not influenced their own kickoff times. Re-optimizing
 * once, with the full roster in place and no match played, is equivalent to
 * generating the season fresh (see retimeDivisionFixtures in game/multiplayer).
 */
export function applyLaunchHoldResume(world: World, resumedAt: number): void {
  const seasonBoundary = nextDayBoundaryAfter(resumedAt);
  // The CURRENT game day begins at the boundary, so Season Day 0 sits
  // seasonDayIndex days earlier. A hold lifted on day 0 (the usual case)
  // anchors day 0 at the boundary; one lifted later — the derived launch
  // branch stays true until a match is played, so a pre-season world can sit
  // on day 1 — must NOT anchor day 0 there, or today's round lands a day late
  // and blocks the very advance this change exists to fix.
  const dayIndex = world.mp.seasonDayIndex ?? 0;
  const seasonStart = seasonBoundary - dayIndex * DAY_MS;
  world.mp.lastBoundaryAt = seasonBoundary;
  world.mp.seasonStartAt = seasonStart;
  world.mp.lastAdvancedAt = resumedAt;
  const retimed = new Set<number>();
  for (const comp of world.competitions) {
    if (comp.kind !== "division" || comp.seasonId !== world.mp.seasonId || comp.status === "ARCHIVED") continue;
    if (Object.keys(comp.standings).length === 0) continue;
    for (const id of retimeDivisionFixtures(world, comp, seasonStart)) retimed.add(id);
  }
  // Whatever the division sweep did not cover still points at the OLD anchor.
  // Re-timing supersedes slot preservation only where it actually ran; keep
  // Part 1's guarantee everywhere else so no unplayed fixture is left outside
  // its own game day, which would wedge the day advance.
  const liveFixtureIds = new Set(world.liveMatches.map((match) => match.fixtureId));
  for (const fixture of world.fixtures) {
    if (fixture.played || fixture.kickoffAt === undefined) continue;
    if (liveFixtureIds.has(fixture.id) || retimed.has(fixture.id)) continue;
    fixture.kickoffAt = realignFixtureKickoff(fixture, seasonStart);
  }
}

/**
 * Shift every real-time anchor in the world forward by `rawShift` and the
 * game-day grid anchors by `gridShift` (a whole multiple of DAY_MS). Pure
 * world mutation (DB column sync happens in the caller's transaction) and
 * exported for unit tests.
 *
 * The shifts are UNCONDITIONAL — including timers that had already expired
 * before the pause. That preserves the relative schedule exactly: the world
 * instant jumps from pausedAt to now, nothing fires retroactively, and no
 * match fast-forwards through catch-up ticks after resume.
 */
export function applyResumeShift(world: World, rawShift: number, gridShift: number): void {
  if (rawShift > 0) {
    for (const auction of world.transferAuctions) {
      if (auction.status !== "ACTIVE") continue;
      auction.deadline += rawShift;
      auction.originalDeadline += rawShift;
      auction.createdAt += rawShift;
    }
    for (const listing of world.freeAgentListings) {
      if (listing.status !== "ACTIVE") continue;
      listing.deadline += rawShift;
      listing.createdAt += rawShift;
      if (listing.unclaimedSince !== undefined) listing.unclaimedSince += rawShift;
    }
    for (const loan of world.loans) {
      if (loan.recalled || loan.toClubId !== null) continue;
      loan.listedAt += rawShift;
      loan.claimableAt += rawShift;
    }

    for (const st of world.liveMatches) {
      st.lastAdvancedAt += rawShift;
      if (st.halftimeStartedAt) st.halftimeStartedAt += rawShift;
    }
    for (const club of world.clubs) {
      if (club.liveMatchAt !== null) club.liveMatchAt += rawShift;
      // Inactivity countdowns freeze along with everything else.
      if (club.lastMeaningfulActivityAt !== null) club.lastMeaningfulActivityAt += rawShift;
      if (club.abandonmentEligibleAt !== null) club.abandonmentEligibleAt += rawShift;
    }
  }

  if (gridShift > 0) {
    // Unplayed fixtures that have NOT kicked off (no live match) move with the
    // game-day grid. A fixture whose match is already live keeps its anchor:
    // its pacing is carried by the live-match state, shifted by rawShift.
    for (const fixture of world.fixtures) {
      if (fixture.played || fixture.kickoffAt === undefined) continue;
      if (world.liveMatches.some((match) => match.fixtureId === fixture.id)) continue;
      fixture.kickoffAt += gridShift;
    }

    // Moving all three together keeps every boundary-derived value aligned:
    // lastAdvancedAt still reads "when the advance physically ran", but the
    // grid (lastBoundaryAt / seasonStartAt) moves by whole days only, so the
    // day-advance trigger never sees a partial boundary.
    if (world.mp.lastAdvancedAt !== null && world.mp.lastAdvancedAt !== undefined) world.mp.lastAdvancedAt += gridShift;
    if (world.mp.seasonStartAt !== null && world.mp.seasonStartAt !== undefined) world.mp.seasonStartAt += gridShift;
    if (world.mp.lastBoundaryAt !== null && world.mp.lastBoundaryAt !== undefined) world.mp.lastBoundaryAt += gridShift;
  }
}

interface PauseResumeOptions {
  adminUserId: number;
  reason?: string;
  /** Admin override: lift a launch hold before the roster completes, leaving
   *  the remaining slots as AI and running the same re-timing. */
  force?: boolean;
}

async function writePauseAudit(prisma: PrismaClient, saveId: number, options: PauseResumeOptions, action: string, before: unknown, after: unknown): Promise<void> {
  await prisma.adminSchedulerAudit.create({
    data: {
      saveId,
      adminUserId: options.adminUserId,
      action,
      targetType: "WORLD_CLOCK",
      targetId: "WORLD",
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      reason: options.reason ?? null,
    },
  });
}

/** Freeze the world clock. Idempotent: pausing an already-paused world keeps the original instant. */
export async function pauseSeason(prisma: PrismaClient, options: PauseResumeOptions): Promise<{ pausedAt: number }> {
  return withGlobalLock(() =>
    withGlobalLease(prisma, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = await loadGlobalWorldMutable(prisma);
        if (!loaded) throw new Error("Global world unavailable");
        const existing = pausedInstant(loaded.world);
        if (existing !== null) return { pausedAt: existing };
        const pausedAt = Date.now();
        loaded.world.mp.pausedAt = pausedAt;
        try {
          await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
          await writePauseAudit(prisma, loaded.save.id, options, "SEASON_PAUSE", { pausedAt: null }, { pausedAt });
          invalidateWorldCache(prisma, loaded.save.id);
          return { pausedAt };
        } catch (error) {
          if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
        }
      }
      throw new Error("Season pause could not be committed");
    })
  );
}

/** Unplayed fixtures whose kickoff changed on resume: fixture row + MATCH_START dueAt. */
export async function syncFixtureKickoffs(tx: PrismaClient, saveId: number, fixtures: World["fixtures"]): Promise<void> {
  for (const fixture of fixtures) {
    if (fixture.played || fixture.kickoffAt === undefined) continue;
    await tx.fixture.updateMany({
      where: { saveId, id: fixture.id },
      data: { kickoffAt: BigInt(fixture.kickoffAt) },
    });
    await tx.scheduledEvent.updateMany({
      where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(fixture.id), status: { in: ["PENDING", "FAILED"] } },
      data: { dueAt: new Date(fixture.kickoffAt), version: { increment: 1 } },
    });
  }
}

/**
 * Re-derive the pending GAME_DAY_ADVANCE row to exactly the next FIRE instant
 * (`nextBoundaryAt`) — excluded from both resume shifts, so it can never carry
 * a raw millisecond delta. Callers must pass the boundary ENDING the current
 * game day (lastBoundaryAt + 24h), never the day's start: the scheduler's
 * final drain executes any due GAME_DAY_ADVANCE row, so a row due at the
 * day's start would fire a day early and fail against unresolved fixtures.
 * When no pending row exists (already consumed), fall back to the same insert
 * the scheduler processor performs.
 */
async function redriveDayAdvance(tx: PrismaClient, saveId: number, nextBoundaryAt: number, absoluteGameDay: number): Promise<void> {
  const updated = await tx.scheduledEvent.updateMany({
    where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: { in: ["PENDING", "FAILED"] } },
    data: { dueAt: new Date(nextBoundaryAt), version: { increment: 1 } },
  });
  if (updated.count === 0) {
    await scheduleEvent(tx as unknown as PrismaClient, {
      saveId,
      type: ScheduledEventType.GAME_DAY_ADVANCE,
      timeBasis: "REAL_TIME",
      dueAt: new Date(nextBoundaryAt),
      priority: 10000,
      payload: { targetAbsoluteGameDay: absoluteGameDay + 1 },
      idempotencyKey: `GAME_DAY_ADVANCE:${absoluteGameDay + 1}`,
    });
  }
}

/**
 * DB-side sync for a launch-hold lift performed OUTSIDE resumeSeason (the
 * join/return paths, which persist the world via persistWorld and only need
 * the scheduled-event and clock rows moved): re-derive the re-timed
 * MATCH_START rows, the pending GAME_DAY_ADVANCE row and the durable clock
 * row. Idempotent — a second call writes the same values.
 */
export async function syncLaunchHoldResumeRows(prisma: PrismaClient, saveId: number, world: World): Promise<void> {
  // The pending advance row points at the next FIRE instant (the boundary
  // ending day 1), not at the anchored day-1 start — see redriveDayAdvance's
  // call site in resumeSeason.
  const advanceDueAt = nextDayBoundaryAfter(world.mp.lastBoundaryAt ?? nextDayBoundaryAfter(Date.now()));
  await syncFixtureKickoffs(prisma, saveId, world.fixtures);
  await redriveDayAdvance(prisma, saveId, advanceDueAt, world.mp.absoluteGameDay ?? world.dayIndex);
  if (world.mp.lastAdvancedAt !== null && world.mp.lastAdvancedAt !== undefined) {
    await prisma.gameClock.updateMany({
      where: { saveId },
      data: {
        lastAdvancedAt: new Date(world.mp.lastAdvancedAt),
        ...(world.mp.lastBoundaryAt !== null && world.mp.lastBoundaryAt !== undefined ? { lastBoundaryAt: new Date(world.mp.lastBoundaryAt) } : {}),
      },
    });
  }
}

/**
 * Lift the pause and shift every real-time anchor (world AND database columns /
 * scheduled events) in one transaction, so a crash can never leave half the
 * timers shifted. Retries recompute from the still-set pausedAt, keeping the
 * operation effectively idempotent until it commits.
 */
export async function resumeSeason(prisma: PrismaClient, options: PauseResumeOptions): Promise<{ resumedAt: number; shiftMs: number; gridShiftMs: number; strandedKickoffs: number; nextBoundary: number }> {
  return withGlobalLock(() =>
    withGlobalLease(prisma, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = await loadGlobalWorldMutable(prisma);
        if (!loaded) throw new Error("Global world unavailable");
        const pausedAt = pausedInstant(loaded.world);
        if (pausedAt === null) throw new Error("The season is not paused");
        // While the roster hold is active, the pause IS the wait — an admin
        // resume would start a season clock before the division is full. The
        // hold releases automatically when the roster completes (join/return
        // routes) or on an explicit force resume below.
        const rosterHeld = loaded.world.mp.awaitingLaunchRoster === true || loaded.world.mp.awaitingFirstHuman === true;
        if (rosterHeld && !options.force) {
          throw new Error("The world is waiting for its full roster; resume happens automatically when the division fills");
        }
        const resumedAt = Date.now();
        const rawShift = Math.max(0, resumedAt - pausedAt);
        const isLaunch = isLaunchHold(loaded.world);
        let gridShift = 0;
        if (isLaunch) {
          // Real-time anchors still freeze for exactly the held interval (a
          // club that joined during the hold, or a pre-pause market deadline,
          // must not expire across it); only the game-day grid takes the
          // launch-hold anchor instead of a day-multiple shift.
          applyResumeShift(loaded.world, rawShift, 0);
          applyLaunchHoldResume(loaded.world, resumedAt);
          // The hold is over — including an early force release with the
          // roster still under-strength (the remaining slots stay AI, and the
          // hold never re-arms).
          loaded.world.mp.awaitingLaunchRoster = false;
          loaded.world.mp.awaitingFirstHuman = false;
        } else {
          loaded.world.mp.lastBoundaryAt ??= dayBoundaryAtOrBefore(loaded.world.mp.lastAdvancedAt ?? resumedAt);
          gridShift = boundariesElapsed(loaded.world.mp.lastBoundaryAt, resumedAt) * DAY_MS;
          applyResumeShift(loaded.world, rawShift, gridShift);
        }
        loaded.world.mp.pausedAt = null;
        const nextBoundary = isLaunch ? (loaded.world.mp.lastBoundaryAt ?? nextDayBoundaryAfter(resumedAt)) : nextDayBoundaryAfter(resumedAt);
        const strandedKickoffs = countStrandedKickoffs(loaded.world, resumedAt);

        try {
          await prisma.$transaction(async (tx) => {
            const client = tx as unknown as PrismaClient;
            // Optimistic concurrency mirrors persistWorld: bump the revision
            // only if nobody else wrote the save meanwhile.
            const claim = await tx.save.updateMany({
              where: { id: loaded.save.id, revision: loaded.save.revision },
              data: { mpStateJson: JSON.stringify(loaded.world.mp), revision: { increment: 1 } },
            });
            if (claim.count !== 1) throw new StaleWorldError(loaded.save.id, loaded.save.revision, -1);

            if (isLaunch) {
              // The season has played nothing: applyLaunchHoldResume re-timed
              // every active division against the current roster, so sync all
              // unplayed kickoffs (and their MATCH_START rows) to the world.
              await syncFixtureKickoffs(client, loaded.save.id, loaded.world.fixtures);
            } else {
              // Grid-shifted fixtures: unplayed, not kicked off. Fixtures with
              // a live match keep their anchor (live pacing shifts by rawShift).
              const gridFixtures = loaded.world.fixtures.filter(
                (fixture) => !fixture.played && fixture.kickoffAt !== undefined && !loaded.world.liveMatches.some((match) => match.fixtureId === fixture.id),
              );
              await syncFixtureKickoffs(client, loaded.save.id, gridFixtures);
            }
            for (const auction of loaded.world.transferAuctions) {
              if (auction.status !== "ACTIVE") continue;
              await tx.transferAuction.updateMany({
                where: { saveId: loaded.save.id, id: auction.id },
                data: { deadline: BigInt(auction.deadline), originalDeadline: BigInt(auction.originalDeadline), createdAt: BigInt(auction.createdAt) },
              });
            }
            for (const listing of loaded.world.freeAgentListings) {
              if (listing.status !== "ACTIVE") continue;
              await tx.freeAgentListing.updateMany({
                where: { saveId: loaded.save.id, id: listing.id },
                data: {
                  deadline: BigInt(listing.deadline),
                  createdAt: BigInt(listing.createdAt),
                  ...(listing.unclaimedSince !== undefined ? { unclaimedSince: BigInt(listing.unclaimedSince) } : {}),
                },
              });
            }
            for (const loan of loaded.world.loans) {
              if (loan.recalled || loan.toClubId !== null) continue;
              await tx.loan.updateMany({
                where: { saveId: loaded.save.id, id: loan.id },
                data: { listedAt: BigInt(loan.listedAt), claimableAt: BigInt(loan.claimableAt) },
              });
            }
            for (const club of loaded.world.clubs) {
              if (club.liveMatchAt === null) continue;
              await tx.club.updateMany({
                where: { saveId: loaded.save.id, id: club.id },
                data: { liveMatchAt: BigInt(club.liveMatchAt) },
              });
            }
            // The inactivity anchors: applyResumeShift moves both, and this is
            // the only place they reach the database (invalidateWorldCache
            // below forces the next load to read these rows back), so without
            // this the shift is silently discarded and a club's abandonment
            // countdown keeps running through the freeze.
            //
            // Written as two set-based increments rather than one UPDATE per
            // club: every non-null anchor moves by exactly the same `rawShift`,
            // and every human club has one, so a per-club loop would add one
            // round-trip per manager to a transaction that already issues one
            // per unplayed fixture and pending event -- all under Prisma's
            // default 5s interactive-transaction timeout.
            // Guarded to match applyResumeShift, which no-ops at shift <= 0:
            // these are the only set-wide writes here, so a zero shift would
            // otherwise rewrite every club row for nothing.
            if (rawShift > 0) {
              const shiftBig = BigInt(rawShift);
              await tx.club.updateMany({
                where: { saveId: loaded.save.id, lastMeaningfulActivityAt: { not: null } },
                data: { lastMeaningfulActivityAt: { increment: shiftBig } },
              });
              await tx.club.updateMany({
                where: { saveId: loaded.save.id, abandonmentEligibleAt: { not: null } },
                data: { abandonmentEligibleAt: { increment: shiftBig } },
              });
            }
            for (const st of loaded.world.liveMatches) {
              await tx.liveMatch.updateMany({
                where: { saveId: loaded.save.id, matchId: st.matchId },
                data: { stateJson: JSON.stringify(st) },
              });
            }

            // REAL_TIME events all move with the freeze — including ones that
            // were already overdue at pause time, so resume never triggers a
            // retroactive catch-up burst. MATCH_START rows move with the
            // game-day grid instead (their dueAt IS fixture.kickoffAt, already
            // re-derived above by syncFixtureKickoffs, so raw-shifting them
            // here would desync the row from the fixture), and the
            // GAME_DAY_ADVANCE row is excluded entirely and re-derived from
            // the boundary.
            const pendingEvents = await tx.scheduledEvent.findMany({
              where: { saveId: loaded.save.id, status: { in: ["PENDING", "FAILED"] }, timeBasis: "REAL_TIME" },
              select: { id: true, dueAt: true, type: true, payloadJson: true },
            });
            for (const event of pendingEvents) {
              if (!event.dueAt) continue;
              if (event.type === ScheduledEventType.GAME_DAY_ADVANCE || event.type === ScheduledEventType.MATCH_START) continue;
              const shiftedDue = (event.dueAt as Date).getTime() + rawShift;
              let payloadJson: string | undefined;
              if (event.type === "MATCH_COMPLETE" || event.type === "AUCTION_END") {
                try {
                  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
                  let touched = false;
                  for (const key of ["completionAt", "deadline"]) {
                    const value = Number(payload[key]);
                    if (Number.isFinite(value)) {
                      payload[key] = value + rawShift;
                      touched = true;
                    }
                  }
                  if (touched) payloadJson = JSON.stringify(payload);
                } catch {
                  // Malformed payloads keep their (shifted) due time only.
                }
              }
              await tx.scheduledEvent.update({
                where: { id: event.id },
                data: {
                  dueAt: new Date(shiftedDue),
                  ...(payloadJson !== undefined ? { payloadJson } : {}),
                  version: { increment: 1 },
                },
              });
            }

            // The pending GAME_DAY_ADVANCE row always points at the next FIRE
            // instant — the boundary ending the current game day — never
            // raw-shifted. Launch: the boundary after the anchored day-1
            // start (seasonBoundary + 24h); maintenance: nextBoundary already
            // is that instant. A row due any earlier would fire a day early
            // through the scheduler's final drain and fail noisily.
            const advanceDueAt = isLaunch
              ? nextDayBoundaryAfter(loaded.world.mp.lastBoundaryAt ?? nextBoundary)
              : nextBoundary;
            await redriveDayAdvance(client, loaded.save.id, advanceDueAt, loaded.world.mp.absoluteGameDay ?? loaded.world.dayIndex);

            // The durable clock row mirrors mp.lastAdvancedAt and
            // mp.lastBoundaryAt (see ensureGameClock).
            if (loaded.world.mp.lastAdvancedAt !== null && loaded.world.mp.lastAdvancedAt !== undefined) {
              await tx.gameClock.updateMany({
                where: { saveId: loaded.save.id },
                data: {
                  lastAdvancedAt: new Date(loaded.world.mp.lastAdvancedAt),
                  ...(loaded.world.mp.lastBoundaryAt !== null && loaded.world.mp.lastBoundaryAt !== undefined ? { lastBoundaryAt: new Date(loaded.world.mp.lastBoundaryAt) } : {}),
                },
              });
            }

            await writePauseAudit(client, loaded.save.id, options, "SEASON_RESUME", { pausedAt }, { resumedAt, shiftMs: rawShift, gridShiftMs: gridShift, strandedKickoffs, nextBoundary });
          });
          invalidateWorldCache(prisma, loaded.save.id);
          return { resumedAt, shiftMs: rawShift, gridShiftMs: gridShift, strandedKickoffs, nextBoundary };
        } catch (error) {
          if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
        }
      }
      throw new Error("Season resume could not be committed");
    })
  );
}
