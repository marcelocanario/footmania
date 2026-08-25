import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";

async function setupClub(app: FastifyInstance, username: string) {
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "secret123" },
  });
  expect(register.statusCode).toBe(200);
  const cookie = (register.headers["set-cookie"] as string).split(";")[0];
  // Force a joinable ACTIVE season regardless of what earlier test files did
  // to the shared world clock (same pattern as live.test.ts).
  const { ensureCurrentSeason } = await import("../src/services/mpService");
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  await ensureCurrentSeason(app.prisma);
  const clock = await loadGlobalWorld(app.prisma);
  if (!clock) throw new Error("no global world");
  clock.world.mp.manualRound = 0;
  clock.world.mp.completedRounds = 0;
  clock.world.mp.joinState = "OPEN";
  clock.world.mp.seasonStatus = "ACTIVE";
  await persistWorld(app.prisma, clock.save.id, clock.save.id, clock.world, clock.save.revision);
  const join = await app.inject({
    method: "POST",
    url: "/api/mp/join",
    headers: { cookie },
    payload: {
      clubName: `${username} FC`,
      country: "BRA",
      stadiumName: `${username} Stadium`,
      coachName: `${username} Coach`,
      preferredHours: Array.from({ length: 16 }, (_, i) => i),
    },
  });
  expect(join.statusCode).toBe(200);
  return { cookie, clubId: join.json().clubId as number };
}

/** Put the club's next fixture into live pregame state (mirrors live.test.ts). */
async function startLiveMatch(app: FastifyInstance, clubId: number): Promise<{ matchId: number }> {
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  const { startLiveMatch } = await import("../src/game/world");
  const loaded = await loadGlobalWorld(app.prisma);
  if (!loaded) throw new Error("no global world");
  const world = loaded.world;
  const fixture =
    world.fixtures.find((f) => !f.played && (f.homeClubId === clubId || f.awayClubId === clubId));
  if (!fixture) throw new Error("no upcoming fixture");
  world.matches = world.matches.filter((m) => m.fixtureId !== fixture.id);
  fixture.played = false;
  world.liveMatches = world.liveMatches.filter((s) => s.fixtureId !== fixture.id);
  startLiveMatch(world, fixture);
  await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
  const st = world.liveMatches.find((s) => s.fixtureId === fixture.id)!;
  return { matchId: st.matchId };
}

async function humanSideOf(app: FastifyInstance, matchId: number, clubId: number): Promise<0 | 1> {
  const { loadGlobalWorldReadOnly } = await import("../src/services/saveService");
  const loaded = await loadGlobalWorldReadOnly(app.prisma);
  const st = loaded?.world.liveMatches.find((candidate) => candidate.matchId === matchId);
  if (!st) throw new Error("no live match");
  return st.homeClubId === clubId ? 0 : 1;
}

/** Jump the match clock forward deterministically and persist the round trip. */
async function advanceMinutes(app: FastifyInstance, matchId: number, minutes: number): Promise<void> {
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  const loaded = await loadGlobalWorld(app.prisma);
  if (!loaded) throw new Error("no global world");
  const st = loaded.world.liveMatches.find((candidate) => candidate.matchId === matchId);
  if (!st) throw new Error("no live match");
  st.minute += minutes;
  await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
}

describe("team screen API", () => {
  it("serves any club's public profile without leaking finances, and guards access", async () => {
    const app = buildServer();
    await app.ready();
    try {
      const { cookie, clubId } = await setupClub(app, "profilepage");

      const res = await app.inject({ method: "GET", url: `/api/mp/clubs/${clubId}`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.club.name).toBe("profilepage FC");
      expect(body.club.stadiumName).toBe("profilepage Stadium");
      expect(body.club.kits.home.primary).toBeTruthy();
      // Privacy invariant: no financial or hidden-rating fields anywhere.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('"cash"');
      expect(serialized).not.toContain("eloRating");

      // Unknown clubs are a clean 404; anonymous callers are rejected.
      const missing = await app.inject({ method: "GET", url: "/api/mp/clubs/424242", headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      const anon = await app.inject({ method: "GET", url: `/api/mp/clubs/${clubId}` });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("enforces the live-match tactics cooldown across REST changes and persists it", async () => {
    const app = buildServer();
    await app.ready();
    try {
      const { cookie, clubId } = await setupClub(app, "coolowner");
      const { matchId } = await startLiveMatch(app, clubId);
      const side = await humanSideOf(app, matchId, clubId);

      // First change of the match is always free.
      const first = await app.inject({
        method: "POST",
        url: `/api/matches/${matchId}/tactics`,
        headers: { cookie },
        payload: { style: 1 },
      });
      expect(first.statusCode).toBe(200);

      // An immediate repeat is rejected while the lock is active.
      const blocked = await app.inject({
        method: "POST",
        url: `/api/matches/${matchId}/tactics`,
        headers: { cookie },
        payload: { style: 2 },
      });
      expect(blocked.statusCode).toBe(400);
      expect(String(blocked.json().error)).toMatch(/locked/i);

      // Advance past the cooldown; the persisted lock survives the reload.
      const { MP_CONFIG } = await import("../src/config");
      await advanceMinutes(app, matchId, MP_CONFIG.liveMatchTacticsCooldownMatchMinutes + 1);
      const allowed = await app.inject({
        method: "POST",
        url: `/api/matches/${matchId}/tactics`,
        headers: { cookie },
        payload: { style: 2 },
      });
      expect(allowed.statusCode).toBe(200);
      const state = allowed.json().state;
      expect(state.humanSide === 0 ? state.homeTactics.style : state.awayTactics.style).toBe(2);
      expect(side !== null).toBe(true);
    } finally {
      await app.close();
    }
  });
});
