import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { ensureCurrentSeason } from "../src/services/mpService";
import { ensureGlobalSave, loadGlobalWorld, persistWorld } from "../src/services/saveService";
import { schedulerProcessor } from "../src/services/jobs/schedulerProcessor";
import { createTestSessionCookie } from "./testAuth";

async function registerAndLogin(app: Awaited<ReturnType<typeof buildServer>>, username: string): Promise<string> {
  return (await createTestSessionCookie(app, { name: username, email: `${username}@test.dev` })).cookie;
}

async function joinClub(app: Awaited<ReturnType<typeof buildServer>>, cookie: string, name: string) {
  const join = await app.inject({
    method: "POST",
    url: "/api/mp/join",
    headers: { cookie },
    payload: {
      clubName: name,
      country: "BRA",
      stadiumName: `${name} Arena`,
      coachName: `${name} Coach`,
      preferredHours: Array.from({ length: 16 }, (_, i) => i),
    },
  });
  expect(join.statusCode).toBe(200);
}

describe("admin world controls (season pause / fixture recalculation / world reset)", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it("freezes workers and schedule-dependent mutations while paused, then shifts every timer on resume", async () => {
    await app.ready();
    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);

    // A brand-new world has never advanced; anchor the clock so the resume
    // shift has a real value to move.
    const seeded = await loadGlobalWorld(app.prisma);
    if (!seeded) throw new Error("world did not load");
    if (seeded.world.mp.lastAdvancedAt == null) {
      seeded.world.mp.lastAdvancedAt = Date.now();
      await persistWorld(app.prisma, seeded.save.id, seeded.save.id, seeded.world, seeded.save.revision);
    }

    const adminCookie = await registerAndLogin(app, "pauseadmin");
    await app.prisma.user.update({ where: { email: "pauseadmin@test.dev" }, data: { isAdmin: true } });
    const userCookie = await registerAndLogin(app, "paususer");
    await joinClub(app, userCookie, "Pause United");

    // Non-admins are rejected before anything happens.
    const forbidden = await app.inject({ method: "POST", url: "/api/admin/scheduler/pause", headers: { cookie: userCookie }, payload: {} });
    expect(forbidden.statusCode).toBe(403);

    const worldBefore = await loadGlobalWorld(app.prisma);
    if (!worldBefore) throw new Error("world did not load");
    const kickoffBefore = worldBefore.world.fixtures.find((f) => !f.played && f.kickoffAt !== undefined)?.kickoffAt;
    expect(kickoffBefore).toBeDefined();
    const dueEvent = await scheduleEvent(app.prisma, {
      saveId: worldBefore.save.id,
      type: ScheduledEventType.AUCTION_END,
      timeBasis: "REAL_TIME",
      dueAt: new Date(Date.now() - 1000),
      entityType: "AUCTION",
      entityId: "1",
      payload: { auctionId: 1, deadlineVersion: 0 },
      idempotencyKey: "AUCTION_END:pausetest:0",
    });

    // Pause the season.
    const paused = await app.inject({ method: "POST", url: "/api/admin/scheduler/pause", headers: { cookie: adminCookie }, payload: { reason: "maintenance window" } });
    expect(paused.statusCode).toBe(200);
    const pausedAt = paused.json().pausedAt as number;

    const clockWhilePaused = await app.inject({ method: "GET", url: "/api/admin/scheduler/clock", headers: { cookie: adminCookie } });
    expect(clockWhilePaused.json().clock).toMatchObject({ paused: true });
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: userCookie } });
    expect(status.json().paused).toBe(true);

    // The durable scheduler must not execute anything while frozen.
    const processed = await schedulerProcessor({ prisma: app.prisma });
    expect(processed.changed).toBe(false);
    expect((await app.prisma.scheduledEvent.findUniqueOrThrow({ where: { id: dueEvent.id } })).status).toBe("PENDING");

    // Schedule-dependent mutations are blocked with 409...
    const player = await app.prisma.player.findFirstOrThrow({ where: { saveId: worldBefore.save.id, clubId: { not: null } }, select: { id: true } });
    const release = await app.inject({ method: "POST", url: `/api/players/${player.id}/release`, headers: { cookie: userCookie } });
    expect(release.statusCode).toBe(409);
    const contract = await app.inject({ method: "POST", url: `/api/players/${player.id}/contract`, headers: { cookie: userCookie }, payload: { length: 2 } });
    expect(contract.statusCode).toBe(409);

    // ...while setup mutations stay available.
    const tactics = await app.inject({ method: "POST", url: "/api/club/tactics", headers: { cookie: userCookie }, payload: { style: 1, pressing: 1, direction: 0 } });
    expect(tactics.statusCode).toBe(200);

    // Admin day controls refuse to run against a frozen clock.
    const advance = await app.inject({ method: "POST", url: "/api/admin/scheduler/day/advance", headers: { cookie: adminCookie }, payload: {} });
    expect(advance.statusCode).toBe(409);
    const scan = await app.inject({ method: "POST", url: "/api/admin/scheduler/scan", headers: { cookie: adminCookie } });
    expect(scan.statusCode).toBe(409);

    // Resume shifts real-time anchors by the frozen interval.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resumed = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: {} });
    expect(resumed.statusCode).toBe(200);
    const shiftMs = resumed.json().shiftMs as number;
    expect(shiftMs).toBeGreaterThanOrEqual(30);

    const eventAfter = await app.prisma.scheduledEvent.findUniqueOrThrow({ where: { id: dueEvent.id } });
    expect(eventAfter.dueAt!.getTime()).toBe(new Date(dueEvent.dueAt!).getTime() + shiftMs);
    const worldAfter = await loadGlobalWorld(app.prisma);
    if (!worldAfter) throw new Error("world did not load after resume");
    expect(worldAfter.world.mp.pausedAt ?? null).toBeNull();
    expect(worldAfter.world.mp.lastAdvancedAt).toBe((worldBefore.world.mp.lastAdvancedAt as number) + shiftMs);
    const kickoffAfter = worldAfter.world.fixtures.find((f) => f.id === worldBefore.world.fixtures.find((x) => !x.played && x.kickoffAt !== undefined)!.id);
    expect(kickoffAfter?.kickoffAt).toBe(kickoffBefore! + shiftMs);
    const clockRow = await app.prisma.gameClock.findFirstOrThrow({ where: { saveId: worldAfter.save.id } });
    expect(clockRow.lastAdvancedAt.getTime()).toBe(worldAfter.world.mp.lastAdvancedAt);

    const statusAfter = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: userCookie } });
    expect(statusAfter.json().paused).toBe(false);

    // Resuming again is rejected cleanly.
    const doubleResume = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: {} });
    expect(doubleResume.statusCode).toBe(400);
  });

  it("recalculates pre-season schedules and refuses once a match exists", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "recalcadmin");
    await app.prisma.user.update({ where: { email: "recalcadmin@test.dev" }, data: { isAdmin: true } });

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("world did not load");
    const saveId = loaded.save.id;
    const divisionIds = loaded.world.competitions.filter((c) => c.kind === "division" && c.seasonId === loaded.world.mp.seasonId).map((c) => c.id);
    const fixturesBefore = await app.prisma.fixture.count({ where: { saveId, competitionId: { in: divisionIds } } });
    expect(fixturesBefore).toBeGreaterThan(0);

    const shortReason = await app.inject({ method: "POST", url: "/api/admin/scheduler/fixtures/recalculate", headers: { cookie: adminCookie }, payload: { reason: "short" } });
    expect(shortReason.statusCode).toBe(400);

    const recalculated = await app.inject({ method: "POST", url: "/api/admin/scheduler/fixtures/recalculate", headers: { cookie: adminCookie }, payload: { reason: "regenerate kickoff windows before round one" } });
    expect(recalculated.statusCode).toBe(200);
    expect(recalculated.json()).toMatchObject({ ok: true, divisions: divisionIds.length, fixturesBefore, fixturesAfter: fixturesBefore });

    // Old MATCH_START events were cancelled and fresh ones materialized.
    const cancelledOld = await app.prisma.scheduledEvent.count({ where: { saveId, type: ScheduledEventType.MATCH_START, status: "CANCELLED" } });
    const pendingNew = await app.prisma.scheduledEvent.count({ where: { saveId, type: ScheduledEventType.MATCH_START, status: "PENDING" } });
    expect(pendingNew).toBe(fixturesBefore);
    expect(cancelledOld).toBeGreaterThan(0);

    // Immutability guard: a single played fixture locks the schedule.
    const victim = await app.prisma.fixture.findFirstOrThrow({ where: { saveId, competitionId: { in: divisionIds } }, select: { id: true } });
    await app.prisma.fixture.update({ where: { saveId_id: { saveId, id: victim.id } }, data: { played: true } });
    const blocked = await app.inject({ method: "POST", url: "/api/admin/scheduler/fixtures/recalculate", headers: { cookie: adminCookie }, payload: { reason: "must be refused after results exist" } });
    expect(blocked.statusCode).toBe(409);
  });

  it("resets the world while preserving accounts, sessions and settings", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "resetadmin");
    await app.prisma.user.update({ where: { email: "resetadmin@test.dev" }, data: { isAdmin: true } });
    const playerCookie = await registerAndLogin(app, "resetplayer");
    await joinClub(app, playerCookie, "Reset City");

    await ensureCurrentSeason(app.prisma);
    const before = await loadGlobalWorld(app.prisma);
    if (!before) throw new Error("world did not load");
    const oldSaveId = before.save.id;
    const userCount = await app.prisma.user.count();
    const settingCount = await app.prisma.setting.count();

    // A stale notification referencing the doomed world must not survive it.
    const playerId = await app.prisma.user.findUniqueOrThrow({ where: { email: "resetplayer@test.dev" }, select: { id: true } });
    await app.prisma.userNotification.create({
      data: { userId: playerId.id, type: "MATCH_FINISHED", payloadJson: JSON.stringify({ homeName: "Reset City" }) },
    });

    const badConfirmation = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "NOPE", reason: "trying to skip the typed confirmation" } });
    expect(badConfirmation.statusCode).toBe(400);

    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "fresh start requested by the community" } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().ok).toBe(true);

    // Accounts, sessions and settings survive; nothing else does.
    expect(await app.prisma.user.count()).toBe(userCount);
    expect(await app.prisma.session.count()).toBeGreaterThan(0);
    expect(await app.prisma.setting.count()).toBe(settingCount);
    expect(await app.prisma.userNotification.count()).toBe(0);
    expect(await app.prisma.club.count({ where: { ownerUserId: { not: null } } })).toBe(0);
    expect(await app.prisma.mpSeason.count()).toBe(1);

    const fresh = await loadGlobalWorld(app.prisma);
    if (!fresh) throw new Error("fresh world did not load");
    expect(fresh.world.clubs.length).toBeGreaterThan(0);
    expect(fresh.world.clubs.every((c) => c.ownerUserId === null)).toBe(true);
    expect(fresh.world.fixtures.length).toBeGreaterThan(0);
    expect(await app.prisma.gameClock.count()).toBe(1);
    expect(await app.prisma.scheduledEvent.count({ where: { saveId: fresh.save.id } })).toBeGreaterThan(0);
    expect(await app.prisma.adminSchedulerAudit.count({ where: { saveId: fresh.save.id, action: "WORLD_RESET" } })).toBe(1);

    // The old save's scoped rows are gone even if the id was reused.
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: playerCookie } });
    expect(status.json().userClubId).toBeNull();

    void oldSaveId;
  });
});

