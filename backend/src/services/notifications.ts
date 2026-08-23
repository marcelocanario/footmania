import type { PrismaClient } from "@prisma/client";
import type { Match } from "../game/types";
import { hasPro } from "./pro";
import { publishUserWorldEvent } from "./worldEvents";
import { MP_CONFIG } from "../config";

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

/**
 * Stable identity for match inbox events. Match notifications can be emitted
 * by either the durable scheduler or the live-match worker, and a retry may
 * reach the notification code after the match state was already persisted.
 *
 * The identity is stored in UserNotification.dedupeKey and enforced by a
 * database unique constraint; deriving it here also lets the API hide legacy
 * duplicate rows created before that constraint existed.
 */
export function matchNotificationKey(type: string, payload: unknown): string | null {
  const p = payloadRecord(payload);
  const number = (key: string): number | null => typeof p[key] === "number" ? p[key] as number : null;
  if (type === "MATCH_STARTED") {
    const fixtureId = number("fixtureId");
    return fixtureId === null ? null : `MATCH_STARTED:${fixtureId}`;
  }
  if (type === "MATCH_FINISHED") {
    const matchId = number("matchId");
    return matchId === null ? null : `MATCH_FINISHED:${matchId}`;
  }
  if (type === "MATCH_GOAL") {
    const matchId = number("matchId");
    const scoringClubId = number("scoringClubId");
    const minute = number("minute");
    const scores = Array.isArray(p.scores) && p.scores.length >= 2
      && typeof p.scores[0] === "number" && typeof p.scores[1] === "number"
      ? `${p.scores[0]}-${p.scores[1]}`
      : null;
    if (matchId === null || scoringClubId === null || minute === null || scores === null) return null;
    // Scores distinguish two goals by the same club in the same minute.
    return `MATCH_GOAL:${matchId}:${scoringClubId}:${minute}:${scores}`;
  }
  return null;
}

export async function createNotification(prisma: PrismaClient, userId: number, type: string, payload: unknown): Promise<void> {
  return createNotificationWithOptions(prisma, userId, type, payload);
}

interface NotificationOptions {
  dedupeKey?: string;
  occurredAt?: Date;
}

async function createNotificationWithOptions(prisma: PrismaClient, userId: number, type: string, payload: unknown, options: NotificationOptions = {}): Promise<void> {
  try {
    await prisma.userNotification.create({
      data: {
        userId,
        type,
        payloadJson: JSON.stringify(payload ?? {}),
        dedupeKey: options.dedupeKey ?? null,
        occurredAt: options.occurredAt ?? new Date(),
      },
    });
    publishUserWorldEvent(userId, { type: "invalidate", scope: "notifications" });
  } catch (err) {
    // Only swallow known transient/duplicate errors; log programming errors
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Unique constraint|P2002|already exists/i.test(msg)) console.error("[notifications] create failed", err);
  }
}

/** Create a match notification only once for a user and event identity. */
export async function createMatchNotification(prisma: PrismaClient, userId: number, type: string, payload: unknown, occurredAt = new Date()): Promise<void> {
  try {
    const key = matchNotificationKey(type, payload);
    await createNotificationWithOptions(prisma, userId, type, payload, { dedupeKey: key ?? undefined, occurredAt });
  } catch (err) {
    // Inbox delivery is best effort and must not fail match persistence.
    console.error("[notifications] match notification failed", err);
  }
}

/** Notify both participants that their match started (everyone). */
export async function notifyMatchStarted(prisma: PrismaClient, world: import("../game/types").World, fixtureId: number, occurredAt?: Date): Promise<void> {
  const fixture = world.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return;
  const home = world.clubs.find((c) => c.id === fixture.homeClubId);
  const away = world.clubs.find((c) => c.id === fixture.awayClubId);
  const comp = world.competitions.find((c) => c.id === fixture.competitionId);
  // Human-readable club names ride along so clients can show friendly copy
  // without resolving club IDs themselves.
  const payloadBase = {
    fixtureId,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    homeName: home?.name ?? null,
    awayName: away?.name ?? null,
    competitionName: comp?.name ?? null,
    kickoffAt: fixture.kickoffAt ?? null,
  };
  const eventOccurredAt = occurredAt ?? (fixture.kickoffAt === undefined ? new Date() : new Date(fixture.kickoffAt));
  for (const club of [home, away]) {
    if (!club?.ownerUserId) continue;
    await createMatchNotification(prisma, club.ownerUserId, "MATCH_STARTED", { ...payloadBase, clubId: club.id, opponentClubId: club.id === home?.id ? away?.id : home?.id }, eventOccurredAt);
  }
}

/** Notify both participants that match finished (everyone) + league results digest for pro. */
export async function notifyMatchFinished(prisma: PrismaClient, world: import("../game/types").World, match: Match, occurredAt = new Date()): Promise<void> {
  const home = world.clubs.find((c) => c.id === match.homeClubId);
  const away = world.clubs.find((c) => c.id === match.awayClubId);
  const payloadBase = {
    matchId: match.id,
    fixtureId: match.fixtureId,
    homeClubId: match.homeClubId,
    awayClubId: match.awayClubId,
    homeName: home?.name ?? null,
    awayName: away?.name ?? null,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
  };
  for (const club of [home, away]) {
    if (!club?.ownerUserId) continue;
    await createMatchNotification(prisma, club.ownerUserId, "MATCH_FINISHED", { ...payloadBase, clubId: club.id }, occurredAt);
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
export async function notifyMatchGoal(prisma: PrismaClient, world: import("../game/types").World, matchId: number, scoringClubId: number, minute: number, occurredAt?: Date): Promise<void> {
  const st = world.liveMatches.find((m) => m.matchId === matchId);
  const finishedMatch = st ? undefined : world.matches.find((m) => m.id === matchId);
  const homeClubId = st?.homeClubId ?? finishedMatch?.homeClubId;
  const awayClubId = st?.awayClubId ?? finishedMatch?.awayClubId;
  if (homeClubId === undefined || awayClubId === undefined) return;
  const scores = st?.scores ?? (finishedMatch ? [finishedMatch.homeScore, finishedMatch.awayScore] as [number, number] : undefined);
  if (!scores) return;
  const fixtureId = st?.fixtureId ?? finishedMatch?.fixtureId ?? null;
  const fixture = fixtureId === null ? undefined : world.fixtures.find((candidate) => candidate.id === fixtureId);
  const goalOccurredAt = occurredAt ?? (fixture?.kickoffAt === undefined
    ? new Date()
    : new Date(fixture.kickoffAt + Math.max(0, minute) / 90 * MP_CONFIG.matchDurationMinutes * 60 * 1000));
  const homeName = world.clubs.find((c) => c.id === homeClubId)?.name ?? null;
  const awayName = world.clubs.find((c) => c.id === awayClubId)?.name ?? null;
  const scoringName = world.clubs.find((c) => c.id === scoringClubId)?.name ?? null;
  for (const clubId of [homeClubId, awayClubId]) {
    const club = world.clubs.find((c) => c.id === clubId);
    if (!club?.ownerUserId) continue;
    const user = await prisma.user.findUnique({ where: { id: club.ownerUserId } });
    if (!user || !hasPro(user)) continue;
    await createMatchNotification(prisma, club.ownerUserId, "MATCH_GOAL", { matchId, fixtureId, scoringClubId, minute, scores, scoringName, homeName, awayName }, goalOccurredAt);
  }
}
