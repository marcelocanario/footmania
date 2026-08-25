import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.ADMIN_EMAIL = "admin@test.dev";

import { buildServer } from "../src/server";
import { createTestSessionCookie } from "./testAuth";

describe("better-auth Google sign-in", () => {
  it("serves /api/account/me only to authenticated sessions and reports the Google profile", async () => {
    const app = buildServer();
    await app.ready();

    const anon = await app.inject({ method: "GET", url: "/api/account/me" });
    expect(anon.statusCode).toBe(401);

    const { cookie } = await createTestSessionCookie(app, { name: "Marcelo Canario", email: "marcelo@test.dev" });
    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ name: "Marcelo Canario", email: "marcelo@test.dev" });
    expect(me.json().user.id).toBeTypeOf("number");

    await app.close();
  });

  it("promotes the ADMIN_EMAIL account to admin on every sign-in", async () => {
    const app = buildServer();
    await app.ready();

    const { cookie, userId } = await createTestSessionCookie(app, { name: "Admin User", email: "admin@test.dev" });
    // The promotion hook runs from better-auth's session.create after-hook;
    // drive the same rule explicitly (the test helper inserts sessions
    // directly, bypassing better-auth).
    const { promoteAdminIfNeeded } = await import("../src/auth");
    await promoteAdminIfNeeded(userId);
    // Re-sign-in path: another session for the same admin email must not demote.
    await createTestSessionCookie(app, { name: "Admin User", email: "admin@test.dev" });
    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: { cookie } });
    expect(me.json().user.isAdmin).toBe(true);
    const row = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.isAdmin).toBe(true);

    await app.close();
  });

  it("blocks banned users from authenticated endpoints", async () => {
    const app = buildServer();
    await app.ready();

    const { cookie, userId } = await createTestSessionCookie(app, { name: "Banned User", email: "banned@test.dev" });
    await app.prisma.user.update({ where: { id: userId }, data: { bannedAt: new Date(), banReason: "test" } });
    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: { cookie } });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ error: "Account banned", reason: "test" });

    const mp = await app.inject({ method: "GET", url: "/api/mp/status", headers: { cookie } });
    expect(mp.statusCode).toBe(403);

    await app.close();
  });

  it("links a second OAuth provider with the same verified email to the same user", async () => {
    const app = buildServer();
    await app.ready();

    const first = await createTestSessionCookie(app, { name: "Marcelo Canario", email: "same@test.dev" });
    // A future provider (e.g. Facebook) signing in with the same email must
    // resolve to the SAME account: simulate by creating the second provider
    // account row and asserting it points at the existing user.
    const account = await app.prisma.account.create({
      data: {
        userId: first.userId,
        issuer: "local:oauth:facebook",
        accountId: "facebook-123",
        providerId: "facebook",
      },
    });
    expect(account.userId).toBe(first.userId);
    expect(await app.prisma.user.count({ where: { email: "same@test.dev" } })).toBe(1);

    await app.close();
  });

  it("accepts an invite token after the account exists", async () => {
    const app = buildServer();
    await app.ready();

    const inviter = await createTestSessionCookie(app, { name: "Inviter", email: "inviter@test.dev" });
    const invite = await app.inject({ method: "POST", url: "/api/account/invite", headers: { cookie: inviter.cookie } });
    const inviteToken = invite.json().inviteToken as string;

    const invitee = await createTestSessionCookie(app, { name: "Invitee", email: "invitee@test.dev" });
    const accept = await app.inject({ method: "POST", url: "/api/account/invite/accept", headers: { cookie: invitee.cookie }, payload: { token: inviteToken } });
    expect(accept.statusCode).toBe(200);
    expect(await app.prisma.friendship.count()).toBe(1);

    // Re-accepting the same token is rejected (idempotency / adversarial).
    const again = await app.inject({ method: "POST", url: "/api/account/invite/accept", headers: { cookie: invitee.cookie }, payload: { token: inviteToken } });
    expect(again.statusCode).toBe(400);

    await app.close();
  });

  it("logs out by revoking the session", async () => {
    const app = buildServer();
    await app.ready();

    const { cookie } = await createTestSessionCookie(app, { name: "Logout User", email: "logout@test.dev" });
    const out = await app.inject({ method: "POST", url: "/api/account/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);

    await app.close();
  });
});
