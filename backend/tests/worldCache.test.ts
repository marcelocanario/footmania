import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import {
  ensureGlobalSave,
  invalidateWorldCache,
  loadGlobalWorld,
  loadGlobalWorldMutable,
  loadGlobalWorldReadOnly,
  persistWorld,
} from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";

const prisma = new PrismaClient();

/**
 * The in-process world cache (`worldCaches` in saveService.ts) is disabled
 * whenever `NODE_ENV === "test"`, so every ordinary test -- including the
 * rest of this repo's 827 unit tests and 98 integration tests -- never
 * exercises the caching/cloning path this file is about. These tests
 * deliberately flip `NODE_ENV` to "production" around the load/persist calls
 * under test, mirroring the existing precedent at
 * persistence.test.ts:178-189, so the cache-sharing logic in
 * `buildCacheWorld` actually runs and can be asserted against.
 */

async function freshGlobalWorld(seed: number) {
  // Wipe any existing global save so tests are deterministic.
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  return { saveId: save.id, world: loaded.world };
}

async function withSeason(saveId: number) {
  const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  initSeason(loaded.world, { year: 2026, month: 1 }, season.seasonId);
  loaded.world.mp.seasonId = season.seasonId;
  await persistWorld(prisma, saveId, saveId, loaded.world);
  return { seasonId: season.seasonId, world: loaded.world };
}

describe("world cache sharing (buildCacheWorld)", () => {
  it("shares unchanged collections by reference and clones only what a mutation touched", async () => {
    const { saveId } = await freshGlobalWorld(90011);
    const { world } = await withSeason(saveId);
    const clubId = world.clubs[0].id;

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      // Prime the cache with a clean load+persist under production caching
      // (the setup above ran under NODE_ENV=test, which never populates it).
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);

      const before = await loadGlobalWorldReadOnly(prisma);
      if (!before) throw new Error("world did not load");

      // Mutate exactly one club's cash; leave every other collection alone.
      const loaded1 = await loadGlobalWorldMutable(prisma);
      if (!loaded1) throw new Error("world did not load");
      const club = loaded1.world.clubs.find((c) => c.id === clubId)!;
      const newCash = club.cash + 12345;
      club.cash = newCash;
      await persistWorld(prisma, loaded1.save.id, loaded1.save.id, loaded1.world, loaded1.save.revision);

      const after = await loadGlobalWorldReadOnly(prisma);
      if (!after) throw new Error("world did not load");

      // Untouched collections: the exact same array reference, proving they
      // were shared from the pristine baseline rather than deep-cloned.
      expect(after.world.players).toBe(before.world.players);
      expect(after.world.competitions).toBe(before.world.competitions);
      expect(after.world.matches).toBe(before.world.matches);
      expect(after.world.fixtures).toBe(before.world.fixtures);
      expect(after.world.news).toBe(before.world.news);

      // The changed collection: a fresh reference (never aliased into the
      // caller's own live, still-mutable object) carrying the new value.
      expect(after.world.clubs).not.toBe(before.world.clubs);
      expect(after.world.clubs.find((c) => c.id === clubId)?.cash).toBe(newCash);
      // The earlier snapshot's club object must be untouched -- proves the
      // cached "before" clubs array was never mutated in place either.
      expect(before.world.clubs.find((c) => c.id === clubId)?.cash).not.toBe(newCash);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("is not corrupted by the caller mutating its working copy after persistWorld returns", async () => {
    const { saveId } = await freshGlobalWorld(90012);
    const { world } = await withSeason(saveId);
    const clubId = world.clubs[0].id;

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded = await loadGlobalWorldMutable(prisma);
      if (!loaded) throw new Error("world did not load");
      const originalCash = loaded.world.clubs.find((c) => c.id === clubId)!.cash;
      await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

      // Mutate the CALLER's own working copy AFTER persisting -- this must
      // never reach the cache. Mirrors routes/game.ts's `withWorld`, which
      // calls `materializeSeasonEvents(app.prisma, loaded.save.id,
      // loaded.world)` on `loaded.world` after `persistWorld` already ran.
      loaded.world.clubs.find((c) => c.id === clubId)!.cash += 999999;

      const readBack = await loadGlobalWorldReadOnly(prisma);
      if (!readBack) throw new Error("world did not load");
      expect(readBack.world.clubs.find((c) => c.id === clubId)?.cash).toBe(originalCash);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("still round-trips correctly on the very first persist (no baseline to diff against)", async () => {
    // buildCacheWorld's `!previous` branch (fresh save, or a stale/missing
    // cache entry) falls back to a full structuredClone -- the original
    // behavior, unconditionally correct, exercised here so it isn't only
    // covered by the fast path above.
    const { saveId } = await freshGlobalWorld(90013);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
      const loaded = await loadGlobalWorldMutable(prisma);
      if (!loaded) throw new Error("world did not load");
      initSeason(loaded.world, { year: 2026, month: 1 }, season.seasonId);
      loaded.world.mp.seasonId = season.seasonId;
      await persistWorld(prisma, saveId, saveId, loaded.world, loaded.save.revision);

      const readBack = await loadGlobalWorldReadOnly(prisma);
      if (!readBack) throw new Error("world did not load");
      expect(readBack.world.mp.seasonId).toBe(season.seasonId);
      expect(readBack.world.clubs.length).toBe(loaded.world.clubs.length);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });
});
