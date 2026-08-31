import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";
import { createTestSessionCookie } from "./testAuth";

/**
 * Plan §21.5-§21.9: the lineup API must enforce the position rules a forged
 * client can otherwise bypass, expose the visible penalty for a legal but poor
 * deployment, and never leak a numeric position or tactical slot.
 */

async function setupClub(app: FastifyInstance, username: string) {
  const { cookie } = await createTestSessionCookie(app, { name: username, email: `${username}@test.dev` });
  const { ensureCurrentSeason } = await import("../src/services/mpService");
  const { loadGlobalWorld, persistWorld } = await import("../src/services/saveService");
  await ensureCurrentSeason(app.prisma);
  const clock = await loadGlobalWorld(app.prisma);
  if (!clock) throw new Error("no global world");
  clock.world.mp.joinState = "OPEN";
  clock.world.mp.seasonStatus = "ACTIVE";
  await persistWorld(app.prisma, clock.save.id, clock.save.id, clock.world, clock.save.revision);
  const join = await app.inject({
    method: "POST",
    url: "/api/mp/join",
    headers: { cookie },
    payload: {
      clubName: `${username} FC`, country: "BRA", stadiumName: `${username} Stadium`,
      coachName: `${username} Coach`, preferredHours: Array.from({ length: 16 }, (_, i) => i),
    },
  });
  if (join.statusCode !== 200) throw new Error(`join failed: ${join.body}`);
  return { cookie };
}

interface LineupSlot { index: number; key: string; role: string; lane: string; line: string; x: number; y: number; label: string }
interface LineupPlayer { id: number; naturalPosition: string; positionGroup: string; slotIndex: number | null; deployedRole: string | null; rolePenalty: number | null; suitabilityLabel: string; adjustedTacticalRating: number | null }

async function getLineup(app: FastifyInstance, cookie: string, query = "") {
  const res = await app.inject({ method: "GET", url: `/api/club/lineup${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    formation: number; formationName: string; slots: LineupSlot[];
    starters: LineupPlayer[]; subs: LineupPlayer[]; squad: LineupPlayer[];
    penaltyTakerId: number | null; freeKickTakerId: number | null;
    slotPreviews: Array<{ slotIndex: number; deployedRole: string; rolePenalty: number | null; suitabilityLabel: string; adjustedTacticalRating: number | null }>;
    previewPlayerId?: number;
  };
}

describe("lineup API position rules", () => {
  it("returns named slot metadata and per-starter suitability", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi1");
    const view = await getLineup(app, cookie);

    expect(view.slots).toHaveLength(11);
    expect(view.slots[0].role).toBe("GK");
    expect(view.formationName).toEqual(expect.any(String));
    for (const slot of view.slots) {
      expect(typeof slot.role).toBe("string");
      expect(["LEFT", "CENTRE", "RIGHT"]).toContain(slot.lane);
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeLessThanOrEqual(100);
    }
    expect(view.starters).toHaveLength(11);
    view.starters.forEach((p, index) => {
      expect(typeof p.naturalPosition).toBe("string");
      expect(p.slotIndex).toBe(index);
      expect(p.deployedRole).toBe(view.slots[index].role);
      expect(p.rolePenalty).not.toBeNull();
      expect(["Natural", "Comfortable", "Makeshift", "Poor", "Emergency"]).toContain(p.suitabilityLabel);
      expect(p.adjustedTacticalRating).toBeGreaterThan(0);
    });
    // §15.2: the goalkeeper slot always holds a natural goalkeeper.
    expect(view.starters[0].naturalPosition).toBe("GK");
    expect(view.starters.slice(1).some((p) => p.naturalPosition === "GK")).toBe(false);
    await app.close();
  });

  it("never exposes a numeric player position or tactical slot", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi2");
    const raw = await app.inject({ method: "GET", url: "/api/club/lineup", headers: { cookie } });
    const body = raw.json();
    const scan = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${path}[${i}]`));
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          // §15.2/§15.4: no numeric player position, and no tactical-position field at all.
          if (/^(position|naturalPosition|positionGroup|deployedRole|tacPos)$/.test(key)) {
            expect(typeof value, `${path}.${key} must be a name, not a number`).not.toBe("number");
          }
          expect(key).not.toBe("tacPos");
          expect(key).not.toBe("positions");
          scan(value, `${path}.${key}`);
        }
      }
    };
    scan(body, "lineup");
    await app.close();
  });

  it("rejects an outfielder at goalkeeper even when the client bypasses the UI", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi3");
    const view = await getLineup(app, cookie);
    const starters = view.starters.map((p) => p.id);
    const outfielder = view.starters.find((p) => p.naturalPosition !== "GK")!;
    const forged = starters.slice();
    // Swap the goalkeeper out of slot 0 for an outfielder.
    forged[0] = outfielder.id;
    forged[view.starters.findIndex((p) => p.id === outfielder.id)] = starters[0];

    const res = await app.inject({
      method: "POST", url: "/api/club/lineup", headers: { cookie },
      payload: { formation: view.formation, starters: forged, subs: view.subs.map((p) => p.id), penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/goalkeeper/i);
    await app.close();
  });

  it("rejects a natural goalkeeper in an outfield slot", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi4");
    const view = await getLineup(app, cookie);
    const reserveKeeper = view.squad.find((p) => p.naturalPosition === "GK" && p.id !== view.starters[0].id);
    if (!reserveKeeper) return void await app.close(); // squad without a backup GK: nothing to assert
    const forged = view.starters.map((p) => p.id);
    forged[1] = reserveKeeper.id;
    const res = await app.inject({
      method: "POST", url: "/api/club/lineup", headers: { cookie },
      payload: { formation: view.formation, starters: forged, subs: [], penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/goalkeeper/i);
    await app.close();
  });

  it("allows a poor outfield deployment and reports its exact visible penalty", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi5");
    const view = await getLineup(app, cookie);
    // Put an outfielder into the most distant outfield slot available to him,
    // then read the penalty the API reports back.
    const slotRoles = view.slots.map((s) => s.role);
    const stSlot = slotRoles.findIndex((r) => r === "ST");
    const defender = view.starters.find((p) => p.naturalPosition === "LB" || p.naturalPosition === "RB");
    if (stSlot < 0 || !defender) return void await app.close();
    const forged = view.starters.map((p) => p.id);
    const defenderSlot = view.starters.findIndex((p) => p.id === defender.id);
    forged[defenderSlot] = forged[stSlot];
    forged[stSlot] = defender.id;

    const save = await app.inject({
      method: "POST", url: "/api/club/lineup", headers: { cookie },
      payload: { formation: view.formation, starters: forged, subs: view.subs.map((p) => p.id), penaltyTakerId: null, freeKickTakerId: null },
    });
    expect(save.statusCode).toBe(200);
    const after = await getLineup(app, cookie);
    const deployed = after.starters[stSlot];
    expect(deployed.id).toBe(defender.id);
    // LB/RB -> ST is 18 in the shipped matrix: the Emergency band.
    expect(deployed.rolePenalty).toBe(18);
    expect(deployed.suitabilityLabel).toBe("Emergency");
    // Monotonicity for the SAME player: a bigger penalty is a lower rating.
    // His previous slot need not be Natural — the assignment DP may legitimately
    // deploy an LB at RB (penalty 4) — so compare penalties, not assume zero.
    // (Comparing against whoever inherited his old slot would compare two
    // different players and prove nothing.)
    expect(deployed.rolePenalty!).toBeGreaterThan(defender.rolePenalty!);
    expect(deployed.adjustedTacticalRating).toBeLessThan(defender.adjustedTacticalRating!);
    await app.close();
  });

  it("previews every slot for one owned player and rejects a foreign one", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi6");
    const view = await getLineup(app, cookie);
    const keeper = view.starters[0];
    const preview = await getLineup(app, cookie, `?previewPlayerId=${keeper.id}`);
    expect(preview.previewPlayerId).toBe(keeper.id);
    expect(preview.slotPreviews).toHaveLength(11);
    // A natural goalkeeper is Natural in slot 0 and Ineligible everywhere else.
    expect(preview.slotPreviews[0]).toMatchObject({ deployedRole: "GK", rolePenalty: 0, suitabilityLabel: "Natural" });
    for (const slot of preview.slotPreviews.slice(1)) {
      expect(slot.rolePenalty).toBeNull();
      expect(slot.suitabilityLabel).toBe("Ineligible");
      expect(slot.adjustedTacticalRating).toBeNull();
    }
    // Omitting the query yields an empty preview list, not a leak.
    expect((await getLineup(app, cookie)).slotPreviews).toEqual([]);
    const foreign = await app.inject({ method: "GET", url: "/api/club/lineup?previewPlayerId=999999", headers: { cookie } });
    expect(foreign.statusCode).toBe(400);
    await app.close();
  });

  it("previews a formation without mutating club tactics, and rejects a bad one", async () => {
    const app = buildServer();
    await app.ready();
    const { cookie } = await setupClub(app, "lineupapi7");
    const before = await getLineup(app, cookie);
    const other = before.formation === 7 ? 4 : 7;
    const preview = await getLineup(app, cookie, `?formation=${other}&auto=1`);
    expect(preview.formation).toBe(other);
    expect(preview.slots.map((s) => s.role)).not.toEqual(before.slots.map((s) => s.role));
    // The club's own formation is untouched by a preview request.
    expect((await getLineup(app, cookie)).formation).toBe(before.formation);
    for (const bad of ["99", "-1", "abc", "4.5"]) {
      const res = await app.inject({ method: "GET", url: `/api/club/lineup?formation=${bad}`, headers: { cookie } });
      expect(res.statusCode, `formation=${bad}`).toBe(400);
    }
    await app.close();
  });
});
