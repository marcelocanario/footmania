import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test.db";
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";

async function registerAndLogin(app: Awaited<ReturnType<typeof buildServer>>, username: string): Promise<string> {
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "secret123" },
  });
  expect(register.statusCode).toBe(200);
  return (register.headers["set-cookie"] as string).split(";")[0];
}

describe("admin panel features (MOTD / world browsing / moderation)", () => {
  it("guards admin endpoints and round-trips multiple persistent MOTDs", async () => {
    const app = buildServer();
    await app.ready();

    const cookie = await registerAndLogin(app, "motdadmin");

    // Non-admins are rejected before any world access happens.
    const forbidden = await app.inject({ method: "POST", url: "/api/admin/motd", headers: { cookie }, payload: { text: "nope" } });
    expect(forbidden.statusCode).toBe(403);

    await app.prisma.user.update({ where: { username: "motdadmin" }, data: { isAdmin: true } });

    // Posting creates a durable announcement row.
    const post = await app.inject({ method: "POST", url: "/api/admin/motd", headers: { cookie }, payload: { text: "Maintenance tonight" } });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ ok: true, text: "Maintenance tonight" });
    expect(await app.prisma.newsItem.count({ where: { kind: "motd" } })).toBe(1);

    let listing = await app.inject({ method: "GET", url: "/api/admin/motd", headers: { cookie } });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().messages).toHaveLength(1);
    expect(listing.json().messages[0].text).toBe("Maintenance tonight");

    // Posting again appends a second announcement instead of replacing the first.
    const repost = await app.inject({ method: "POST", url: "/api/admin/motd", headers: { cookie }, payload: { text: "Updated message" } });
    expect(repost.statusCode).toBe(200);
    expect(await app.prisma.newsItem.count({ where: { kind: "motd" } })).toBe(2);
    listing = await app.inject({ method: "GET", url: "/api/admin/motd", headers: { cookie } });
    expect(listing.json().messages).toHaveLength(2);
    expect(listing.json().messages[0].text).toBe("Updated message");
    expect(listing.json().messages[1].text).toBe("Maintenance tonight");
    expect(await app.prisma.newsItem.count({ where: { text: "Maintenance tonight" } })).toBe(1);

    // Individual deletion removes only the selected persisted announcement.
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/motd/message?dayIndex=${listing.json().messages[1].dayIndex}&text=${encodeURIComponent("Maintenance tonight")}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(await app.prisma.newsItem.count({ where: { kind: "motd" } })).toBe(1);
    listing = await app.inject({ method: "GET", url: "/api/admin/motd", headers: { cookie } });
    expect(listing.json().messages).toHaveLength(1);
    expect(listing.json().messages[0].text).toBe("Updated message");

    // Validation mirrors the configured maximum.
    const tooLong = await app.inject({ method: "POST", url: "/api/admin/motd", headers: { cookie }, payload: { text: "x".repeat(281) } });
    expect(tooLong.statusCode).toBe(400);

    // Clearing removes every announcement row.
    const cleared = await app.inject({ method: "DELETE", url: "/api/admin/motd", headers: { cookie } });
    expect(cleared.statusCode).toBe(200);
    expect(await app.prisma.newsItem.count({ where: { kind: "motd" } })).toBe(0);

    await app.close();
  });

  it("exposes club moderation context and resets names with a generated default plus warning", async () => {
    const app = buildServer();
    await app.ready();

    const ownerCookie = await registerAndLogin(app, "clubowner2");
    const join = await app.inject({
      method: "POST",
      url: "/api/mp/join",
      headers: { cookie: ownerCookie },
      payload: {
        clubName: "Owner Two United",
        country: "BRA",
        stadiumName: "Two Arena",
        coachName: "Second Coach",
        preferredHours: Array.from({ length: 16 }, (_, i) => i),
      },
    });
    expect(join.statusCode).toBe(200);
    const clubId = join.json().clubId as number;

    const adminCookie = await registerAndLogin(app, "moderationadmin");
    await app.prisma.user.update({ where: { username: "moderationadmin" }, data: { isAdmin: true } });
    const ownerId = await app.prisma.user.findUniqueOrThrow({ where: { username: "clubowner2" }, select: { id: true } });

    // Club detail surfaces the owner, squad and nickname data the UI needs.
    const detail = await app.inject({ method: "GET", url: `/api/admin/clubs/${clubId}`, headers: { cookie: adminCookie } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json().club;
    expect(body).toMatchObject({ id: clubId, name: "Owner Two United", stadiumName: "Two Arena", ownerUserId: ownerId.id, ownerUsername: "clubowner2", ownerBannedAt: null, hasCustomLogo: false });
    expect(body.squadSize).toBeGreaterThan(0);
    expect(body.avgOverall).not.toBeNull();
    expect(Array.isArray(body.nicknamedPlayers)).toBe(true);

    // Deterministic clean-name suggestions follow the filler-AI pattern.
    const suggestion = await app.inject({ method: "GET", url: "/api/admin/suggested-club-name?attempt=0", headers: { cookie: adminCookie } });
    expect(suggestion.statusCode).toBe(200);
    expect(suggestion.json().name).toMatch(/ FC$/);

    // Resetting WITHOUT an explicit name restores a generated default and
    // issues a warning to the owner (adversarial-content cleanup path).
    const reset = await app.inject({
      method: "POST",
      url: "/api/admin/moderation/reset-club-name",
      headers: { cookie: adminCookie },
      payload: { clubId, reason: "inappropriate club name reported by users" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().ok).toBe(true);
    expect(String(reset.json().after)).toMatch(/ FC$/);

    const renamed = await app.prisma.club.findUniqueOrThrow({ where: { saveId_id: { saveId: (await app.prisma.save.findFirstOrThrow({ where: { isGlobal: true }, select: { id: true } })).id, id: clubId } }, select: { name: true, shortName: true } });
    expect(renamed.name).toMatch(/ FC$/);
    expect(renamed.shortName).toBe(renamed.name);

    const warnings = await app.prisma.warning.findMany({ where: { userId: ownerId.id } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain("Club name reset");

    // Unknown clubs are a clean 404.
    const missing = await app.inject({ method: "GET", url: "/api/admin/clubs/999999", headers: { cookie: adminCookie } });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it("reports world analytics with real vs projected quality", async () => {
    const app = buildServer();
    await app.ready();

    const adminCookie = await registerAndLogin(app, "analyticsadmin");
    await app.prisma.user.update({ where: { username: "analyticsadmin" }, data: { isAdmin: true } });

    const res = await app.inject({ method: "GET", url: "/api/admin/analytics", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const analytics = res.json().analytics;
    expect(analytics).not.toBeNull();
    expect(typeof analytics.seasonId).toBe("number");
    expect(analytics.totalDivisions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(analytics.divisions)).toBe(true);
    for (const row of analytics.divisions) {
      expect(row.projectedAvgOverall).toBeGreaterThan(0);
      expect(row.realAvgOverall === null ? row.deltaOverall === null : typeof row.deltaOverall === "number").toBe(true);
    }
    expect(analytics.summary).toMatchObject({ divisionCount: analytics.divisions.length });
    // With squads generated for joined clubs the world average is measurable.
    if (analytics.summary.realAvgOverall !== null) {
      expect(analytics.summary.projectedAvgOverall).not.toBeNull();
    }

    await app.close();
  });
});
