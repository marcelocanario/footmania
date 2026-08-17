import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-persist.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { createSaveRecord, loadWorld, persistWorld } from "../src/services/saveService";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { advance, finalizeLiveMatch } from "../src/game/world";
import { applyDevelopment } from "../src/game/player";

const prisma = new PrismaClient();

async function freshSave(seed: number) {
  const user = await prisma.user.create({ data: { username: `persist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, passwordHash: "x" } });
  const created = await createSaveRecord(prisma, user.id, "persist-test", seed);
  const loaded = await loadWorld(prisma, created.id, user.id);
  if (!loaded) throw new Error("world did not load");
  return { user, saveId: created.id, world: loaded.world };
}

async function teardown(userId: number) {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

describe("development persistence", () => {
  it("round-trips development profiles and recent minutes through the database", async () => {
    const { user, saveId, world } = await freshSave(777);
    try {
      const p = world.players.find((x) => x.clubId !== null)!;
      p.recentMinutes = [90, 75, 45, 0, 90];
      await persistWorld(prisma, saveId, user.id, world);

      const reloaded = await loadWorld(prisma, saveId, user.id);
      expect(reloaded).not.toBeNull();
      const p2 = reloaded!.world.players.find((x) => x.id === p.id)!;
      expect(p2.developmentProfile).toEqual(p.developmentProfile);
      expect(p2.recentMinutes).toEqual([90, 75, 45, 0, 90]);
    } finally {
      await teardown(user.id);
    }
  });

  it("backfills profiles deterministically and in range when columns are missing", async () => {
    const { user, saveId } = await freshSave(4242);
    try {
      await prisma.player.updateMany({
        where: { saveId },
        data: { declineStartAge: null, developmentRate: null, developmentVolatility: null, recentMinutesJson: null },
      });
      const first = await loadWorld(prisma, saveId, user.id);
      const second = await loadWorld(prisma, saveId, user.id);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      for (const p of first!.world.players) {
        expect(p.developmentProfile.declineStartAge).toBeGreaterThanOrEqual(24);
        expect(p.developmentProfile.declineStartAge).toBeLessThanOrEqual(38);
        expect(p.developmentProfile.developmentRate).toBeGreaterThanOrEqual(0.6);
        expect(p.developmentProfile.developmentRate).toBeLessThanOrEqual(1.4);
        expect(p.developmentProfile.developmentVolatility).toBeGreaterThanOrEqual(0.03);
        expect(p.developmentProfile.developmentVolatility).toBeLessThanOrEqual(0.2);
        expect(p.recentMinutes).toEqual([]);
        const twin = second!.world.players.find((x) => x.id === p.id)!;
        expect(twin.developmentProfile).toEqual(p.developmentProfile);
      }
    } finally {
      await teardown(user.id);
    }
  });

  it("preserves mid-match minutes across save/load and records them on finish", async () => {
    const { user, saveId, world } = await freshSave(31337);
    try {
      world.humanClubId = world.clubs[0].id;
      const home = world.clubs[0];
      const away = world.clubs[1];
      const st = createLiveMatchState(world.rng, home, away, world.players, {
        matchId: 990001,
        fixtureId: 990001,
        competitionId: world.competitions[0].id,
        homeNeutral: false,
      });
      tickLiveMatch(world.rng, home, away, world.players, st, 40, { ignoreHalfTime: true });
      const snapshot = { ...st.playerMinutes };
      world.liveMatch = st;
      await persistWorld(prisma, saveId, user.id, world);

      const reloaded = await loadWorld(prisma, saveId, user.id);
      expect(reloaded).not.toBeNull();
      const st2 = reloaded!.world.liveMatch;
      expect(st2).not.toBeNull();
      expect(st2!.playerMinutes).toEqual(snapshot);

      // Resume the match after reload: minutes keep accumulating.
      const home2 = reloaded!.world.clubs.find((c) => c.id === home.id)!;
      const away2 = reloaded!.world.clubs.find((c) => c.id === away.id)!;
      tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 200, { ignoreHalfTime: true });
      finalizeLiveMatch(reloaded!.world);
      const onPitchId = st2!.homeOn[0];
      const p = reloaded!.world.players.find((x) => x.id === onPitchId)!;
      expect(p.recentMinutes.length).toBeGreaterThan(0);
      expect(p.recentMinutes[0]).toBeGreaterThan(40);
    } finally {
      await teardown(user.id);
    }
  });

  it("keeps the release clause proportional to the player's own factor after development ticks", async () => {
    const { user, saveId, world } = await freshSave(555);
    try {
      const club = world.clubs[0];
      const p = world.players.find((x) => x.clubId === club.id && !x.isYouth)!;
      const factor = p.releaseClauseFactor;
      expect(Number.isFinite(factor)).toBe(true);
      for (let day = 1; day <= 10; day++) {
        applyDevelopment(world.rng, p, club, day);
      }
      expect(p.releaseClauseFactor).toBe(factor);
      expect(p.releaseClause).toBe(Math.round(p.value * factor));
      await persistWorld(prisma, saveId, user.id, world);
      const reloaded = await loadWorld(prisma, saveId, user.id);
      const p2 = reloaded!.world.players.find((x) => x.id === p.id)!;
      expect(p2.releaseClauseFactor).toBeCloseTo(p.releaseClause / p.value, 6);
    } finally {
      await teardown(user.id);
    }
  });
});