import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test.db";
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import { ensureSeasonRow } from "../src/services/mpService";
import { loadGlobalWorld } from "../src/services/saveService";

describe("API flow", () => {
  it("registers, joins with a club, and sees its status and snapshot", async () => {
    const app = buildServer();
    await app.ready();

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "player1", password: "secret123" },
    });
    expect(register.statusCode).toBe(200);
    const setCookie = register.headers["set-cookie"] as string;
    const cookie = setCookie.split(";")[0];

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("player1");

    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Marcelo FC", country: "BRA", stadiumName: "Marcelo Stadium", coachName: "Marcelo Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(200);
    const joinBody = join.json();
    expect(joinBody.clubId).toBeTypeOf("number");

    const save = await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true }, select: { id: true, mpStateJson: true } });
    const mp = JSON.parse(save.mpStateJson ?? "{}") as { seasonId: number; seasonYear: number; seasonMonth: number };
    const nextStart = new Date(Date.UTC(mp.seasonMonth === 12 ? mp.seasonYear + 1 : mp.seasonYear, mp.seasonMonth % 12, 1));
    const nextSeason = await ensureSeasonRow(app.prisma, { year: nextStart.getUTCFullYear(), month: nextStart.getUTCMonth() + 1 });
    const clubKey = { saveId: save.id, id: joinBody.clubId as number };
    await app.prisma.club.update({ where: { saveId_id: clubKey }, data: { abandonmentEligibleAt: BigInt(Date.now()) } });
    await app.prisma.mpAllocation.create({ data: { clubId: clubKey.id, seasonId: nextSeason.seasonId, type: "PROVISIONAL_NEXT_SEASON", amount: 5_000_000 } });
    await app.prisma.save.update({
      where: { id: save.id },
      data: {
        seasonHistoryJson: JSON.stringify([{
          seasonId: 1,
          seasonKey: "2026-01",
          archivedAt: Date.now(),
          divisions: [{ divisionId: 1, divisionName: "1", tier: 1, groupIndex: 0, standings: [{ clubId: clubKey.id, clubName: "Marcelo FC", played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 }] }],
        }]),
      },
    });

    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().ready).toBe(true);
    expect(status.json().club.name).toBe("Marcelo FC");
    expect(status.json().club.reservedNextSeasonAllocation).toMatchObject({ seasonId: nextSeason.seasonId, amount: 5_000_000 });
    expect(status.json().club.inactivity).toEqual({
      eligible: true,
      removedAtRollover: true,
      note: "Your club may lose its league position at the end of the season if inactivity continues.",
    });

    const club = await app.inject({ method: "GET", url: "/api/mp/club", headers: { cookie } });
    expect(club.statusCode).toBe(200);
    expect(club.json().snapshot.club.name).toBe("Marcelo FC");
    expect(club.json().snapshot.club.coachName).toBe("Marcelo Coach");
    expect(club.json().snapshot.squad.length).toBeGreaterThan(20);

    const pyramid = await app.inject({ method: "GET", url: "/api/mp/pyramid", headers: { cookie } });
    expect(pyramid.statusCode).toBe(200);
    expect(pyramid.json().seasonKey).toBeTruthy();
    expect(pyramid.json().tiers.length).toBeGreaterThanOrEqual(1);

    const history = await app.inject({ method: "GET", url: "/api/mp/history", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().seasons[0].seasonKey).toBe("2026-01");
    expect(history.json().seasons[0].divisions[0].standings[0].isMine).toBe(true);

    const removedRecordsEndpoint = await app.inject({ method: "GET", url: "/api/records?limit=5", headers: { cookie } });
    expect(removedRecordsEndpoint.statusCode).toBe(404);

    await app.close();
  });

  it("requires a stadium name when joining", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "stadiumrequired", password: "secret123" },
    });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Stadium FC", country: "BRA", coachName: "Stadium Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(400);
    await app.close();
  });

  it("requires a coach name when joining", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "coachrequired", password: "secret123" },
    });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Coach FC", country: "BRA", stadiumName: "Coach Stadium", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(400);
    await app.close();
  });

  it("limits Pro coach name changes to once per season", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "coachpro", password: "secret123" },
    });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    await app.prisma.user.update({ where: { id: register.json().user.id }, data: { isPro: true } });
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Coach Pro FC", country: "BRA", stadiumName: "Coach Pro Stadium", coachName: "First Manager", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(200);

    const first = await app.inject({ method: "PUT", url: "/api/mp/club/profile", headers: { cookie }, payload: { coachName: "Second Manager" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "PUT", url: "/api/mp/club/profile", headers: { cookie }, payload: { coachName: "Third Manager" } });
    expect(second.statusCode).toBe(400);

    const loaded = await (await import("../src/services/saveService")).loadGlobalWorld(app.prisma);
    if (!loaded) throw new Error("world unavailable");
    loaded.world.mp.seasonMonth = loaded.world.mp.seasonMonth === 12 ? 1 : loaded.world.mp.seasonMonth + 1;
    if (loaded.world.mp.seasonMonth === 1) loaded.world.mp.seasonYear += 1;
    await (await import("../src/services/saveService")).persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
    const nextSeason = await app.inject({ method: "PUT", url: "/api/mp/club/profile", headers: { cookie }, payload: { coachName: "Third Manager" } });
    expect(nextSeason.statusCode).toBe(200);
    await app.close();
  });

  it("rejects coach name changes from non-Pro users", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "coachregular", password: "secret123" },
    });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Regular FC", country: "BRA", stadiumName: "Regular Stadium", coachName: "Original Manager", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(200);
    const edit = await app.inject({ method: "PUT", url: "/api/mp/club/profile", headers: { cookie }, payload: { coachName: "Attempted Manager" } });
    expect(edit.statusCode).toBe(403);
    await app.close();
  });

  it("rejects bad credentials", async () => {
    const app = buildServer();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("prevents a user from joining twice", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "player2", password: "secret123" },
    });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    const join1 = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "First FC", country: "BRA", stadiumName: "First Stadium", coachName: "First Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join1.statusCode).toBe(200);
    const join2 = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Second FC", country: "BRA", stadiumName: "Second Stadium", coachName: "Second Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join2.statusCode).toBe(409);
    await app.close();
  });

  it("accepts an invitation by creating an idempotent friendship at signup", async () => {
    const app = buildServer();
    await app.ready();
    const inviter = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "inviter", password: "secret123" },
    });
    const inviterCookie = (inviter.headers["set-cookie"] as string).split(";")[0];
    const inviterId = inviter.json().user.id;
    const invitation = await app.inject({ method: "POST", url: "/api/auth/invite", headers: { cookie: inviterCookie } });
    expect(invitation.statusCode).toBe(200);
    const inviteToken = invitation.json().inviteToken;

    // Friendship mutations must bump Save.revision so cached worlds (this and
    // other processes) rebuild with the new edge before the next regrouping.
    const revisionBefore = (await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true } })).revision;
    const invitee = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "invitee", password: "secret123", inviteToken },
    });
    expect(invitee.statusCode).toBe(200);
    expect(await app.prisma.friendship.count()).toBe(1);
    expect(await app.prisma.invitation.count({ where: { token: inviteToken, acceptedAt: { not: null } } })).toBe(1);
    const revisionAfter = (await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true } })).revision;
    expect(revisionAfter).toBeGreaterThan(revisionBefore);
    // The rebuilt world materializes the fresh edge for regrouping. Scoped to
    // this pair: parallel test files share the global save and may hold their
    // own edges.
    const inviteeId = invitee.json().user.id;
    const newEdge = { userAId: Math.min(inviterId, inviteeId), userBId: Math.max(inviterId, inviteeId) };
    expect((await loadGlobalWorld(app.prisma))?.world.friendships ?? []).toContainEqual(newEdge);
    await app.close();
  });

  it("lists and removes friends and lists and revokes pending invitations", async () => {
    const app = buildServer();
    await app.ready();

    // Inviter generates two links, revokes one, keeps the other.
    const inviter = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "friendhub", password: "secret123" } });
    const inviterCookie = (inviter.headers["set-cookie"] as string).split(";")[0];
    const inviterId = inviter.json().user.id;
    const keep = await app.inject({ method: "POST", url: "/api/auth/invite", headers: { cookie: inviterCookie } });
    const drop = await app.inject({ method: "POST", url: "/api/auth/invite", headers: { cookie: inviterCookie } });
    expect(await app.prisma.invitation.count({ where: { inviterUserId: inviterId, acceptedAt: null } })).toBe(2);
    const revoked = await app.inject({ method: "DELETE", url: `/api/auth/invitations/${drop.json().inviteToken}`, headers: { cookie: inviterCookie } });
    expect(revoked.statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/auth/invitations", headers: { cookie: inviterCookie } });
    expect(listed.json().invitations.map((i: { token: string }) => i.token)).toEqual([keep.json().inviteToken]);

    // Invitee signs up through the kept link; both now list each other.
    const invitee = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "friendtarget", password: "secret123", inviteToken: keep.json().inviteToken },
    });
    expect(invitee.statusCode).toBe(200);
    const inviteeId = invitee.json().user.id;
    const pairFilter = { userAId: Math.min(inviterId, inviteeId), userBId: Math.max(inviterId, inviteeId) };
    const inviteeJoin = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie: (invitee.headers["set-cookie"] as string).split(";")[0] },
      payload: { clubName: "Target FC", country: "BRA", stadiumName: "Target Stadium", coachName: "Target Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(inviteeJoin.statusCode).toBe(200);
    const friends = await app.inject({ method: "GET", url: "/api/auth/friends", headers: { cookie: inviterCookie } });
    expect(friends.statusCode).toBe(200);
    expect(friends.json().friends).toHaveLength(1);
    expect(friends.json().friends[0]).toMatchObject({ username: "friendtarget", clubName: "Target FC" });

    // Adversarial: a third user cannot remove someone else's friendship...
    const stranger = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "stranger", password: "secret123" } });
    const strangerCookie = (stranger.headers["set-cookie"] as string).split(";")[0];
    const forbidden = await app.inject({ method: "DELETE", url: `/api/auth/friends/${inviterId}`, headers: { cookie: strangerCookie } });
    expect(forbidden.statusCode).toBe(404);
    // The stranger's attempt must not touch the inviter/invitee edge (other
    // tests in this file create their own friendships, so scope the count).
    expect(await app.prisma.friendship.count({ where: pairFilter })).toBe(1);
    // ...or revoke someone else's used invitation token.
    const foreignToken = await app.inject({ method: "DELETE", url: `/api/auth/invitations/${keep.json().inviteToken}`, headers: { cookie: strangerCookie } });
    expect(foreignToken.statusCode).toBe(404);

    // Either side may sever its own friendship; the other side then sees none.
    const inviteeCookie = (invitee.headers["set-cookie"] as string).split(";")[0];
    const revisionBeforeSever = (await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true } })).revision;
    const sever = await app.inject({ method: "DELETE", url: `/api/auth/friends/${inviterId}`, headers: { cookie: inviteeCookie } });
    expect(sever.statusCode).toBe(200);
    // Removal bumps the revision so cached worlds drop the severed edge too.
    expect((await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true } })).revision).toBeGreaterThan(revisionBeforeSever);
    // Scoped to the severed pair (parallel files share the global save).
    const severedEdge = { userAId: Math.min(inviterId, inviteeId), userBId: Math.max(inviterId, inviteeId) };
    const remainingEdges = ((await loadGlobalWorld(app.prisma))?.world.friendships ?? [])
      .filter((edge) => edge.userAId === severedEdge.userAId && edge.userBId === severedEdge.userBId);
    expect(remainingEdges).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/auth/friends", headers: { cookie: inviterCookie } })).json().friends).toHaveLength(0);

    await app.close();
  });

  it("toggles friend-grouping consent on the owner's club", async () => {
    const app = buildServer();
    await app.ready();
    const register = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "consentuser", password: "secret123" } });
    const cookie = (register.headers["set-cookie"] as string).split(";")[0];
    await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Consent FC", country: "BRA", stadiumName: "Consent Stadium", coachName: "Consent Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });

    const off = await app.inject({ method: "PUT", url: "/api/mp/club/friend-grouping", headers: { cookie }, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    let status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie } });
    expect(status.json().club.friendGroupingOptIn).toBe(false);

    const on = await app.inject({ method: "PUT", url: "/api/mp/club/friend-grouping", headers: { cookie }, payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie } });
    expect(status.json().club.friendGroupingOptIn).toBe(true);

    await app.close();
  });

  it("protects direct multiplayer read endpoints", async () => {
    const app = buildServer();
    await app.ready();

    const history = await app.inject({ method: "GET", url: "/api/mp/history" });
    expect(history.statusCode).toBe(401);
    await app.close();
  });
});
