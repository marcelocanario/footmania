import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-persist.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { generateWorld } from "../src/game/worldgen";
import { loadGlobalWorld, persistWorld, ensureGlobalSave, StaleWorldError } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { applyDevelopment } from "../src/game/player";
import { initSeason, createDivision, ensureDivisionFull, generateDivisionFixtures, rebuildTierDivisions } from "../src/game/multiplayer";
import { gameConfig } from "../src/config";

const prisma = new PrismaClient();

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

describe("global multiplayer world persistence", () => {
  it("round-trips clubs, players, fixtures and mp state through the database", async () => {
    const { saveId } = await freshGlobalWorld(4242);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const fixtures = generateDivisionFixtures(world, div, { year: 2026, month: 1 });
    world.fixtures.push(...fixtures);
    world.mpQueue.push({ clubId: world.clubs[0].id, source: "NEW_CLUB", queuedAt: Date.now(), preferredSeasonId: seasonId });
    world.seasonAllocations.push({ clubId: world.clubs[0].id, seasonId, type: "PROVISIONAL_NEXT_SEASON", amount: 5_000_000, issuedAt: Date.now() });

    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.world.clubs.length).toBe(world.clubs.length);
    expect(reloaded!.world.players.length).toBe(world.players.length);
    expect(reloaded!.world.competitions.length).toBe(world.competitions.length);
    expect(reloaded!.world.fixtures.length).toBe(world.fixtures.length);
    expect(reloaded!.world.mpQueue.length).toBe(1);
    expect(reloaded!.world.seasonAllocations.length).toBe(1);
    expect(reloaded!.world.seasonAllocations[0].type).toBe("PROVISIONAL_NEXT_SEASON");
  });

  it("round-trips live match state (multiple) and records player minutes on finish", async () => {
    const { saveId } = await freshGlobalWorld(31337);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const home = world.clubs[0];
    const away = world.clubs[1];
    const st = createLiveMatchState(world.rng, home, away, world.players, {
      matchId: 990001,
      fixtureId: 990001,
      competitionId: div.id,
      homeNeutral: false,
    });
    tickLiveMatch(world.rng, home, away, world.players, st, 40, { ignoreHalfTime: true });
    world.liveMatches = [st];
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const st2 = reloaded!.world.liveMatches.find((s) => s.matchId === 990001);
    expect(st2).not.toBeNull();
    expect(st2!.playerMinutes).toEqual(st.playerMinutes);

    // Finalize via the multiplayer path: minutes land on players.
    const { finalizeLiveMatch } = await import("../src/game/world");
    const home2 = reloaded!.world.clubs.find((c) => c.id === home.id)!;
    const away2 = reloaded!.world.clubs.find((c) => c.id === away.id)!;
    tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 200, { ignoreHalfTime: true });
    finalizeLiveMatch(reloaded!.world, st2!);
    const onPitchId = st2!.homeOn[0];
    const p = reloaded!.world.players.find((x) => x.id === onPitchId)!;
    expect(p.recentMinutes.length).toBeGreaterThan(0);
  });

  it("keeps the release clause in sync after development ticks and round-trips", async () => {
    const { saveId } = await freshGlobalWorld(555);
    const { world } = await withSeason(saveId);
    const club = world.clubs[0];
    const p = world.players.find((x) => x.clubId === club.id && !x.isYouth)!;
    for (let day = 1; day <= 10; day++) applyDevelopment(world.rng, p, club, day);
    const expected = Math.round(p.salary * (p.contractDays / gameConfig.seasonDays) * 0.5);
    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    const p2 = reloaded!.world.players.find((x) => x.id === p.id)!;
    expect(p2.releaseClause).toBe(expected);
  });

  it("round-trips normalized memberships, club-seasons and activity records", async () => {
    const { saveId } = await freshGlobalWorld(808);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const members = Object.keys(div.standings).map(Number);
    world.mpMemberships = members.map((clubId, i) => ({
      divisionId: div.id,
      clubId,
      slotNumber: i + 1,
      isFillerAI: i >= 5,
      replacedClubId: null,
      joinedAt: Date.now(),
    }));
    world.mpClubSeasons = members.map((clubId, i) => ({
      clubId,
      seasonId,
      divisionId: div.id,
      tier: 1,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      promotionStatus: "NONE",
      relegationStatus: "NONE",
    }));
    world.mpActivities.push({ userId: 1, clubId: members[0], activityType: "tactics", occurredAt: Date.now(), metadata: null });
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.world.mpMemberships.length).toBe(members.length);
    expect(reloaded!.world.mpClubSeasons.length).toBe(members.length);
    expect(reloaded!.world.mpActivities.length).toBe(1);
    expect(reloaded!.world.mpActivities[0].activityType).toBe("tactics");
    expect(reloaded!.world.mpMemberships[0].slotNumber).toBe(1);
  });

  it("rejects a stale revision write and bumps the revision on success", async () => {
    const { saveId } = await freshGlobalWorld(707);
    const first = await loadGlobalWorld(prisma);
    expect(first).not.toBeNull();
    const rev0 = first!.save.revision;

    // Simulate a concurrent writer: mutate + persist the world first.
    const second = await loadGlobalWorld(prisma);
    expect(second).not.toBeNull();
    second!.world.mp.completedRounds = 3;
    await persistWorld(prisma, saveId, saveId, second!.world, second!.save.revision);

    // The first writer now holds a stale world/revision.
    await expect(persistWorld(prisma, saveId, saveId, first!.world, rev0)).rejects.toBeInstanceOf(StaleWorldError);

    // Revision was incremented by the successful write.
    const after = await loadGlobalWorld(prisma);
    expect(after).not.toBeNull();
    expect(after!.save.revision).toBeGreaterThan(rev0);
  });
});
