import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { materializeSeasonEvents, scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { ensureCurrentSeason } from "../src/services/mpService";
import { ensureGlobalSave, loadGlobalWorld, persistWorld } from "../src/services/saveService";
import { loadPresetsForClub } from "../src/services/automationPresetService";
import { schedulerProcessor } from "../src/services/jobs/schedulerProcessor";
import { ensureGameClock } from "../src/services/gameClockService";
import { DAY_MS, boundariesElapsed, dayBoundaryAtOrBefore } from "../src/services/dayBoundary";
import { realignFixtureKickoff } from "../src/game/scheduling";
import { CLUBS_PER_DIVISION } from "../src/game/multiplayer";
import { createHumanClub } from "../src/game/worldgen";
import { startLiveMatch } from "../src/game/world";
import { createTestSessionCookie } from "./testAuth";
import type { LiveMatchState } from "../src/game/types";

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
    const contract = await app.inject({ method: "POST", url: `/api/players/${player.id}/contract`, headers: { cookie: userCookie }, payload: { contractSeasons: 2 } });
    expect(contract.statusCode).toBe(409);

    // ...while setup mutations stay available.
    const tactics = await app.inject({ method: "POST", url: "/api/club/tactics", headers: { cookie: userCookie }, payload: { style: 1, pressing: 1, direction: 0 } });
    expect(tactics.statusCode).toBe(200);

    // Admin day controls refuse to run against a frozen clock.
    const advance = await app.inject({ method: "POST", url: "/api/admin/scheduler/day/advance", headers: { cookie: adminCookie }, payload: {} });
    expect(advance.statusCode).toBe(409);
    const scan = await app.inject({ method: "POST", url: "/api/admin/scheduler/scan", headers: { cookie: adminCookie } });
    expect(scan.statusCode).toBe(409);

    // Resume shifts real-time anchors by the frozen interval. The ~30ms
    // freeze crosses NO day boundary, so the grid shift is 0 — but this world
    // has never played anything, so the resume takes the LAUNCH branch: the
    // season re-anchors to the next boundary and every kickoff is re-timed
    // onto that grid (nothing has played, so this is equivalent to a fresh
    // generation). Only real-time timers move by the frozen interval.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resumed = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: {} });
    expect(resumed.statusCode).toBe(200);
    const shiftMs = resumed.json().shiftMs as number;
    expect(shiftMs).toBeGreaterThanOrEqual(30);
    expect(resumed.json().gridShiftMs).toBe(0);
    expect(resumed.json().strandedKickoffs).toBe(0);
    expect(typeof resumed.json().nextBoundary).toBe("number");

    const eventAfter = await app.prisma.scheduledEvent.findUniqueOrThrow({ where: { id: dueEvent.id } });
    expect(eventAfter.dueAt!.getTime()).toBe(new Date(dueEvent.dueAt!).getTime() + shiftMs);
    const worldAfter = await loadGlobalWorld(app.prisma);
    if (!worldAfter) throw new Error("world did not load after resume");
    expect(worldAfter.world.mp.pausedAt ?? null).toBeNull();
    // The launch branch records the resume instant as the physical advance.
    expect(worldAfter.world.mp.lastAdvancedAt).toBe(resumed.json().resumedAt);
    // The grid reference is boundary-aligned after the resume (zero seconds).
    const boundary = worldAfter.world.mp.lastBoundaryAt;
    expect(boundary).toBeDefined();
    expect(new Date(boundary!).getUTCSeconds()).toBe(0);
    expect(new Date(boundary!).getUTCMilliseconds()).toBe(0);
    expect(worldAfter.world.mp.seasonStartAt).toBe(boundary);
    // Every unplayed kickoff was re-timed onto the boundary grid inside its
    // own game day (the frozen interval is not what moved them).
    for (const fixture of worldAfter.world.fixtures) {
      if (fixture.played || fixture.kickoffAt === undefined) continue;
      const dayStart = boundary! + (fixture.scheduledSeasonDayIndex ?? fixture.dayIndex) * DAY_MS;
      expect(fixture.kickoffAt).toBeGreaterThanOrEqual(dayStart);
      expect(fixture.kickoffAt).toBeLessThan(dayStart + DAY_MS);
      expect((fixture.kickoffAt - dayStart) % (30 * 60 * 1000)).toBe(0);
    }
    const clockRow = await app.prisma.gameClock.findFirstOrThrow({ where: { saveId: worldAfter.save.id } });
    expect(clockRow.lastAdvancedAt.getTime()).toBe(worldAfter.world.mp.lastAdvancedAt);
    expect(clockRow.lastBoundaryAt!.getTime()).toBe(boundary);

    const statusAfter = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: userCookie } });
    expect(statusAfter.json().paused).toBe(false);

    // Resuming again is rejected cleanly.
    const doubleResume = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: {} });
    expect(doubleResume.statusCode).toBe(400);
  });

  it("computes next automatic advance from the boundary and flags a hand-corrupted row as BOUNDARY_DESYNC", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "clockadmin");
    await app.prisma.user.update({ where: { email: "clockadmin@test.dev" }, data: { isAdmin: true } });

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("world did not load");
    const saveId = loaded.save.id;
    // Anchor the clock so lastBoundaryAt exists and the row can be compared.
    loaded.world.mp.lastAdvancedAt = Date.now();
    await persistWorld(app.prisma, saveId, saveId, loaded.world, loaded.save.revision);
    const clock = await ensureGameClock(app.prisma, saveId, loaded.world);

    // Corrupt the pending row to an off-grid instant — the exact fingerprint
    // of the drift bug (a raw millisecond delta written by a resume shift).
    const existing = await app.prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
    const corrupted = new Date(Date.now() + 6 * 3600 * 1000 + 13 * 60 * 1000 + 52 * 1000);
    if (existing) {
      await app.prisma.scheduledEvent.update({ where: { id: existing.id }, data: { dueAt: corrupted } });
    } else {
      await scheduleEvent(app.prisma, { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, timeBasis: "REAL_TIME", dueAt: corrupted, idempotencyKey: "GAME_DAY_ADVANCE:desync-test" });
    }

    const res = await app.inject({ method: "GET", url: "/api/admin/scheduler/clock", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const view = res.json().clock;
    expect(view.health).toBe("BOUNDARY_DESYNC");
    // The panel shows the boundary-derived value, never the corrupted row.
    expect(new Date(view.nextAutomaticDayAdvance).getTime()).toBe(new Date(view.lastBoundaryAt).getTime() + DAY_MS);
    expect(new Date(view.nextAutomaticDayAdvance).getUTCSeconds()).toBe(0);
    expect(view.lastBoundaryAt).toBeDefined();
    expect(clock.lastBoundaryAt.getTime()).toBe(new Date(view.lastBoundaryAt).getTime());
  });

  it("repair migration reports without mutating, applies under FOOTMANIA_REALIGN_KICKOFFS=1, and refuses while a live match is in progress", async () => {
    await app.ready();
    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("world did not load");
    const saveId = loaded.save.id;
    const world = loaded.world;

    // Anchor stays aligned (Tier A becomes a no-op on it) and two unplayed
    // kickoffs drift one full day off their own game day.
    const now = Date.now();
    world.mp.seasonStartAt = dayBoundaryAtOrBefore(now);
    world.mp.lastAdvancedAt = world.mp.seasonStartAt;
    const drifted = world.fixtures.filter((f) => !f.played && f.kickoffAt !== undefined).slice(0, 2);
    expect(drifted).toHaveLength(2);
    // Capture AFTER the drift: report mode must leave the DRIFTED value in
    // place, and apply mode must move it off that value.
    for (const fixture of drifted) fixture.kickoffAt! += DAY_MS;
    const driftedKickoffs = drifted.map((f) => f.kickoffAt!);
    await persistWorld(app.prisma, saveId, saveId, world, loaded.save.revision);
    await materializeSeasonEvents(app.prisma, saveId, world);
    // A review flag the unattended db:upgrade run must clear.
    await app.prisma.setting.create({ data: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW", value: "1" } });

    const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const tsx = join(backendRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const script = join(backendRoot, "scripts", "migrate-game-day-boundary.ts");
    const runScript = (env: Record<string, string> = {}) =>
      spawnSync(tsx, [script], {
        cwd: backendRoot,
        encoding: "utf8",
        // Windows exposes tsx as a .cmd shim, which needs a shell for spawnSync.
        shell: process.platform === "win32",
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, ...env },
      });

    // The MATCH_START row was materialized from the PRE-drift kickoff and
    // materialization is idempotent, so it still carries that value. Report
    // mode must leave it exactly as it is — whatever it is.
    const msBeforeRow = await app.prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(drifted[0].id) } });
    const msBefore = msBeforeRow?.dueAt!.getTime();

    // Report mode: exit 0, kickoffs and MATCH_START rows untouched, the
    // review flag cleared (Tier A).
    const report = runScript();
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("report only");
    const afterReport = await loadGlobalWorld(app.prisma);
    if (!afterReport) throw new Error("world did not load");
    expect(afterReport.world.fixtures.find((f) => f.id === drifted[0].id)?.kickoffAt).toBe(driftedKickoffs[0]);
    expect(afterReport.world.fixtures.find((f) => f.id === drifted[1].id)?.kickoffAt).toBe(driftedKickoffs[1]);
    const msReport = await app.prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(drifted[0].id) } });
    expect(msReport?.dueAt!.getTime()).toBe(msBefore);
    expect(await app.prisma.setting.count({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" } })).toBe(0);

    // Apply mode requires a paused world.
    const pausedWorld = await loadGlobalWorld(app.prisma);
    if (!pausedWorld) throw new Error("world did not load");
    pausedWorld.world.mp.pausedAt = Date.now();
    await persistWorld(app.prisma, saveId, saveId, pausedWorld.world, pausedWorld.save.revision);
    const applied = runScript({ FOOTMANIA_REALIGN_KICKOFFS: "1" });
    expect(applied.status).toBe(0);
    const afterApply = await loadGlobalWorld(app.prisma);
    if (!afterApply) throw new Error("world did not load");
    const aligned = afterApply.world.fixtures.find((f) => f.id === drifted[0].id)!;
    expect(aligned.kickoffAt).toBe(realignFixtureKickoff(aligned, afterApply.world.mp.seasonStartAt!));
    expect(aligned.kickoffAt).not.toBe(driftedKickoffs[0]);
    const msAfter = await app.prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(drifted[0].id) } });
    expect(msAfter?.dueAt!.getTime()).toBe(aligned.kickoffAt!);

    // Idempotency: a re-run after the apply reports nothing and changes nothing.
    const replay = runScript({ FOOTMANIA_REALIGN_KICKOFFS: "1" });
    expect(replay.status).toBe(0);
    expect(replay.stdout).toContain("all unplayed fixtures are inside their own game day");
    const afterReplay = await loadGlobalWorld(app.prisma);
    if (!afterReplay) throw new Error("world did not load");
    expect(afterReplay.world.fixtures.find((f) => f.id === drifted[0].id)?.kickoffAt).toBe(aligned.kickoffAt);

    // Refusal: a live match in progress must block the apply, exit non-zero,
    // and leave the fixture untouched.
    const liveWorld = await loadGlobalWorld(app.prisma);
    if (!liveWorld) throw new Error("world did not load");
    const victim = liveWorld.world.fixtures.find((f) => !f.played && f.kickoffAt !== undefined)!;
    victim.kickoffAt! += DAY_MS;
    const victimKickoff = victim.kickoffAt!;
    // A DIFFERENT fixture goes live. Live fixtures are excluded from
    // re-alignment by design, so making the drifted one live would leave
    // nothing misaligned and the refusal would never be exercised.
    // Build a REAL live match: a hand-rolled LiveMatchState omits fields
    // hydrateLiveMatchState requires, so the world fails to rebuild on the
    // next load and every later test in this file inherits the corruption.
    const liveFixture = liveWorld.world.fixtures.find((f) => !f.played && f.id !== victim.id && f.kickoffAt !== undefined)!;
    expect(startLiveMatch(liveWorld.world, liveFixture, Date.now())).not.toBeNull();
    await persistWorld(app.prisma, saveId, saveId, liveWorld.world, liveWorld.save.revision);
    const refused = runScript({ FOOTMANIA_REALIGN_KICKOFFS: "1" });
    expect(refused.status).not.toBe(0);
    const afterRefuse = await loadGlobalWorld(app.prisma);
    expect(afterRefuse?.world.fixtures.find((f) => f.id === victim.id)?.kickoffAt).toBe(victimKickoff);

    // Clean up the refusal setup so later tests in this file see a live-match
    // free world again (the recalculate guard forbids regeneration while any
    // current-season match is live). Live-match rows are append-only through
    // persistWorld, so the row is deleted directly; the victim kickoff is
    // re-aligned and its MATCH_START row follows it.
    await app.prisma.liveMatch.deleteMany({ where: { saveId } });
    const cleanup = await loadGlobalWorld(app.prisma);
    if (!cleanup) throw new Error("world did not load");
    cleanup.world.liveMatches = [];
    // startLiveMatch also RECORDS a match and stamps the clubs; the fixture
    // recalculation guard rejects a season that has any recorded match, so
    // every trace of the started match has to go, not just the live row.
    cleanup.world.matches = cleanup.world.matches.filter((m) => m.fixtureId !== liveFixture.id);
    for (const club of cleanup.world.clubs) club.liveMatchAt = null;
    await app.prisma.match.deleteMany({ where: { saveId, fixtureId: liveFixture.id } });
    // Apply mode required a paused world; leaving it paused makes every later
    // test in this file fail with 409 (world paused).
    cleanup.world.mp.pausedAt = null;
    const restored = cleanup.world.fixtures.find((f) => f.id === victim.id)!;
    restored.kickoffAt = realignFixtureKickoff(restored, cleanup.world.mp.seasonStartAt!);
    await persistWorld(app.prisma, saveId, saveId, cleanup.world, cleanup.save.revision);
    await app.prisma.scheduledEvent.updateMany({
      where: { saveId, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: String(victim.id), status: { in: ["PENDING", "FAILED"] } },
      data: { dueAt: new Date(restored.kickoffAt!) },
    });
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
    // Without keepIdentity nothing is archived.
    expect(await app.prisma.clubIdentityArchive.count()).toBe(0);

    const fresh = await loadGlobalWorld(app.prisma);
    if (!fresh) throw new Error("fresh world did not load");
    // A reset leaves the world in the launch hold: no Division 1,
    // no filler clubs, no fixtures, season clock held.
    expect(fresh.world.clubs.length).toBe(0);
    expect(fresh.world.competitions.length).toBe(0);
    expect(fresh.world.fixtures.length).toBe(0);
    expect(fresh.world.mp.awaitingLaunchRoster).toBe(true);
    expect(fresh.world.mp.pausedAt).toBeTypeOf("number");
    expect(await app.prisma.gameClock.count()).toBe(1);
    expect(await app.prisma.scheduledEvent.count({ where: { saveId: fresh.save.id } })).toBeGreaterThan(0);
    expect(await app.prisma.adminSchedulerAudit.count({ where: { saveId: fresh.save.id, action: "WORLD_RESET" } })).toBe(1);

    // The old save's scoped rows are gone even if the id was reused.
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: playerCookie } });
    expect(status.json().userClubId).toBeNull();
    expect(status.json().awaitingFirstHuman).toBe(true);

    void oldSaveId;
  });

  it("archives club identities on keepIdentity reset and restores them at rejoin", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "keepadmin");
    await app.prisma.user.update({ where: { email: "keepadmin@test.dev" }, data: { isAdmin: true } });
    const playerCookie = await registerAndLogin(app, "keepplayer");
    await joinClub(app, playerCookie, "Archived United");

    // Give the club a distinct identity: colors, kit, logo, availability,
    // friend-grouping opt-out.
    const player = await app.prisma.user.findUniqueOrThrow({ where: { email: "keepplayer@test.dev" }, select: { id: true } });
    await app.prisma.user.update({ where: { id: player.id }, data: { isPro: true } });
    await app.inject({
      method: "POST",
      url: "/api/mp/club/logo",
      headers: { cookie: playerCookie },
      payload: { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/mp/club/friend-grouping",
      headers: { cookie: playerCookie },
      payload: { enabled: false },
    });
    // A custom away jersey must survive the reset: distinct colors + pattern.
    const customAway = {
      home: { primary: "#d40000", secondary: "#ffffff", accent: "#ffffff", numberColor: "#ffffff", pattern: "stripes" },
      away: { primary: "#111133", secondary: "#ffcc00", accent: "#ffcc00", numberColor: "#ffffff", pattern: "diagonal-split" },
      gk: { primary: "#00aa55", secondary: "#000000", accent: "#000000", numberColor: "#ffffff", pattern: "hoops" },
    };
    const kitSave = await app.inject({
      method: "PUT",
      url: "/api/mp/club/kit",
      headers: { cookie: playerCookie },
      payload: { kits: customAway },
    });
    expect(kitSave.statusCode).toBe(200);

    await ensureCurrentSeason(app.prisma);
    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "keep the team identities across the wipe", keepIdentity: true } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().archivedClubs).toBe(1);

    // The archive row exists and carries the identity.
    const archive = await app.prisma.clubIdentityArchive.findUniqueOrThrow({ where: { userId: player.id } });
    expect(archive.name).toBe("Archived United");
    expect(archive.customLogoData).toContain("iVBORw0KGgo");
    expect(archive.friendGroupingOptIn).toBe(false);
    // The custom away jersey is archived.
    const archivedKits = JSON.parse(archive.kitJson!);
    expect(archivedKits.away).toMatchObject({ primary: "#111133", secondary: "#ffcc00", pattern: "diagonal-split" });

    // The world is fresh (no human clubs) but the status advertises the
    // preserved identity to the join screen — including the full kit set.
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: playerCookie } });
    expect(status.json().userClubId).toBeNull();
    expect(status.json().preservedIdentity).toMatchObject({ name: "Archived United", hasCustomLogo: true, country: "BRA" });
    expect(status.json().preservedIdentity.kits.away).toMatchObject({ primary: "#111133", secondary: "#ffcc00", pattern: "diagonal-split" });

    // Rejoin: the archived identity is applied and the row consumed.
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie: playerCookie },
      payload: {
        clubName: "Wizard Name",
        country: "ARG",
        stadiumName: "Wizard Stadium",
        coachName: "Wizard Coach",
        preferredHours: Array.from({ length: 16 }, (_, i) => i),
      },
    });
    expect(join.statusCode).toBe(200);
    expect(join.json().preserved).toBe(true);
    expect(await app.prisma.clubIdentityArchive.count()).toBe(0);

    const world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    const club = world.world.clubs.find((c) => c.ownerUserId === player.id);
    expect(club).toBeDefined();
    expect(club!.name).toBe("Archived United");
    expect(club!.stadiumName).toBe("Archived United Arena");
    expect(club!.country).toBe("BRA");
    expect(club!.customLogo).toMatchObject({ mime: "image/png" });
    expect(club!.friendGroupingOptIn).toBe(false);
    // The custom away jersey survived the full reset -> rejoin cycle.
    expect(club!.kits?.away).toMatchObject({ primary: "#111133", secondary: "#ffcc00", pattern: "diagonal-split" });
    // The wizard's name/country/stadium/coach were overridden by the archive.
    expect(club!.coachName).not.toBe("Wizard Coach");
    // The first join formed Division 1 lazily, but the world stays in the
    // launch hold until the full roster arrives (one club is not eight).
    expect(world.world.mp.awaitingFirstHuman).not.toBe(true);
    expect(world.world.mp.pausedAt).toBeTypeOf("number");
    expect(world.world.competitions.some((c) => c.kind === "division" && c.seasonId === world.world.mp.seasonId)).toBe(true);
    expect(world.world.fixtures.length).toBeGreaterThan(0);
  });

  it("rejects automation presets that change formation outside the half-time trigger", async () => {
    await app.ready();
    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    const cookie = await registerAndLogin(app, "autopresetuser");
    await joinClub(app, cookie, "Preset FC");

    // A half-time formation change is a valid preset rule.
    const valid = await app.inject({
      method: "PUT",
      url: "/api/mp/automation",
      headers: { cookie },
      payload: {
        presets: [
          {
            id: "p1",
            name: "Halftime shape",
            formationId: 4,
            enabled: true,
            rules: [
              { id: "r1", trigger: { kind: "HALF_TIME" }, conditions: [], actions: [{ kind: "TACTICS", formation: 7 }] },
            ],
          },
        ],
      },
    });
    expect(valid.statusCode).toBe(200);

    // The valid half-time rule was actually persisted on this user's club.
    // Automation presets live outside the World object (plan §11 Part 4) —
    // read them back through the same service the routes use, not via the
    // in-memory Club (which no longer carries them).
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email: "autopresetuser@test.dev" } });
    let world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    let club = world.world.clubs.find((c) => c.ownerUserId === user.id);
    expect(club).toBeDefined();
    let presets = await loadPresetsForClub(app.prisma, world.save.id, club!.id);
    expect(presets.some((p) => p.rules.some((r) => r.actions.some((a) => a.kind === "TACTICS" && a.formation !== undefined)))).toBe(true);

    // A formation change attached to a non-half-time trigger must be rejected
    // instead of silently stored and silently dropped at fire time.
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/mp/automation",
      headers: { cookie },
      payload: {
        presets: [
          {
            id: "p2",
            name: "Minute shape",
            formationId: 4,
            enabled: true,
            rules: [
              { id: "r2", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [{ kind: "TACTICS", formation: 7, style: 1 }] },
            ],
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    club = world.world.clubs.find((c) => c.ownerUserId === user.id);
    expect(club).toBeDefined();
    presets = await loadPresetsForClub(app.prisma, world.save.id, club!.id);
    // The rejected preset was not stored; the valid half-time one remains.
    expect(presets.map((p) => p.id)).toEqual(["p1"]);
    expect(presets.some((p) => p.rules.some((r) => r.actions.some((a) => a.kind === "TACTICS" && a.formation !== undefined)))).toBe(true);
  });

  it("holds the season clock until the roster completes; only the full roster or a force resume starts it", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "waitadmin");
    await app.prisma.user.update({ where: { email: "waitadmin@test.dev" }, data: { isAdmin: true } });
    const firstCookie = await registerAndLogin(app, "waitfirst");
    const secondCookie = await registerAndLogin(app, "waitsecond");

    await ensureCurrentSeason(app.prisma);
    // Reset the world (no humans survive): this is what enters the hold.
    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "enter the launch hold" } });
    expect(reset.statusCode).toBe(200);

    // No humans yet: the world holds — no Division 1, no clubs, clock frozen.
    let world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    expect(world.world.mp.awaitingLaunchRoster).toBe(true);
    expect(world.world.mp.pausedAt).toBeTypeOf("number");
    expect(world.world.competitions.length).toBe(0);
    expect(world.world.clubs.length).toBe(0);

    // The public landing status reflects the wait.
    const publicStatus = await app.inject({ method: "GET", url: "/api/public/season" });
    expect(publicStatus.json().awaitingFirstHuman).toBe(true);
    expect(publicStatus.json().paused).toBe(true);

    // A plain admin resume is refused while held.
    const refusedResume = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: { reason: "should not be allowed while the roster is incomplete" } });
    expect(refusedResume.statusCode).toBe(400);

    // The first join forms Division 1 lazily but does NOT release the hold.
    await joinClub(app, firstCookie, "Founding FC");
    const afterFirst = await loadGlobalWorld(app.prisma);
    if (!afterFirst) throw new Error("world did not load after first join");
    expect(afterFirst.world.mp.awaitingLaunchRoster).toBe(true);
    expect(afterFirst.world.mp.pausedAt).toBeTypeOf("number");
    const division = afterFirst.world.competitions.find((c) => c.kind === "division" && c.seasonId === afterFirst.world.mp.seasonId);
    expect(division).toBeDefined();
    expect(Object.keys(division!.standings).length).toBe(8);
    expect(afterFirst.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(1);
    expect(afterFirst.world.clubs.filter((c) => c.ownerUserId === null).length).toBe(7);
    expect(afterFirst.world.fixtures.length).toBeGreaterThan(0);
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: firstCookie } });
    expect(status.json().awaitingFirstHuman).toBe(true);
    expect(status.json().paused).toBe(true);
    // The roster progress is surfaced from the authoritative fields.
    expect(status.json().launchHoldClubs).toBe(1);
    expect(status.json().launchHoldTarget).toBe(CLUBS_PER_DIVISION);

    // An admin FORCE resume lifts the under-strength hold early.
    const forced = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: { reason: "release the hold early for the test", force: true } });
    expect(forced.statusCode).toBe(200);
    const afterForce = await loadGlobalWorld(app.prisma);
    if (!afterForce) throw new Error("world did not load after force resume");
    expect(afterForce.world.mp.awaitingLaunchRoster).not.toBe(true);
    expect(afterForce.world.mp.pausedAt ?? null).toBeNull();
    expect(afterForce.world.mp.seasonStartAt!).toBeGreaterThan(Date.now());
    expect(new Date(afterForce.world.mp.seasonStartAt!).getUTCSeconds()).toBe(0);
    expect(afterForce.world.mp.lastBoundaryAt).toBe(afterForce.world.mp.seasonStartAt);
    // The remaining slots are still AI fillers.
    expect(afterForce.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(1);
    expect(afterForce.world.clubs.filter((c) => c.ownerUserId === null).length).toBe(7);

    // A second human joins the released world (replacing another filler).
    await joinClub(app, secondCookie, "Second SC");
    const afterSecond = await loadGlobalWorld(app.prisma);
    if (!afterSecond) throw new Error("world did not load after second join");
    expect(afterSecond.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(2);
    expect(afterSecond.world.clubs.filter((c) => c.ownerUserId === null).length).toBe(6);
    // The hold never re-arms after the lift.
    expect(afterSecond.world.mp.awaitingLaunchRoster).not.toBe(true);
    expect(afterSecond.world.mp.pausedAt ?? null).toBeNull();
  });

  it("lets managers join and return while paused, while market, contract and admin controls stay frozen", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "pausedjoinsadmin");
    await app.prisma.user.update({ where: { email: "pausedjoinsadmin@test.dev" }, data: { isAdmin: true } });
    const hostCookie = await registerAndLogin(app, "pausedjoinshost");
    const newcomerCookie = await registerAndLogin(app, "pausedjoinsnew");

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);

    // Host joins first: the season runs and Division 1 is already formed.
    await joinClub(app, hostCookie, "Paused Host FC");
    const host = await app.prisma.user.findUniqueOrThrow({ where: { email: "pausedjoinshost@test.dev" } });

    // Host goes dormant and leaves its division, exactly like a rollover
    // abandonment (dormant clubs are frozen whole and out of the pyramid).
    const seeded = await loadGlobalWorld(app.prisma);
    if (!seeded) throw new Error("world did not load");
    const hostClub = seeded.world.clubs.find((c) => c.ownerUserId === host.id);
    expect(hostClub).toBeDefined();
    hostClub!.competitionState = "DORMANT";
    const hostDivision = seeded.world.competitions.find((c) => c.kind === "division" && c.standings[hostClub!.id] !== undefined)!;
    delete hostDivision.standings[hostClub!.id];
    await persistWorld(app.prisma, seeded.save.id, seeded.save.id, seeded.world, seeded.save.revision);

    // Freeze the world.
    const paused = await app.inject({ method: "POST", url: "/api/admin/scheduler/pause", headers: { cookie: adminCookie }, payload: { reason: "maintenance before signup wave" } });
    expect(paused.statusCode).toBe(200);
    const pausedAt = paused.json().pausedAt as number;

    // A brand-new manager joins while frozen: placement succeeds, the club
    // enters the SAME division an unpaused join would, and its timestamps are
    // anchored to the frozen instant.
    await joinClub(app, newcomerCookie, "Frozen Newcomer");
    const duringPause = await loadGlobalWorld(app.prisma);
    if (!duringPause) throw new Error("world did not load");
    expect(duringPause.world.mp.pausedAt).toBe(pausedAt);
    expect(duringPause.world.mp.awaitingFirstHuman).toBe(false);
    const newcomer = await app.prisma.user.findUniqueOrThrow({ where: { email: "pausedjoinsnew@test.dev" } });
    const newcomerClub = duringPause.world.clubs.find((c) => c.ownerUserId === newcomer.id);
    expect(newcomerClub).toBeDefined();
    expect(newcomerClub!.competitionState).toBe("ACTIVE");
    expect(newcomerClub!.lastMeaningfulActivityAt).toBe(pausedAt);
    const newcomerDivision = duringPause.world.competitions.find((c) => c.kind === "division" && c.standings[newcomerClub!.id] !== undefined);
    expect(newcomerDivision).toBeDefined();

    // The dormant host returns while frozen: allowed, and it re-enters the
    // same bottom-tier division with its activity anchor at the frozen instant.
    const returning = await app.inject({ method: "POST", url: "/api/mp/return", headers: { cookie: hostCookie } });
    expect(returning.statusCode).toBe(200);
    const afterReturn = await loadGlobalWorld(app.prisma);
    if (!afterReturn) throw new Error("world did not load");
    expect(afterReturn.world.mp.pausedAt).toBe(pausedAt);
    const hostClubAfter = afterReturn.world.clubs.find((c) => c.ownerUserId === host.id);
    expect(hostClubAfter).toBeDefined();
    expect(hostClubAfter!.competitionState).toBe("ACTIVE");
    expect(hostClubAfter!.lastMeaningfulActivityAt).toBe(pausedAt);
    const hostDivisionAfter = afterReturn.world.competitions.find((c) => c.kind === "division" && c.standings[hostClubAfter!.id] !== undefined);
    expect(hostDivisionAfter?.id).toBe(newcomerDivision!.id);

    // Market, contract and admin clock controls remain frozen while paused.
    const player = await app.prisma.player.findFirstOrThrow({ where: { saveId: duringPause.save.id, clubId: { not: null } }, select: { id: true } });
    const release = await app.inject({ method: "POST", url: `/api/players/${player.id}/release`, headers: { cookie: newcomerCookie } });
    expect(release.statusCode).toBe(409);
    const contract = await app.inject({ method: "POST", url: `/api/players/${player.id}/contract`, headers: { cookie: newcomerCookie }, payload: { contractSeasons: 2 } });
    expect(contract.statusCode).toBe(409);
    const advance = await app.inject({ method: "POST", url: "/api/admin/scheduler/day/advance", headers: { cookie: adminCookie }, payload: {} });
    expect(advance.statusCode).toBe(409);

    // Resume unfreezes the world for everyone.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resumed = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: {} });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json().shiftMs as number)).toBeGreaterThanOrEqual(30);
    const statusAfter = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: newcomerCookie } });
    expect(statusAfter.json().paused).toBe(false);
  });

  it("holds through joins 1..N−1 (including a dormant return) and releases on the N-th, re-timing the fixtures", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "rosteradmin");
    await app.prisma.user.update({ where: { email: "rosteradmin@test.dev" }, data: { isAdmin: true } });
    const cookies: string[] = [];
    const windows: number[][] = [];
    for (let i = 0; i < CLUBS_PER_DIVISION; i++) {
      const cookie = await registerAndLogin(app, `rosterjoin${i}`);
      cookies.push(cookie);
      // Each manager picks a distinct 8-hour window (16 half-hour slots).
      windows.push(Array.from({ length: 16 }, (_, s) => (s + i * 4) % 48));
    }

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    // Reset enters the launch hold (zero humans).
    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "enter the roster hold for the auto-release test" } });
    expect(reset.statusCode).toBe(200);
    const saveId = reset.json().newSaveId as number;

    const held = await loadGlobalWorld(app.prisma);
    if (!held) throw new Error("world did not load");
    expect(held.world.mp.awaitingLaunchRoster).toBe(true);
    const holdInstant = held.world.mp.pausedAt as number;
    expect(holdInstant).toBeTypeOf("number");

    // A DORMANT club already waits in the held world; its return places it
    // (counting toward the roster) but must NOT release the hold. It carries
    // the first manager's window so the re-timing honors it like any join.
    const returner = await app.prisma.user.findUniqueOrThrow({ where: { email: "rosterjoin0@test.dev" } });
    const dormant = createHumanClub(held.world, { userId: returner.id, clubName: "Waiting Return FC", country: "BRA", preferredHours: windows[0] });
    dormant.competitionState = "DORMANT";
    await persistWorld(app.prisma, saveId, saveId, held.world, held.save.revision);

    const returned = await app.inject({ method: "POST", url: "/api/mp/return", headers: { cookie: cookies[0] } });
    expect(returned.statusCode).toBe(200);
    let world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    expect(world.world.mp.awaitingLaunchRoster).toBe(true);
    expect(world.world.mp.pausedAt).toBe(holdInstant);
    expect(world.world.clubs.find((c) => c.ownerUserId === returner.id)?.competitionState).toBe("ACTIVE");
    // A division formed lazily around the return; its fixtures are still
    // anchored to the pre-hold seasonStartAt until the lift.
    const seasonIdAfterReturn = world.world.mp.seasonId;
    expect(world.world.competitions.some((c) => c.kind === "division" && c.seasonId === seasonIdAfterReturn)).toBe(true);

    // Joins 2..N−1 keep the world frozen.
    for (let i = 1; i < CLUBS_PER_DIVISION - 1; i++) {
      const join = await app.inject({
        method: "POST",
        url: "/api/mp/join",
        headers: { cookie: cookies[i] },
        payload: { clubName: `Roster FC ${i}`, country: "BRA", stadiumName: `Arena ${i}`, coachName: `Coach ${i}`, preferredHours: windows[i] },
      });
      expect(join.statusCode).toBe(200);
    }
    world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    expect(world.world.mp.awaitingLaunchRoster).toBe(true);
    expect(world.world.mp.pausedAt).toBe(holdInstant);

    // The N-th join completes the roster: the world releases itself.
    const finalJoin = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie: cookies[CLUBS_PER_DIVISION - 1] },
      payload: { clubName: "Roster Final", country: "BRA", stadiumName: "Final Arena", coachName: "Final Coach", preferredHours: windows[CLUBS_PER_DIVISION - 1] },
    });
    expect(finalJoin.statusCode).toBe(200);
    world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    // A narrowed const: `world` is reassigned later, which resets TypeScript's
    // null-narrowing inside the closures below.
    const released = world;
    expect(released.world.mp.awaitingLaunchRoster).not.toBe(true);
    expect(released.world.mp.awaitingFirstHuman).not.toBe(true);
    expect(released.world.mp.pausedAt ?? null).toBeNull();
    expect(released.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(CLUBS_PER_DIVISION);
    const seasonBoundary = released.world.mp.seasonStartAt!;
    expect(seasonBoundary).toBeGreaterThan(Date.now());
    expect(new Date(seasonBoundary).getUTCSeconds()).toBe(0);
    expect(released.world.mp.lastBoundaryAt).toBe(seasonBoundary);

    // The lift re-timed every fixture onto the boundary grid inside its own
    // game day, and each human club's HOME fixtures landed inside its stated
    // availability window (home preference is the first objective — except
    // the synchronized final round, which optimizes the division sum and is
    // checked separately below).
    const fixturesByHome = new Map<number, { kickoffAt: number; round: number }[]>();
    let lastRound = 0;
    for (const fixture of released.world.fixtures) {
      lastRound = Math.max(lastRound, fixture.round);
      const dayStart = seasonBoundary + fixture.scheduledSeasonDayIndex! * DAY_MS;
      expect(fixture.kickoffAt!).toBeGreaterThanOrEqual(dayStart);
      expect(fixture.kickoffAt!).toBeLessThan(dayStart + DAY_MS);
      expect((fixture.kickoffAt! - dayStart) % (30 * 60 * 1000)).toBe(0);
      const list = fixturesByHome.get(fixture.homeClubId) ?? [];
      list.push({ kickoffAt: fixture.kickoffAt!, round: fixture.round });
      fixturesByHome.set(fixture.homeClubId, list);
    }
    const finals = released.world.fixtures.filter((f) => f.round === lastRound);
    expect(finals.length).toBeGreaterThan(0);
    expect(new Set(finals.map((f) => f.kickoffAt)).size).toBe(1);
    const joiners = await app.prisma.user.findMany({ where: { email: { in: Array.from({ length: CLUBS_PER_DIVISION }, (_, i) => `rosterjoin${i}@test.dev`) } }, select: { id: true, email: true } });
    const joinerByEmail = new Map(joiners.map((u) => [u.email, u.id]));
    for (let i = 0; i < CLUBS_PER_DIVISION; i++) {
      const clubId = released.world.clubs.find((c) => c.ownerUserId === joinerByEmail.get(`rosterjoin${i}@test.dev`))?.id;
      expect(clubId).toBeDefined();
      const home = (fixturesByHome.get(clubId!) ?? []).filter((f) => f.round !== lastRound);
      expect(home.length).toBeGreaterThan(0);
      for (const f of home) {
        const slot = Math.round(((f.kickoffAt - seasonBoundary) % DAY_MS) / (30 * 60 * 1000));
        expect(windows[i]).toContain(slot);
      }
    }

    // Pending MATCH_START rows follow the re-timed kickoffs exactly.
    await materializeSeasonEvents(app.prisma, saveId, released.world);
    const msRows = await app.prisma.scheduledEvent.findMany({ where: { saveId, type: ScheduledEventType.MATCH_START, status: "PENDING" } });
    expect(msRows.length).toBeGreaterThan(0);
    for (const row of msRows) {
      const fixture = released.world.fixtures.find((f) => f.id === Number(row.entityId));
      expect(row.dueAt!.getTime()).toBe(fixture?.kickoffAt);
    }

    // The first advance fires at seasonBoundary + 24h, and not before.
    const pending = await app.prisma.scheduledEvent.findFirst({ where: { saveId, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" } });
    expect(pending?.dueAt!.getTime()).toBe(seasonBoundary + DAY_MS);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS - 1)).toBe(0);
    expect(boundariesElapsed(seasonBoundary, seasonBoundary + DAY_MS)).toBe(1);
  });
});

