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
  loadGlobalWorldMutableForLiveTick,
  loadGlobalWorldMutableLazy,
  loadGlobalWorldReadOnly,
  persistWorld,
} from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { startLiveMatch } from "../src/game/world";
import { liveMatchProcessor } from "../src/services/jobs/liveMatchProcessor";
import { MP_CONFIG } from "../src/config";

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

/** Age a live match by `minutes` match-minutes so the next worker tick has a
 *  non-zero minute budget to advance (mirrors tests/live.test.ts's
 *  ageLiveMatch, duplicated locally rather than shared since it is a small,
 *  single-purpose DB-round-trip helper -- see that file's own copy). */
async function ageLiveMatch(matchId: number, minutes: number): Promise<void> {
  const loaded = await loadGlobalWorldMutable(prisma);
  if (!loaded) throw new Error("world did not load");
  const st = loaded.world.liveMatches.find((candidate) => candidate.matchId === matchId);
  if (!st) throw new Error("no live match");
  const elapsed = (MP_CONFIG.matchDurationMinutes * 60 * 1000 * minutes) / 90;
  st.lastAdvancedAt = Date.now() - elapsed;
  await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
}

describe("live-match tick fast path (loadGlobalWorldMutableForLiveTick)", () => {
  it("narrows players to only the clubs playing, and refuses to narrow a match close to full time", async () => {
    const { saveId } = await freshGlobalWorld(90021);
    const { world } = await withSeason(saveId);
    const fixture = world.fixtures.find((f) => !f.played)!;
    startLiveMatch(world, fixture);
    const st = world.liveMatches.find((s) => s.fixtureId === fixture.id)!;
    await persistWorld(prisma, saveId, saveId, world, undefined);
    const matchClubIds = new Set([st.homeClubId, st.awayClubId]);
    const totalPlayers = world.players.length;
    const matchPlayers = world.players.filter((p) => p.clubId !== null && matchClubIds.has(p.clubId)).length;
    // Sanity: this world has other clubs' players the narrow path must
    // exclude (a filler-AI division fills to 8 clubs, only 2 of which play
    // this fixture).
    expect(matchPlayers).toBeLessThan(totalPlayers);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);
      await ageLiveMatch(st.matchId, 3);

      const narrow = await loadGlobalWorldMutableForLiveTick(prisma, Date.now());
      expect(narrow).not.toBeNull();
      expect(narrow!.world.players.length).toBe(matchPlayers);
      expect(narrow!.world.players.every((p) => p.clubId !== null && matchClubIds.has(p.clubId))).toBe(true);
      // clubs is shared by reference (never mutated by a non-finishing tick),
      // never narrowed to just the two match clubs.
      expect(narrow!.world.clubs.length).toBe(world.clubs.length);

      // Force the SAME match to look close to full time: the predicate must
      // then refuse to narrow, regardless of how far the clock actually is,
      // since `st.ended` alone is enough to require the full path.
      const loaded1 = await loadGlobalWorldMutable(prisma);
      if (!loaded1) throw new Error("world did not load");
      const st1 = loaded1.world.liveMatches.find((s) => s.matchId === st.matchId)!;
      st1.ended = true;
      await persistWorld(prisma, loaded1.save.id, loaded1.save.id, loaded1.world, loaded1.save.revision);

      const shouldBeNull = await loadGlobalWorldMutableForLiveTick(prisma, Date.now());
      expect(shouldBeNull).toBeNull();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("returns null while NODE_ENV=test, matching the rest of the world cache", async () => {
    const { saveId } = await freshGlobalWorld(90022);
    const { world } = await withSeason(saveId);
    const fixture = world.fixtures.find((f) => !f.played)!;
    startLiveMatch(world, fixture);
    await persistWorld(prisma, saveId, saveId, world, undefined);
    const narrow = await loadGlobalWorldMutableForLiveTick(prisma, Date.now());
    expect(narrow).toBeNull();
  });
});

describe("liveMatchProcessor with the fast path enabled", () => {
  it("advances an ongoing match via the narrow path without touching the cached clubs/players references", async () => {
    const { saveId } = await freshGlobalWorld(90023);
    const { world } = await withSeason(saveId);
    const fixture = world.fixtures.find((f) => !f.played)!;
    startLiveMatch(world, fixture);
    const st = world.liveMatches.find((s) => s.fixtureId === fixture.id)!;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);
      await ageLiveMatch(st.matchId, 3);

      const before = await loadGlobalWorldReadOnly(prisma);
      if (!before) throw new Error("world did not load");
      const minuteBefore = before.world.liveMatches.find((s) => s.matchId === st.matchId)!.minute;

      const result = await liveMatchProcessor(prisma);
      expect(result.changed).toBe(true);

      const after = await loadGlobalWorldReadOnly(prisma);
      if (!after) throw new Error("world did not load");
      // The match actually progressed -- the narrow world was correctly
      // wired into a real simulation, not a no-op.
      const stAfter = after.world.liveMatches.find((s) => s.matchId === st.matchId)!;
      expect(stAfter.ended || stAfter.minute > minuteBefore || stAfter.matchClockSeconds > 0).toBe(true);
      // Every collection a non-finishing tick never touches stayed the exact
      // same reference: proof the narrow path's isolated player mutations
      // never leaked into the shared cache.
      expect(after.world.clubs).toBe(before.world.clubs);
      expect(after.world.players).toBe(before.world.players);
      expect(after.world.competitions).toBe(before.world.competitions);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("finishes a match whose clock has already ended, correctly falling back off the narrow path", async () => {
    const { saveId } = await freshGlobalWorld(90024);
    const { world } = await withSeason(saveId);
    const fixture = world.fixtures.find((f) => !f.played)!;
    startLiveMatch(world, fixture);
    const st = world.liveMatches.find((s) => s.fixtureId === fixture.id)!;
    await persistWorld(prisma, saveId, saveId, world, undefined);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      const st0 = loaded0.world.liveMatches.find((s) => s.matchId === st.matchId)!;
      st0.ended = true;
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);

      const result = await liveMatchProcessor(prisma);
      expect(result.changed).toBe(true);

      const after = await loadGlobalWorldReadOnly(prisma);
      if (!after) throw new Error("world did not load");
      expect(after.world.liveMatches.some((s) => s.matchId === st.matchId)).toBe(false);
      const finishedMatch = after.world.matches.find((m) => m.fixtureId === fixture.id);
      expect(finishedMatch).toBeDefined();
      const comp = after.world.competitions.find((c) => c.id === fixture.competitionId)!;
      const homeRow = comp.standings[fixture.homeClubId];
      expect(homeRow?.played).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });
});

describe("lazy mutable world (loadGlobalWorldMutableLazy)", () => {
  it("shares an untouched collection by reference and clones only what was read or written", async () => {
    const { saveId } = await freshGlobalWorld(90031);
    const { world } = await withSeason(saveId);
    const clubId = world.clubs[0].id;

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);

      const before = await loadGlobalWorldReadOnly(prisma);
      if (!before) throw new Error("world did not load");

      const loaded1 = await loadGlobalWorldMutableLazy(prisma);
      if (!loaded1) throw new Error("world did not load");
      // Touch (read+write) only `clubs`; every other collection is left
      // completely alone by this mutation.
      const club = loaded1.world.clubs.find((c) => c.id === clubId)!;
      const newCash = club.cash + 555;
      club.cash = newCash;
      await persistWorld(prisma, loaded1.save.id, loaded1.save.id, loaded1.world, loaded1.save.revision);

      const after = await loadGlobalWorldReadOnly(prisma);
      if (!after) throw new Error("world did not load");
      // Never touched by this mutation: shared by reference, proving the
      // lazy proxy never cloned them just because they exist.
      expect(after.world.players).toBe(before.world.players);
      expect(after.world.competitions).toBe(before.world.competitions);
      expect(after.world.matches).toBe(before.world.matches);
      expect(after.world.fixtures).toBe(before.world.fixtures);
      expect(after.world.news).toBe(before.world.news);
      // The one touched collection: a fresh reference with the new value.
      expect(after.world.clubs).not.toBe(before.world.clubs);
      expect(after.world.clubs.find((c) => c.id === clubId)?.cash).toBe(newCash);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("returns the same materialized reference on repeated access, so mutations accumulate across statements", async () => {
    const { saveId } = await freshGlobalWorld(90032);
    await withSeason(saveId);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);

      const loaded = await loadGlobalWorldMutableLazy(prisma);
      if (!loaded) throw new Error("world did not load");
      const before = loaded.world.players.length;
      const firstRead = loaded.world.players;
      // A second, independent top-level access to the SAME field must return
      // the SAME array object, not a fresh clone -- otherwise a mutation
      // handler's second statement referencing `world.players` would lose
      // whatever the first statement did to it.
      expect(loaded.world.players).toBe(firstRead);
      const template = loaded.world.players[0];
      loaded.world.players.push({ ...template, id: template.id + 999999 });
      expect(loaded.world.players.length).toBe(before + 1);
      expect(loaded.world.players).toBe(firstRead);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("is not corrupted by the caller mutating its working copy after persistWorld returns", async () => {
    const { saveId } = await freshGlobalWorld(90033);
    const { world } = await withSeason(saveId);
    const clubId = world.clubs[0].id;

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const loaded0 = await loadGlobalWorldMutable(prisma);
      if (!loaded0) throw new Error("world did not load");
      await persistWorld(prisma, loaded0.save.id, loaded0.save.id, loaded0.world, loaded0.save.revision);

      const loaded = await loadGlobalWorldMutableLazy(prisma);
      if (!loaded) throw new Error("world did not load");
      const originalCash = loaded.world.clubs.find((c) => c.id === clubId)!.cash;
      await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);

      // Mutate the CALLER's own lazy world AFTER persisting -- must never
      // reach the cache. Mirrors withWorld calling materializeSeasonEvents
      // on loaded.world after persistWorld already ran.
      loaded.world.clubs.find((c) => c.id === clubId)!.cash += 424242;

      const readBack = await loadGlobalWorldReadOnly(prisma);
      if (!readBack) throw new Error("world did not load");
      expect(readBack.world.clubs.find((c) => c.id === clubId)?.cash).toBe(originalCash);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
  });

  it("falls back to a full clone correctly on the very first persist (no cache yet)", async () => {
    const { saveId } = await freshGlobalWorld(90034);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
      const loaded = await loadGlobalWorldMutableLazy(prisma);
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

  it("falls back to loadGlobalWorldMutable while NODE_ENV=test", async () => {
    const { saveId } = await freshGlobalWorld(90035);
    await withSeason(saveId);
    const loaded = await loadGlobalWorldMutableLazy(prisma);
    if (!loaded) throw new Error("world did not load");
    // Under NODE_ENV=test the cache is disabled entirely, so this must be an
    // ordinary plain world: mutating a whole collection outright (not just
    // one element) has to work exactly like loadGlobalWorldMutable's.
    loaded.world.clubs = loaded.world.clubs.slice(0, 1);
    expect(loaded.world.clubs.length).toBe(1);
    await persistWorld(prisma, saveId, saveId, loaded.world, undefined);
    const readBack = await loadGlobalWorld(prisma);
    if (!readBack) throw new Error("world did not load");
    expect(readBack.world.clubs.length).toBe(1);
  });
});

describe("withWorld routes under the lazy world (real domain code through the proxy)", () => {
  it("tactics and training changes persist correctly and share every other collection by reference", async () => {
    const { buildServer } = await import("../src/server");
    const { createTestSessionCookie } = await import("./testAuth");
    const app = await buildServer();
    try {
      const { cookie, userId } = await createTestSessionCookie(app, { name: "lazyworldtester", email: "lazyworldtester@test.dev" });
      const { ensureCurrentSeason } = await import("../src/services/mpService");
      await ensureCurrentSeason(app.prisma);
      const clock = await loadGlobalWorld(app.prisma);
      if (!clock) throw new Error("no global world");
      clock.world.mp.manualRound = 0;
      clock.world.mp.completedRounds = 0;
      clock.world.mp.joinState = "OPEN";
      clock.world.mp.seasonStatus = "ACTIVE";
      await persistWorld(app.prisma, clock.save.id, clock.save.id, clock.world, clock.save.revision);

      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        invalidateWorldCache(app.prisma);
        const join = await app.inject({
          method: "POST",
          url: "/api/mp/join",
          headers: { cookie },
          payload: { clubName: "Lazy World FC", country: "BRA", stadiumName: "Lazy Stadium", coachName: "Lazy Coach", preferredHours: Array.from({ length: 16 }, (_, i) => i) },
        });
        expect(join.statusCode).toBe(200);
        const clubId = join.json().clubId as number;

        const before = await loadGlobalWorldReadOnly(app.prisma);
        if (!before) throw new Error("world did not load");

        // Two different withWorld-wrapped routes in a row, exercising real
        // domain code (including publishNews, which mutates world.news) on
        // the lazy world, not a hand-rolled mutation.
        const tactics = await app.inject({
          method: "POST",
          url: "/api/club/tactics",
          headers: { cookie },
          payload: { style: 1, pressing: 2, direction: 1 },
        });
        expect(tactics.statusCode).toBe(200);

        const training = await app.inject({
          method: "POST",
          url: "/api/club/training",
          headers: { cookie },
          payload: { focus: "primary" },
        });
        expect(training.statusCode).toBe(200);

        const after = await loadGlobalWorldReadOnly(app.prisma);
        if (!after) throw new Error("world did not load");
        const club = after.world.clubs.find((c) => c.id === clubId)!;
        expect(club.tactics.style).toBe(1);
        expect(club.tactics.pressing).toBe(2);
        expect(club.tactics.direction).toBe(1);
        expect(club.trainingFocus).toBe("primary");
        // The tactics route published a news item, so world.news correctly
        // diverges; collections neither route touches must still be shared.
        expect(after.world.matches).toBe(before.world.matches);
        expect(after.world.fixtures).toBe(before.world.fixtures);
        expect(after.world.competitions).toBe(before.world.competitions);
        expect(after.world.marketBids).toBe(before.world.marketBids);
        expect(after.world.transferAuctions).toBe(before.world.transferAuctions);
        expect(after.world.seasonHistory).toBe(before.world.seasonHistory);
        expect(userId).toBeGreaterThan(0);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
        invalidateWorldCache(app.prisma);
      }
    } finally {
      await app.close();
    }
  });
});
