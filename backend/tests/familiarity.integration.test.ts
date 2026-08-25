import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { ensureGlobalSave, loadGlobalWorld, persistWorld, invalidateWorldCache } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { effectiveFamiliarity, setupKey, INITIAL_FAMILIARITY } from "../src/game/familiarity";

const prisma = new PrismaClient();

async function freshGlobalWorld() {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  // A bare generated world ships without clubs; the season initialization
  // fills divisions (humans + AI filler) exactly like production setup.
  const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
  initSeason(loaded.world, { year: 2026, month: 1 }, season.seasonId);
  loaded.world.mp.seasonId = season.seasonId;
  return { saveId: save.id, world: loaded.world };
}

describe("tactical familiarity persistence", () => {
  it("round-trips per-setup familiarity through the database and treats legacy rows as neutral", async () => {
    const { saveId, world } = await freshGlobalWorld();
    const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
    initSeason(world, { year: 2026, month: 1 }, season.seasonId);
    world.mp.seasonId = season.seasonId;

    // Legacy rows (no map) read as neutral before any migration.
    const [legacyClub, drilled] = [world.clubs[0], world.clubs[1]];
    expect(legacyClub.tacticFamiliarity ?? undefined).toBeUndefined();
    expect(effectiveFamiliarity(legacyClub, 999)).toBe(INITIAL_FAMILIARITY);

    const key = setupKey(drilled.tactics);
    const altKey = `${drilled.tactics.formation}-${(drilled.tactics.style + 1) % 3}-0-0`;
    drilled.tacticFamiliarity = {
      [key]: { familiarity: 87.5, lastUsedAbsoluteGameDay: 21 },
      // A second setup the club once drilled but abandoned.
      [altKey]: { familiarity: 33.25, lastUsedAbsoluteGameDay: 4 },
    };

    await persistWorld(prisma, saveId, saveId, world);
    invalidateWorldCache(prisma);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const restored = reloaded!.world.clubs.find((c) => c.id === drilled.id)!;
    expect(restored.tacticFamiliarity?.[key]).toEqual({ familiarity: 87.5, lastUsedAbsoluteGameDay: 21 });
    expect(Object.keys(restored.tacticFamiliarity!).length).toBe(2);
    // No decay at the exact anchor day; later reads decay lazily and stay pure.
    expect(effectiveFamiliarity(restored, 21)).toBe(87.5);
    expect(effectiveFamiliarity(restored, 121)).toBeCloseTo(87.5 * Math.exp(-0.005 * 100), 3);

    // Re-persisting the same world must not duplicate or drift entries.
    const entryCount = Object.keys(restored.tacticFamiliarity!).length;
    await persistWorld(prisma, saveId, saveId, reloaded!.world);
    invalidateWorldCache(prisma);
    const again = await loadGlobalWorld(prisma);
    const restoredAgain = again!.world.clubs.find((c) => c.id === drilled.id)!;
    expect(restoredAgain.tacticFamiliarity![key]).toEqual({ familiarity: 87.5, lastUsedAbsoluteGameDay: 21 });
    expect(Object.keys(restoredAgain.tacticFamiliarity!).length).toBe(entryCount);
  });

  it("corrupt tacticsFamiliarityJson falls back to neutral instead of failing the load", async () => {
    const { saveId, world } = await freshGlobalWorld();
    const target = world.clubs[2] ?? world.clubs[0];
    target.tacticFamiliarity = { [setupKey(target.tactics)]: { familiarity: 64, lastUsedAbsoluteGameDay: null } };
    await persistWorld(prisma, saveId, saveId, world);
    await prisma.club.update({
      where: { saveId_id: { saveId, id: target.id } },
      data: { tacticsFamiliarityJson: "{not json" },
    });
    invalidateWorldCache(prisma);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const brokenRow = reloaded!.world.clubs.find((c) => c.id === target.id)!;
    expect(brokenRow.tacticFamiliarity).toBeUndefined();
    expect(effectiveFamiliarity(brokenRow, 0)).toBe(INITIAL_FAMILIARITY);
  });
});
