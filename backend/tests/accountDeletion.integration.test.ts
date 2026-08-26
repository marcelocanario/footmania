import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { ensureCurrentSeason } from "../src/services/mpService";
import { ensureGlobalSave, loadGlobalWorld } from "../src/services/saveService";
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

describe("admin account deletion", () => {
  const app = buildServer();

  beforeAll(async () => {
    await app.ready();
    await ensureGlobalSave(app.prisma);
    await ensureCurrentSeason(app.prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it("replaces an ACTIVE club with a brand-new AI team and removes the account", async () => {
    const adminCookie = await registerAndLogin(app, "deladmin");
    await app.prisma.user.update({ where: { email: "deladmin@test.dev" }, data: { isAdmin: true } });
    const victimCookie = await registerAndLogin(app, "delvictim");
    await joinClub(app, victimCookie, "Doomed United");
    const friendCookie = await registerAndLogin(app, "delfriend");
    await joinClub(app, friendCookie, "Survivor SC");

    // Social graph so we can verify cascades.
    const victim = await app.prisma.user.findUniqueOrThrow({ where: { email: "delvictim@test.dev" }, select: { id: true } });
    const friend = await app.prisma.user.findUniqueOrThrow({ where: { email: "delfriend@test.dev" }, select: { id: true } });
    await app.prisma.friendship.create({ data: { userAId: victim.id, userBId: friend.id } });
    await app.prisma.invitation.create({ data: { token: "deltest-invite", inviterUserId: victim.id, inviteeUserId: friend.id } });
    await app.prisma.invitation.create({ data: { token: "deltest-invite2", inviterUserId: friend.id, inviteeUserId: victim.id } });
    await app.prisma.warning.create({ data: { userId: victim.id, reason: "be nice", issuedByAdminUserId: 1 } });
    await app.prisma.userNotification.create({ data: { userId: victim.id, type: "TEST", payloadJson: "{}" } });
    await app.prisma.pushSubscription.create({ data: { userId: victim.id, endpoint: "https://push.example/1", p256dh: "k", auth: "k" } });

    const worldBefore = await loadGlobalWorld(app.prisma);
    if (!worldBefore) throw new Error("world did not load");
    const clubId = worldBefore.world.clubs.find((c) => c.ownerUserId === victim.id)!.id;
    const division = worldBefore.world.competitions.find((c) => c.kind === "division" && c.seasonId === worldBefore.world.mp.seasonId && c.standings[clubId] !== undefined)!;
    expect(division).toBeDefined();
    const standingsBefore = { ...division.standings[clubId] };

    // Guards.
    const badConfirmation = await app.inject({ method: "POST", url: `/api/admin/users/${victim.id}/delete`, headers: { cookie: adminCookie }, payload: { confirmation: "NOPE", reason: "not confirmed" } });
    expect(badConfirmation.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/admin/users/999999/delete", headers: { cookie: adminCookie }, payload: { confirmation: "DELETE", reason: "does not exist" } });
    expect(missing.statusCode).toBe(404);
    const adminSelf = await app.prisma.user.findUniqueOrThrow({ where: { email: "deladmin@test.dev" }, select: { id: true } });
    const deleteAdmin = await app.inject({ method: "POST", url: `/api/admin/users/${adminSelf.id}/delete`, headers: { cookie: adminCookie }, payload: { confirmation: "DELETE", reason: "admins cannot be deleted" } });
    expect(deleteAdmin.statusCode).toBe(400);

    const del = await app.inject({ method: "POST", url: `/api/admin/users/${victim.id}/delete`, headers: { cookie: adminCookie }, payload: { confirmation: "DELETE", reason: "account deletion requested by the community" } });
    expect(del.statusCode).toBe(200);
    expect(del.json().outcome.converted).toBe(true);

    // Account rows are gone.
    expect(await app.prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await app.prisma.session.count({ where: { userId: victim.id } })).toBe(0);
    expect(await app.prisma.account.count({ where: { userId: victim.id } })).toBe(0);
    expect(await app.prisma.friendship.count({ where: { OR: [{ userAId: victim.id }, { userBId: victim.id }] } })).toBe(0);
    expect(await app.prisma.invitation.count({ where: { inviterUserId: victim.id } })).toBe(0);
    expect(await app.prisma.invitation.count({ where: { inviteeUserId: victim.id } })).toBe(0);
    expect(await app.prisma.warning.count({ where: { userId: victim.id } })).toBe(0);
    expect(await app.prisma.userNotification.count({ where: { userId: victim.id } })).toBe(0);
    expect(await app.prisma.pushSubscription.count({ where: { userId: victim.id } })).toBe(0);

    // The club was replaced by an AI team in the same slot: same id, standings
    // preserved, identity regenerated, no owner, no custom identity.
    const worldAfter = await loadGlobalWorld(app.prisma);
    if (!worldAfter) throw new Error("world did not load after deletion");
    const club = worldAfter.world.clubs.find((c) => c.id === clubId);
    expect(club).toBeDefined();
    expect(club!.ownerUserId).toBeNull();
    expect(club!.isHuman).toBe(false);
    expect(club!.name).not.toBe("Doomed United");
    expect(club!.name).toMatch(/ FC$/);
    expect(club!.customLogo).toBeNull();
    expect(club!.cash).toBe(0);
    const divisionAfter = worldAfter.world.competitions.find((c) => c.kind === "division" && c.seasonId === worldAfter.world.mp.seasonId && c.standings[clubId] !== undefined);
    expect(divisionAfter).toBeDefined();
    expect(divisionAfter!.standings[clubId]).toEqual(standingsBefore);
    // The squad is a fresh static roster.
    expect(worldAfter.world.players.filter((p) => p.clubId === clubId).length).toBeGreaterThan(0);
    // The survivor's club is untouched.
    const survivor = worldAfter.world.clubs.find((c) => c.ownerUserId === friend.id);
    expect(survivor).toBeDefined();
    expect(survivor!.name).toBe("Survivor SC");

    // Retry idempotency: the world part is a no-op, the account is already gone.
    const retry = await app.inject({ method: "POST", url: `/api/admin/users/${victim.id}/delete`, headers: { cookie: adminCookie }, payload: { confirmation: "DELETE", reason: "retry after partial failure" } });
    expect(retry.statusCode).toBe(404);

    // Audit trail exists on the current save.
    expect(await app.prisma.adminSchedulerAudit.count({ where: { action: "DELETE_ACCOUNT", targetId: String(victim.id) } })).toBe(1);
  });

  it("removes a non-active club entirely when the deleted account owns one", async () => {
    const adminCookie = await registerAndLogin(app, "deladmin2");
    await app.prisma.user.update({ where: { email: "deladmin2@test.dev" }, data: { isAdmin: true } });
    const victimCookie = await registerAndLogin(app, "delvictim2");
    await joinClub(app, victimCookie, "Queued FC");

    // Lock the season so the club is PROVISIONAL (not in a division).
    const world = await loadGlobalWorld(app.prisma);
    if (!world) throw new Error("world did not load");
    const victim = await app.prisma.user.findUniqueOrThrow({ where: { email: "delvictim2@test.dev" }, select: { id: true } });
    world.world.mp.joinState = "LOCKED";
    world.world.mp.completedRounds = world.world.mp.joinLockRound;
    const victimClub = world.world.clubs.find((c) => c.ownerUserId === victim.id);
    expect(victimClub).toBeDefined();
    victimClub!.competitionState = "PROVISIONAL";
    world.world.mpQueue.push({ clubId: victimClub!.id, source: "NEW_CLUB", queuedAt: Date.now(), preferredSeasonId: world.world.mp.seasonId + 1 });
    const { persistWorld } = await import("../src/services/saveService");
    await persistWorld(app.prisma, world.save.id, world.save.id, world.world, world.save.revision);

    const del = await app.inject({ method: "POST", url: `/api/admin/users/${victim.id}/delete`, headers: { cookie: adminCookie }, payload: { confirmation: "DELETE", reason: "cleanup of an abandoned account" } });
    expect(del.statusCode).toBe(200);
    expect(del.json().outcome.converted).toBe(false);

    const after = await loadGlobalWorld(app.prisma);
    if (!after) throw new Error("world did not load after deletion");
    expect(after.world.clubs.some((c) => c.ownerUserId === victim.id)).toBe(false);
    expect(after.world.players.some((p) => p.clubId !== null && after.world.clubs.every((c) => c.id !== p.clubId))).toBe(false);
    expect(await app.prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
  });
});
