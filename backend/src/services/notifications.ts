import type { PrismaClient } from "@prisma/client";
import type { Match } from "../game/types";
import { hasPro } from "./pro";
import { publishUserWorldEvent } from "./worldEvents";

export async function createNotification(prisma: PrismaClient, userId: number, type: string, payload: unknown): Promise<void> {
  try {
    await prisma.userNotification.create({ data: { userId, type, payloadJson: JSON.stringify(payload ?? {}) } });
    publishUserWorldEvent(userId, { type: "invalidate", scope: "notifications" });
  } catch (err) {
    // Only swallow known transient/duplicate errors; log programming errors
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Unique constraint|P2002|already exists/i.test(msg)) console.error("[notifications] create failed", err);
  }
}

/** Notify both participants that their match started (everyone). */
export async function notifyMatchStarted(prisma: PrismaClient, world: import("../game/types").World, fixtureId: number): Promise<void> {
  const fixture = world.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return;
  const home = world.clubs.find((c) => c.id === fixture.homeClubId);
  const away = world.clubs.find((c) => c.id === fixture.awayClubId);
  const comp = world.competitions.find((c) => c.id === fixture.competitionId);
  const payloadBase = { fixtureId, homeClubId: fixture.homeClubId, awayClubId: fixture.awayClubId, competitionName: comp?.name ?? null, kickoffAt: fixture.kickoffAt ?? null };
  for (const club of [home, away]) {
    if (!club?.ownerUserId) continue;
    await createNotification(prisma, club.ownerUserId, "MATCH_STARTED", { ...payloadBase, clubId: club.id, opponentClubId: club.id === home?.id ? away?.id : home?.id });
  }
}

/** Notify both participants that match finished (everyone) + league results digest for pro. */
export async function notifyMatchFinished(prisma: PrismaClient, world: import("../game/types").World, match: Match): Promise<void> {
  const home = world.clubs.find((c) => c.id === match.homeClubId);
  const away = world.clubs.find((c) => c.id === match.awayClubId);
  const payloadBase = { matchId: match.id, fixtureId: match.fixtureId, homeClubId: match.homeClubId, awayClubId: match.awayClubId, homeScore: match.homeScore, awayScore: match.awayScore };
  for (const club of [home, away]) {
    if (!club?.ownerUserId) continue;
    await createNotification(prisma, club.ownerUserId, "MATCH_FINISHED", { ...payloadBase, clubId: club.id });
  }
  // League results for pro viewers: after a division round completes, we could fan-out to all clubs in division.
  // Minimal v1: if both clubs have pro, they also get MATCH_GOAL detail via separate helper during live ticks; league digest deferred.
}

/**
 * Pro-only: goal events while live (called when a new goal appears).
 * A goal scored in the tick that finishes the match is detected after
 * finalizeLiveMatch has detached the live state, so participant clubs and the
 * score payload fall back to the persisted Match record.
 */
export async function notifyMatchGoal(prisma: PrismaClient, world: import("../game/types").World, matchId: number, scoringClubId: number, minute: number): Promise<void> {
  const st = world.liveMatches.find((m) => m.matchId === matchId);
  const finishedMatch = st ? undefined : world.matches.find((m) => m.id === matchId);
  const homeClubId = st?.homeClubId ?? finishedMatch?.homeClubId;
  const awayClubId = st?.awayClubId ?? finishedMatch?.awayClubId;
  if (homeClubId === undefined || awayClubId === undefined) return;
  const scores = st?.scores ?? (finishedMatch ? [finishedMatch.homeScore, finishedMatch.awayScore] as [number, number] : undefined);
  if (!scores) return;
  const fixtureId = st?.fixtureId ?? finishedMatch?.fixtureId ?? null;
  for (const clubId of [homeClubId, awayClubId]) {
    const club = world.clubs.find((c) => c.id === clubId);
    if (!club?.ownerUserId) continue;
    const user = await prisma.user.findUnique({ where: { id: club.ownerUserId } });
    if (!user || !hasPro(user)) continue;
    await createNotification(prisma, club.ownerUserId, "MATCH_GOAL", { matchId, fixtureId, scoringClubId, minute, scores });
  }
}
