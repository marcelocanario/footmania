#!/usr/bin/env tsx
/**
 * Diagnose "Cannot advance while a scheduled match is unresolved".
 *
 * Loads the global world and prints every fixture that blocks gameClock advance:
 *   - fixtures for current seasonDayIndex that are !played && !ended liveMatch
 *   - their kickoffAt, scheduledSeasonDayIndex, live state, completion timing
 *
 * Usage:
 *   npx tsx scripts/diagnose-unresolved.ts
 *   npx tsx scripts/diagnose-unresolved.ts --json
 */
import { PrismaClient } from "@prisma/client";
import { loadGlobalWorldMutable } from "../src/services/saveService";
import { calendarValues, roundDayIndex } from "../src/services/seasonCalendar";
import { gameConfig } from "../src/config";

const prisma = new PrismaClient();

async function main() {
  const loaded = await loadGlobalWorldMutable(prisma);
  if (!loaded) {
    console.error("Global world unavailable");
    process.exit(1);
  }
  const world = loaded.world;
  const currentIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
  const seasonStartAt = world.mp.seasonStartAt ? new Date(world.mp.seasonStartAt).toISOString() : "null";
  const lastAdvancedAt = world.mp.lastAdvancedAt ? new Date(world.mp.lastAdvancedAt).toISOString() : "null";
  const nowIso = new Date().toISOString();

  const calendar = calendarValues();
  console.log("=== World Clock ===");
  console.log(`absoluteGameDay: ${currentAbsolute}  seasonDayIndex: ${currentIndex}  seasonId: ${world.mp.seasonId} seasonNumber: ${world.mp.seasonNumber}`);
  console.log(`phase: ${world.mp.phase}  seasonStartAt: ${seasonStartAt}  lastAdvancedAt: ${lastAdvancedAt}  now: ${nowIso}`);
  console.log(`startAbsolute: ${world.mp.startAbsoluteGameDay}  clockVersion: ${world.mp.clockVersion}`);
  console.log(`seasonDays: ${calendar.seasonDays} lastLeagueMatchDayIndex: ${calendar.lastLeagueMatchDayIndex} interseasonStart: ${calendar.interseasonStartIndex}`);

  const dayFixtures = world.fixtures.filter((f) => f.scheduledSeasonDayIndex === currentIndex || (f.scheduledSeasonDayIndex === undefined && f.dayIndex === currentIndex));
  console.log(`\n=== Fixtures for currentIndex ${currentIndex} ===`);
  console.log(`Count: ${dayFixtures.length} (total fixtures: ${world.fixtures.length})`);
  for (const f of dayFixtures) {
    const live = world.liveMatches.find((m) => m.fixtureId === f.id);
    const kickoffIso = f.kickoffAt ? new Date(f.kickoffAt).toISOString() : "none";
    const msUntil = f.kickoffAt ? f.kickoffAt - Date.now() : null;
    const msSince = f.kickoffAt ? Date.now() - f.kickoffAt : null;
    console.log(`  fixture ${f.id} comp ${f.competitionId} round ${f.round} ${f.homeClubId} vs ${f.awayClubId} dayIndex=${f.dayIndex} scheduled=${f.scheduledSeasonDayIndex} kickoff=${kickoffIso} played=${f.played} live=${live ? `matchId ${live.matchId} ended=${live.ended} minute=${live.minute} half=${live.half} period=${live.period} clockSec=${live.matchClockSeconds} lastAdv=${live.lastAdvancedAt ? new Date(live.lastAdvancedAt).toISOString() : "null"}` : "none"} msUntil=${msUntil} msSince=${msSince}`);
  }

  const unresolved = dayFixtures.filter((f) => !f.played && !world.liveMatches.some((m) => m.fixtureId === f.id && m.ended));
  console.log(`\n=== Unresolved (${unresolved.length}) ===`);
  if (unresolved.length === 0) {
    console.log("No unresolved fixtures — gameClock would advance successfully.");
  } else {
    for (const f of unresolved) {
      const live = world.liveMatches.find((m) => m.fixtureId === f.id);
      const kickoffIso = f.kickoffAt ? new Date(f.kickoffAt).toISOString() : "none";
      const comp = world.competitions.find((c) => c.id === f.competitionId);
      const msUntil = f.kickoffAt ? f.kickoffAt - Date.now() : null;
      console.log(`  BLOCKED fixture ${f.id} round ${f.round} comp ${comp?.name ?? f.competitionId} tier=${comp?.tier} kickoff=${kickoffIso} played=${f.played}`);
      if (f.kickoffAt && f.kickoffAt > Date.now()) {
        console.log(`     -> kickoff is FUTURE (${Math.round((f.kickoffAt - Date.now())/60000)} min from now) — MATCH_START not yet due`);
        const event = await prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: "MATCH_START", entityId: String(f.id) }, select: { status: true, dueAt: true, lastError: true, attempts: true } });
        console.log(`     -> ScheduledEvent MATCH_START: ${event ? JSON.stringify({ status: event.status, dueAt: event.dueAt?.toISOString(), attempts: event.attempts, lastError: event.lastError }) : "MISSING (not materialized?)"}`);
      } else if (live) {
        console.log(`     -> liveMatch ${live.matchId} minute=${live.minute} half=${live.half} ended=${live.ended} matchClock=${live.matchClockSeconds}s lastAdvancedAt=${live.lastAdvancedAt ? new Date(live.lastAdvancedAt).toISOString() : "null"}`);
        console.log(`        halftimeStartedAt=${live.halftimeStartedAt ? new Date(live.halftimeStartedAt).toISOString() : "null"} halftimeReady=${JSON.stringify(live.halftimeReady)}`);
        const event = await prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: "MATCH_COMPLETE", entityId: String(f.id) }, select: { status: true, dueAt: true, lastError: true, attempts: true } });
        console.log(`     -> ScheduledEvent MATCH_COMPLETE: ${event ? JSON.stringify({ status: event.status, dueAt: event.dueAt?.toISOString(), attempts: event.attempts, lastError: event.lastError }) : "MISSING"}`);
        const elapsed = live.lastAdvancedAt ? Date.now() - live.lastAdvancedAt : null;
        console.log(`        elapsedSinceLastTick=${elapsed !== null ? Math.round(elapsed/1000) + "s" : "unknown"} isHalftime=${live.half === 0 && live.minute >= live.firstHalfLen ? "maybe" : "no"}`);
      } else {
        console.log(`     -> NO liveMatch and kickoff is PAST — MATCH_START likely FAILED`);
        const event = await prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: "MATCH_START", entityId: String(f.id) }, select: { status: true, dueAt: true, lastError: true, attempts: true, maxAttempts: true } });
        console.log(`     -> ScheduledEvent MATCH_START: ${event ? JSON.stringify({ status: event.status, dueAt: event.dueAt?.toISOString(), attempts: event.attempts, maxAttempts: event.maxAttempts, lastError: event.lastError }) : "MISSING"}`);
      }
      // Check round vs game day mapping
      const expectedDay = comp ? roundDayIndex(f.round) : null;
      console.log(`     -> scheduledSeasonDayIndex=${f.scheduledSeasonDayIndex} dayIndex=${f.dayIndex} expectedDayForRound=${expectedDay} round=${f.round}`);
    }
  }

  console.log(`\n=== Live Matches (total ${world.liveMatches.length}) ===`);
  for (const lm of world.liveMatches) {
    const fixture = world.fixtures.find((f) => f.id === lm.fixtureId);
    console.log(`  live matchId ${lm.matchId} fixture ${lm.fixtureId} (round ${fixture?.round} comp ${fixture?.competitionId}) ${lm.homeClubId} vs ${lm.awayClubId} minute=${lm.minute} half=${lm.half} ended=${lm.ended} clock=${lm.matchClockSeconds}s lastAdv=${lm.lastAdvancedAt ? new Date(lm.lastAdvancedAt).toISOString() : "null"}`);
  }

  console.log(`\n=== ScheduledEvents (pending/failed) ===`);
  const pending = await prisma.scheduledEvent.findMany({ where: { saveId: loaded.save.id, status: { in: ["PENDING", "FAILED", "RUNNING"] } }, orderBy: [{ dueAt: "asc" }, { dueAbsoluteGameDay: "asc" }], take: 20 });
  for (const ev of pending) {
    console.log(`  ${ev.type} status=${ev.status} dueAt=${ev.dueAt?.toISOString() ?? "null"} dueGameDay=${ev.dueAbsoluteGameDay ?? "null"} entity=${ev.entityType}:${ev.entityId} attempts=${ev.attempts}/${ev.maxAttempts} err=${ev.lastError ?? ""}`);
  }

  console.log(`\n=== GameClock row ===`);
  const clockRow = await prisma.gameClock.findUnique({ where: { saveId: loaded.save.id } });
  console.log(clockRow ? JSON.stringify({ absoluteGameDay: clockRow.absoluteGameDay, seasonDayIndex: clockRow.seasonDayIndex, lastAdvancedAt: clockRow.lastAdvancedAt.toISOString(), version: clockRow.version }, null, 2) : "none");

  if (process.argv.includes("--json")) {
    console.log("\n=== JSON dump ===");
    console.log(JSON.stringify({
      currentIndex,
      currentAbsolute,
      seasonStartAt,
      lastAdvancedAt,
      now: nowIso,
      unresolved: unresolved.map((f) => ({
        id: f.id,
        competitionId: f.competitionId,
        round: f.round,
        homeClubId: f.homeClubId,
        awayClubId: f.awayClubId,
        dayIndex: f.dayIndex,
        scheduledSeasonDayIndex: f.scheduledSeasonDayIndex,
        kickoffAt: f.kickoffAt,
        kickoffIso: f.kickoffAt ? new Date(f.kickoffAt).toISOString() : null,
        played: f.played,
        live: world.liveMatches.find((m) => m.fixtureId === f.id) ?? null,
      })),
    }, null, 2));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
