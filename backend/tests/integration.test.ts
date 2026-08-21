import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test.db";
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";

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
      payload: { clubName: "Marcelo FC", country: "BRA", timezone: "America/Sao_Paulo", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join.statusCode).toBe(200);
    const joinBody = join.json();
    expect(joinBody.clubId).toBeTypeOf("number");

    const status = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().ready).toBe(true);
    expect(status.json().club.name).toBe("Marcelo FC");

    const club = await app.inject({ method: "GET", url: "/api/mp/club", headers: { cookie } });
    expect(club.statusCode).toBe(200);
    expect(club.json().snapshot.club.name).toBe("Marcelo FC");
    expect(club.json().snapshot.squad.length).toBeGreaterThan(20);

    const pyramid = await app.inject({ method: "GET", url: "/api/mp/pyramid", headers: { cookie } });
    expect(pyramid.statusCode).toBe(200);
    expect(pyramid.json().seasonKey).toBeTruthy();
    expect(pyramid.json().tiers.length).toBeGreaterThanOrEqual(1);

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
      payload: { clubName: "First FC", country: "BRA", timezone: "America/Sao_Paulo", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
    });
    expect(join1.statusCode).toBe(200);
    const join2 = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie },
      payload: { clubName: "Second FC", country: "BRA", timezone: "America/Sao_Paulo", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
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
    const invitation = await app.inject({ method: "POST", url: "/api/auth/invite", headers: { cookie: inviterCookie } });
    expect(invitation.statusCode).toBe(200);
    const inviteToken = invitation.json().inviteToken;

    const invitee = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "invitee", password: "secret123", inviteToken },
    });
    expect(invitee.statusCode).toBe(200);
    expect(await app.prisma.friendship.count()).toBe(1);
    expect(await app.prisma.invitation.count({ where: { token: inviteToken, acceptedAt: { not: null } } })).toBe(1);
    await app.close();
  });
});
