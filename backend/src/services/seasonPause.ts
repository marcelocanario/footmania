import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { invalidateWorldCache, loadGlobalWorldMutable, persistWorld, StaleWorldError } from "./saveService";
import { withGlobalLease, withGlobalLock } from "./lock";

/**
 * Admin season pause ("freeze timers" semantics, INVARIANTS-preserving).
 *
 * While `world.mp.pausedAt` is set, that instant IS the authoritative world
 * clock: worker jobs (scheduler + live matches), automatic day advancement and
 * schedule-dependent user mutations are gated. Nothing advances and nothing
 * expires during the freeze — there is deliberately NO catch-up.
 *
 * Resume shifts every real-time anchor forward by exactly the frozen interval
 * (now - pausedAt):
 *  - pending/failed REAL_TIME ScheduledEvent.dueAt (+ embedded payload stamps),
 *  - unplayed fixture kickoffs,
 *  - active auction / free-agent / loan market timers,
 *  - live-match pacing + halftime anchors and club.liveMatchAt,
 *  - mp.lastAdvancedAt / seasonStartAt and inactivity anchors,
 *  - GameClock.lastAdvancedAt.
 *
 * Day counters never move, so resuming can never fast-forward game days, and
 * boundary detection sees zero missed rollovers because lastAdvancedAt moves
 * with the same shift as the pending GAME_DAY_ADVANCE event.
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
 * Shift every real-time anchor in the world forward by `shift`. Pure world
 * mutation (DB column sync happens in the caller's transaction) and exported
 * for unit tests.
 *
 * The shift is UNCONDITIONAL — including timers that had already expired before
 * the pause. That preserves the relative schedule exactly: the world instant
 * jumps from pausedAt to now, nothing fires retroactively, and no match
 * fast-forwards through catch-up ticks after resume.
 */
export function applyResumeShift(world: World, shift: number): void {
  if (shift <= 0) return;

  for (const fixture of world.fixtures) {
    if (!fixture.played && fixture.kickoffAt !== undefined) {
      fixture.kickoffAt += shift;
    }
  }

  for (const auction of world.transferAuctions) {
    if (auction.status !== "ACTIVE") continue;
    auction.deadline += shift;
    auction.originalDeadline += shift;
    auction.createdAt += shift;
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE") continue;
    listing.deadline += shift;
    listing.createdAt += shift;
    if (listing.unclaimedSince !== undefined) listing.unclaimedSince += shift;
  }
  for (const loan of world.loans) {
    if (loan.recalled || loan.toClubId !== null) continue;
    loan.listedAt += shift;
    loan.claimableAt += shift;
  }

  for (const st of world.liveMatches) {
    st.lastAdvancedAt += shift;
    if (st.halftimeStartedAt) st.halftimeStartedAt += shift;
  }
  for (const club of world.clubs) {
    if (club.liveMatchAt !== null) club.liveMatchAt += shift;
    // Inactivity countdowns freeze along with everything else.
    if (club.lastMeaningfulActivityAt !== null) club.lastMeaningfulActivityAt += shift;
    if (club.abandonmentEligibleAt !== null) club.abandonmentEligibleAt += shift;
  }

  // Moving both together keeps missed-rollover boundary detection at zero and
  // preserves the round-day <-> kickoff mapping derived from seasonStartAt.
  if (world.mp.lastAdvancedAt !== null && world.mp.lastAdvancedAt !== undefined) world.mp.lastAdvancedAt += shift;
  if (world.mp.seasonStartAt !== null && world.mp.seasonStartAt !== undefined) world.mp.seasonStartAt += shift;
}

interface PauseResumeOptions {
  adminUserId: number;
  reason?: string;
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

/**
 * Lift the pause and shift every real-time anchor (world AND database columns /
 * scheduled events) in one transaction, so a crash can never leave half the
 * timers shifted. Retries recompute from the still-set pausedAt, keeping the
 * operation effectively idempotent until it commits.
 */
export async function resumeSeason(prisma: PrismaClient, options: PauseResumeOptions): Promise<{ resumedAt: number; shiftMs: number }> {
  return withGlobalLock(() =>
    withGlobalLease(prisma, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = await loadGlobalWorldMutable(prisma);
        if (!loaded) throw new Error("Global world unavailable");
        const pausedAt = pausedInstant(loaded.world);
        if (pausedAt === null) throw new Error("The season is not paused");
        const resumedAt = Date.now();
        const shift = Math.max(0, resumedAt - pausedAt);

        applyResumeShift(loaded.world, shift);
        loaded.world.mp.pausedAt = null;

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

            // Sync denormalized real-time columns the full-world persist would
            // normally rewrite.
            for (const fixture of loaded.world.fixtures) {
              if (fixture.played || fixture.kickoffAt === undefined) continue;
              await tx.fixture.updateMany({
                where: { saveId: loaded.save.id, id: fixture.id },
                data: { kickoffAt: BigInt(fixture.kickoffAt) },
              });
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
            for (const st of loaded.world.liveMatches) {
              await tx.liveMatch.updateMany({
                where: { saveId: loaded.save.id, matchId: st.matchId },
                data: { stateJson: JSON.stringify(st) },
              });
            }

            // REAL_TIME events all move with the freeze — including ones that
            // were already overdue at pause time, so resume never triggers a
            // retroactive catch-up burst.
            const pendingEvents = await tx.scheduledEvent.findMany({
              where: { saveId: loaded.save.id, status: { in: ["PENDING", "FAILED"] }, timeBasis: "REAL_TIME" },
              select: { id: true, dueAt: true, type: true, payloadJson: true },
            });
            for (const event of pendingEvents) {
              if (!event.dueAt) continue;
              const shiftedDue = (event.dueAt as Date).getTime() + shift;
              let payloadJson: string | undefined;
              if (event.type === "MATCH_COMPLETE" || event.type === "AUCTION_END") {
                try {
                  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
                  let touched = false;
                  for (const key of ["completionAt", "deadline"]) {
                    const value = Number(payload[key]);
                    if (Number.isFinite(value)) {
                      payload[key] = value + shift;
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

            // The durable clock row mirrors mp.lastAdvancedAt (see ensureGameClock).
            if (loaded.world.mp.lastAdvancedAt !== null && loaded.world.mp.lastAdvancedAt !== undefined) {
              await tx.gameClock.updateMany({
                where: { saveId: loaded.save.id },
                data: { lastAdvancedAt: new Date(loaded.world.mp.lastAdvancedAt) },
              });
            }

            await writePauseAudit(client, loaded.save.id, options, "SEASON_RESUME", { pausedAt }, { resumedAt, shiftMs: shift });
          });
          invalidateWorldCache(prisma, loaded.save.id);
          return { resumedAt, shiftMs: shift };
        } catch (error) {
          if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
        }
      }
      throw new Error("Season resume could not be committed");
    })
  );
}
