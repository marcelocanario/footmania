import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { scheduleEvent, ScheduledEventType } from "../src/services/scheduler";
import { ensureCurrentSeason } from "../src/services/mpService";
import { ensureGlobalSave, loadGlobalWorld, persistWorld } from "../src/services/saveService";
import { loadPresetsForClub } from "../src/services/automationPresetService";
import { schedulerProcessor } from "../src/services/jobs/schedulerProcessor";
import { createHumanClub } from "../src/game/worldgen";
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
    // Without keepIdentity nothing is archived.
    expect(await app.prisma.clubIdentityArchive.count()).toBe(0);

    const fresh = await loadGlobalWorld(app.prisma);
    if (!fresh) throw new Error("fresh world did not load");
    // A reset leaves the world waiting for its first manager: no Division 1,
    // no filler clubs, no fixtures, season clock held.
    expect(fresh.world.clubs.length).toBe(0);
    expect(fresh.world.competitions.length).toBe(0);
    expect(fresh.world.fixtures.length).toBe(0);
    expect(fresh.world.mp.awaitingFirstHuman).toBe(true);
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
    // The first join lifted the waiting-for-first-human hold and formed
    // Division 1 lazily.
    expect(world.world.mp.awaitingFirstHuman).not.toBe(true);
    expect(world.world.mp.pausedAt ?? null).toBeNull();
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

  it("holds the season clock while waiting for the first human, then starts it on join", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "waitadmin");
    await app.prisma.user.update({ where: { email: "waitadmin@test.dev" }, data: { isAdmin: true } });
    const firstCookie = await registerAndLogin(app, "waitfirst");
    const secondCookie = await registerAndLogin(app, "waitsecond");

    await ensureCurrentSeason(app.prisma);
    // Reset the world (no humans survive): this is what enters waiting mode.
    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "enter waiting-for-first-human mode" } });
    expect(reset.statusCode).toBe(200);

    // No humans yet: the world waits — no Division 1, no clubs, clock held.
    let world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    expect(world.world.mp.awaitingFirstHuman).toBe(true);
    expect(world.world.mp.pausedAt).toBeTypeOf("number");
    expect(world.world.competitions.length).toBe(0);
    expect(world.world.clubs.length).toBe(0);

    // The public landing status reflects the wait.
    const publicStatus = await app.inject({ method: "GET", url: "/api/public/season" });
    expect(publicStatus.json().awaitingFirstHuman).toBe(true);
    expect(publicStatus.json().paused).toBe(true);

    // An admin manual resume is refused while waiting.
    const refusedResume = await app.inject({ method: "POST", url: "/api/admin/scheduler/resume", headers: { cookie: adminCookie }, payload: { reason: "should not be allowed while waiting" } });
    expect(refusedResume.statusCode).toBe(400);

    // The first join lifts the hold and forms Division 1.
    await joinClub(app, firstCookie, "Founding FC");
    const afterFirst = await loadGlobalWorld(app.prisma);
    if (!afterFirst) throw new Error("world did not load after first join");
    expect(afterFirst.world.mp.awaitingFirstHuman).not.toBe(true);
    expect(afterFirst.world.mp.pausedAt ?? null).toBeNull();
    const division = afterFirst.world.competitions.find((c) => c.kind === "division" && c.seasonId === afterFirst.world.mp.seasonId);
    expect(division).toBeDefined();
    expect(Object.keys(division!.standings).length).toBe(8);
    expect(afterFirst.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(1);
    expect(afterFirst.world.clubs.filter((c) => c.ownerUserId === null).length).toBe(7);
    expect(afterFirst.world.fixtures.length).toBeGreaterThan(0);
    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie: firstCookie } });
    expect(status.json().awaitingFirstHuman).toBe(false);
    expect(status.json().paused).toBe(false);

    // A second human joins the now-formed Division 1 (replacing another filler).
    await joinClub(app, secondCookie, "Second SC");
    const afterSecond = await loadGlobalWorld(app.prisma);
    if (!afterSecond) throw new Error("world did not load after second join");
    expect(afterSecond.world.clubs.filter((c) => c.ownerUserId !== null).length).toBe(2);
    expect(afterSecond.world.clubs.filter((c) => c.ownerUserId === null).length).toBe(6);
  });

  it("lets managers join and return while paused, while market, contract and admin controls stay frozen", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "pausedjoinsadmin");
    await app.prisma.user.update({ where: { email: "pausedjoinsadmin@test.dev" }, data: { isAdmin: true } });
    const hostCookie = await registerAndLogin(app, "pausedjoinshost");
    const newcomerCookie = await registerAndLogin(app, "pausedjoinsnew");

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
    const reset = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "clean slate for the paused join test" } });
    expect(reset.statusCode).toBe(200);

    // Host joins first: the first-human lift starts the season, D1 forms.
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

  it("lifts the waiting-for-first-human hold on a paused join and a paused dormant return, shifting by the held interval", async () => {
    await app.ready();
    const adminCookie = await registerAndLogin(app, "waitliftadmin");
    await app.prisma.user.update({ where: { email: "waitliftadmin@test.dev" }, data: { isAdmin: true } });
    const joinerCookie = await registerAndLogin(app, "waitliftjoin");
    const returnerCookie = await registerAndLogin(app, "waitliftreturn");

    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);

    // Phase 1: a DORMANT club exists in a world waiting for its first manager
    // (enterWaitingForFirstHuman keeps human clubs; only ACTIVE humans per tier
    // are checked). Its return must lift the hold like the first join would.
    const resetA = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "enter waiting mode for the dormant return lift test" } });
    expect(resetA.statusCode).toBe(200);
    const returner = await app.prisma.user.findUniqueOrThrow({ where: { email: "waitliftreturn@test.dev" } });
    const waitingA = await loadGlobalWorld(app.prisma);
    if (!waitingA) throw new Error("world did not load");
    const pausedAtA = waitingA.world.mp.pausedAt as number;
    const seasonStartA = waitingA.world.mp.seasonStartAt;
    expect(seasonStartA).toBeTypeOf("number");
    const dormant = createHumanClub(waitingA.world, { userId: returner.id, clubName: "Waiting Return FC", country: "BRA" });
    dormant.competitionState = "DORMANT";
    await persistWorld(app.prisma, waitingA.save.id, waitingA.save.id, waitingA.world, waitingA.save.revision);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const returned = await app.inject({ method: "POST", url: "/api/mp/return", headers: { cookie: returnerCookie } });
    expect(returned.statusCode).toBe(200);
    const afterReturn = await loadGlobalWorld(app.prisma);
    if (!afterReturn) throw new Error("world did not load");
    expect(afterReturn.world.mp.awaitingFirstHuman).toBe(false);
    expect(afterReturn.world.mp.pausedAt ?? null).toBeNull();
    // The hold was lifted with a REAL now, so the resume shift actually moved
    // the season start forward by the held interval (never a zero shift).
    expect(afterReturn.world.mp.seasonStartAt! - seasonStartA!).toBeGreaterThanOrEqual(50);
    expect(afterReturn.world.competitions.some((c) => c.kind === "division" && c.seasonId === afterReturn.world.mp.seasonId)).toBe(true);
    const returnedClub = afterReturn.world.clubs.find((c) => c.ownerUserId === returner.id);
    expect(returnedClub?.competitionState).toBe("ACTIVE");

    // Phase 2: the first join while waiting lifts the hold the same way.
    const resetB = await app.inject({ method: "POST", url: "/api/admin/world/reset", headers: { cookie: adminCookie }, payload: { confirmation: "RESET", reason: "enter waiting mode for the join lift test" } });
    expect(resetB.statusCode).toBe(200);
    const waitingB = await loadGlobalWorld(app.prisma);
    if (!waitingB) throw new Error("world did not load");
    const pausedAtB = waitingB.world.mp.pausedAt as number;
    const seasonStartB = waitingB.world.mp.seasonStartAt;

    await new Promise((resolve) => setTimeout(resolve, 50));
    await joinClub(app, joinerCookie, "Waiting Join FC");
    const afterJoin = await loadGlobalWorld(app.prisma);
    if (!afterJoin) throw new Error("world did not load");
    expect(afterJoin.world.mp.awaitingFirstHuman).toBe(false);
    expect(afterJoin.world.mp.pausedAt ?? null).toBeNull();
    expect(afterJoin.world.mp.seasonStartAt! - seasonStartB!).toBeGreaterThanOrEqual(50);
    const division = afterJoin.world.competitions.find((c) => c.kind === "division" && c.seasonId === afterJoin.world.mp.seasonId);
    expect(division).toBeDefined();
    // Both phases really started from a held clock, not from an already
    // lifted world.
    expect(pausedAtA).toBeTypeOf("number");
    expect(pausedAtB).toBeTypeOf("number");
  });
});

