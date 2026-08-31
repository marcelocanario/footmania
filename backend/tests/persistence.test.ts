import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { EVENT_CODES } from "../src/game/constants";
import { createHumanClub } from "../src/game/worldgen";
import { loadGlobalWorld, loadGlobalWorldMutable, persistLiveMatchState, persistWorld, ensureGlobalSave, invalidateWorldCache, StaleWorldError } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { readMpStatus } from "../src/services/readService";
import { applyDevelopment } from "../src/game/player";
import { initSeason, createDivision, ensureDivisionFull, generateDivisionFixtures, rebuildTierDivisions, highestRankedReplaceableAI, placeNewClub } from "../src/game/multiplayer";
import { applyMaxBid, createTransferAuction } from "../src/game/market";
import { MP_CONFIG, gameConfig } from "../src/config";
import { budgetSettings, tierBudget } from "../src/game/budget";
import { calculatePlayerValue, remainingSeasons } from "../src/game/economy";
import { leagueTurnKey } from "../src/services/seasonCalendar";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NEWS_SUBJECTS, publishNews } from "../src/game/news";
import { msg, isMessageRef } from "../src/i18n/catalog";

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
    world.clubs[0].eloRating = 1538.427;
    world.clubs[0].eloRatedMatches = 3;
    world.clubEloEvents = [{
      id: 880001,
      matchId: 880000,
      clubId: world.clubs[0].id,
      opponentClubId: world.clubs[1].id,
      ratingBefore: 1500,
      ratingAfter: 1538.427,
      delta: 38.427,
      expectedScore: 0.5,
      actualScore: 1,
      createdAt: Date.now(),
    }];

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
    expect(reloaded!.world.clubs[0].eloRating).toBeCloseTo(1538.427, 6);
    expect(reloaded!.world.clubEloEvents).toHaveLength(1);
    expect(reloaded!.world.clubEloEvents![0].matchId).toBe(880000);
    expect(reloaded!.world.nextId).toBeGreaterThan(880001);
  });

  it("round-trips per-turn yellow-card discipline state on players", async () => {
    const { saveId } = await freshGlobalWorld(4243);
    const { world } = await withSeason(saveId);
    const player = world.players[0];
    player.turnYellows = 1;
    player.yellowsTurnKey = leagueTurnKey(world.mp.seasonNumber ?? 0, 3);
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const restored = reloaded!.world.players.find((p) => p.id === player.id)!;
    expect(restored.turnYellows).toBe(1);
    expect(restored.yellowsTurnKey).toBe(player.yellowsTurnKey);

    // A stale turn key must survive verbatim: expiry is computed from the
    // current turn at booking time, never rewritten during persistence.
    player.yellowsTurnKey = leagueTurnKey((world.mp.seasonNumber ?? 0) + 4, 1);
    await persistWorld(prisma, saveId, saveId, world);
    const again = await loadGlobalWorld(prisma);
    expect(again!.world.players.find((p) => p.id === player.id)!.yellowsTurnKey).toBe(player.yellowsTurnKey);
  });

  it("round-trips friend-grouping consent and converts legacy local preferred hours once", async () => {
    const { saveId } = await freshGlobalWorld(4711);
    const { world } = await withSeason(saveId);
    // Club.ownerUserId has a real FK: back the human club with a User row.
    await prisma.user.deleteMany({ where: { id: 4700 } });
    await prisma.user.create({ data: { id: 4700, name: "Persist Consent", email: "persist-consent@test.dev", emailVerified: true } });
    const club = createHumanClub(world, { userId: 4700, clubName: "Consent FC", country: "BRA" });
    club.friendGroupingOptIn = false;
    await persistWorld(prisma, saveId, saveId, world);

    // Simulate a legacy row (plan 9): timezone marker still present and
    // preferredHours stored as LOCAL wall-clock slots.
    await prisma.club.update({
      where: { saveId_id: { saveId, id: club.id } },
      data: { timezone: "Asia/Tokyo", preferredHoursJson: JSON.stringify([38, 39, 2]) },
    });

    const firstLoad = await loadGlobalWorld(prisma);
    expect(firstLoad).not.toBeNull();
    const migrated = firstLoad!.world.clubs.find((c) => c.id === club.id)!;
    // Tokyo is UTC+9 year-round: 19:00 local -> 10:00 UTC (slot 20),
    // 19:30 -> slot 21, 01:00 -> 16:00 UTC of the previous day (slot 32).
    expect(migrated.preferredHours).toEqual([20, 21, 32]);
    expect(migrated.friendGroupingOptIn).toBe(false);

    // Read paths share the same one-time conversion so an un-migrated row can
    // never serve its local wall-clock slots mislabeled as UTC (plan 9).
    const status = await readMpStatus(prisma, 4700);
    expect(status.ready).toBe(true);
    if (status.ready) expect(status.club?.preferredHours).toEqual([20, 21, 32]);

    // Persisting the converted world clears the legacy marker; reloading no
    // longer shifts anything (idempotent conversion).
    await persistWorld(prisma, saveId, saveId, firstLoad!.world);
    const row = await prisma.club.findUnique({ where: { saveId_id: { saveId, id: club.id } } });
    expect(row?.timezone ?? null).toBeNull();
    const secondLoad = await loadGlobalWorld(prisma);
    const stable = secondLoad!.world.clubs.find((c) => c.id === club.id)!;
    expect(stable.preferredHours).toEqual([20, 21, 32]);
  });

  it("keeps :45-offset zones stable and clears the marker on partial club updates", async () => {
    const { saveId } = await freshGlobalWorld(4713);
    const { world } = await withSeason(saveId);
    await prisma.user.deleteMany({ where: { id: 4701 } });
    await prisma.user.create({ data: { id: 4701, name: "Persist Nepal", email: "persist-nepal@test.dev", emailVerified: true } });
    const club = createHumanClub(world, { userId: 4701, clubName: "Nepal FC", country: "BRA" });
    await persistWorld(prisma, saveId, saveId, world);

    // Legacy row: local wall-clock slots under Asia/Kathmandu (+05:45).
    await prisma.club.update({
      where: { saveId_id: { saveId, id: club.id } },
      data: { timezone: "Asia/Kathmandu", preferredHoursJson: JSON.stringify([34, 35, 0]) },
    });

    const loaded = await loadGlobalWorld(prisma);
    const migrated = loaded!.world.clubs.find((c) => c.id === club.id)!;
    // Offset quantizes to a whole-slot shift (+05:45 = 345 min -> 11.5 ->
    // rounds to 12 slots): local 17:00 -> 10:00 UTC (22), 17:30 -> 23,
    // 00:00 -> previous day 12:00 (36). The same quantized shift in both
    // directions keeps round trips exact.
    expect(migrated.preferredHours).toEqual([22, 23, 36]);

    // Regression: the per-club UPDATE delta path must clear the legacy marker
    // too. clubRow previously omitted timezone, so a cached-world partial
    // write kept the row convertible forever and slots were re-shifted once
    // per server restart. Enable the production cache to drive that path.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      invalidateWorldCache(prisma);
      const mutable = await loadGlobalWorldMutable(prisma);
      if (!mutable) throw new Error("world did not load");
      mutable.world.clubs.find((candidate) => candidate.id === club.id)!.cash += 1;
      await persistWorld(prisma, mutable.save.id, mutable.save.id, mutable.world, mutable.save.revision);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      invalidateWorldCache(prisma);
    }
    const rowAfterDelta = await prisma.club.findUnique({ where: { saveId_id: { saveId, id: club.id } } });
    expect(rowAfterDelta?.timezone ?? null).toBeNull();
    expect(JSON.parse(rowAfterDelta?.preferredHoursJson ?? "null")).toEqual([22, 23, 36]);
    // And the conversion stays idempotent across the next reload.
    const afterDelta = (await loadGlobalWorld(prisma))!.world.clubs.find((candidate) => candidate.id === club.id)!;
    expect(afterDelta.preferredHours).toEqual([22, 23, 36]);
  });

  it("round-trips retained player attributes and re-derives the market value", async () => {
    const { saveId } = await freshGlobalWorld(6767);
    const { world } = await withSeason(saveId);
    const player = world.players[0];
    const skills = { gol: 11, pace: 22, tec: 33, pas: 44, des: 55, playmaking: 66, fin: 77 };
    const skillAcc = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77];
    player.skills = skills;
    player.overall = 77;
    player.salary = 123456;
    // A stale price persisted by an older valuation model.
    player.value = 654321;
    player.skillAcc = skillAcc;

    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const saved = reloaded!.world.players.find((candidate) => candidate.id === player.id)!;
    expect(saved.skills).toEqual(skills);
    expect(saved.overall).toBe(77);
    expect(saved.skillAcc).toEqual(skillAcc);
    // The contractual salary is preserved exactly...
    expect(saved.salary).toBe(123456);
    // ...but market value is derived, so a rebuilt world re-prices the player
    // from the current model instead of keeping the stale figure.
    expect(saved.value).toBe(calculatePlayerValue(saved.overall, saved.age, remainingSeasons(saved.contractDays)));
    expect(saved.value).not.toBe(654321);
  });

  it("re-prices players on reload but never an open listing's value snapshot", async () => {
    const { saveId } = await freshGlobalWorld(6868);
    const { seasonId, world } = await withSeason(saveId);
    // A human seller with a User row (Club.ownerUserId FK) and enough played
    // fixtures to clear the new-club outbound sell lock.
    await prisma.user.deleteMany({ where: { id: 6800 } });
    await prisma.user.create({ data: { id: 6800, name: "Snapshot Seller", email: "snapshot-seller@test.dev", emailVerified: true } });
    const division = world.competitions.find((candidate) => candidate.kind === "division" && candidate.seasonId === seasonId)!;
    const seller = createHumanClub(world, { userId: 6800, clubName: "Snapshot FC", country: "BRA" });
    seller.competitionState = "ACTIVE";
    for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
      world.fixtures.push({ id: world.nextId++, competitionId: division.id, round, homeClubId: seller.id, awayClubId: -seller.id, dayIndex: round, played: true });
    }
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
    player.contractDays = gameConfig.seasonDays * 4;
    player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
    const listed = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 1 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    const auctionId = listed.listing.id;
    const snapshotAtListing = listed.listing.playerValueAtListing;
    expect(snapshotAtListing).toBe(player.value);

    // Simulate a valuation rollout that moves every price while the auction is
    // still open: the persisted player price is stale, the listing is not.
    player.value = 1;
    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const savedPlayer = reloaded!.world.players.find((candidate) => candidate.id === player.id)!;
    expect(savedPlayer.value).toBe(
      calculatePlayerValue(savedPlayer.overall, savedPlayer.age, remainingSeasons(savedPlayer.contractDays)),
    );
    const savedAuction = reloaded!.world.transferAuctions.find((auction) => auction.id === auctionId)!;
    // The bid cap the current bidders agreed to is an absolute snapshot and must
    // not move underneath them.
    expect(savedAuction.playerValueAtListing).toBe(snapshotAtListing);
  });

  it("ignores retired budget Setting rows and the migration deletes them", async () => {
    await freshGlobalWorld(6969);
    const retired = ["FIRST_DIVISION_SEASON_BUDGET", "MINIMUM_TIER_BUDGET_RATIO", "TIER_BUDGET_DECAY_RATE"] as const;
    for (const key of retired) {
      await prisma.setting.upsert({ where: { key }, update: { value: "1" }, create: { key, value: "1" } });
    }
    // Present but inert: the budget curve and every player price come from
    // game.config.jsonc alone.
    expect(tierBudget(1)).toBe(gameConfig.firstDivisionSeasonBudget);
    expect(budgetSettings()).toEqual({
      firstDivisionBudget: gameConfig.firstDivisionSeasonBudget,
      minimumTierBudgetRatio: gameConfig.minimumTierBudgetRatio,
      tierBudgetDecayRate: gameConfig.tierBudgetDecayRate,
    });
    expect(calculatePlayerValue(80, 27, 3)).toBeGreaterThan(1);

    // The shipped data migration is what actually removes them.
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", "20260825160000_retire_budget_settings", "migration.sql"),
      "utf8",
    );
    for (const key of retired) expect(migration).toContain(key);
    await prisma.$executeRawUnsafe(migration);
    expect(await prisma.setting.findMany({ where: { key: { in: [...retired] } } })).toEqual([]);
    // An unrelated operational setting is untouched.
    await prisma.setting.upsert({ where: { key: "JOIN_THRESHOLD_PERCENT" }, update: { value: "0.5" }, create: { key: "JOIN_THRESHOLD_PERCENT", value: "0.5" } });
    await prisma.$executeRawUnsafe(migration);
    expect(await prisma.setting.findUnique({ where: { key: "JOIN_THRESHOLD_PERCENT" } })).not.toBeNull();
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
    expect(st2!.matchClockSeconds).toBe(st.matchClockSeconds);
    expect(st2!.rngState).toEqual(st.rngState);
    expect(st2!.playerEnergy).toEqual(st.playerEnergy);
    // Ball choreography fields ride the state JSON; a reload must not lose
    // them or the client would draw turnover intent lines from stale data.
    expect(st2!.ballCarrierId ?? null).toBe(st.ballCarrierId ?? null);
    expect(st2!.ballActionSequence ?? null).toBe(st.ballActionSequence ?? null);
    expect(st2!.lastBallAction ?? null).toEqual(st.lastBallAction ?? null);
    expect(st2!.lastAction ?? null).toBe(st.lastAction ?? null);
    expect(st2!.prevZone ?? null).toBe(st.prevZone ?? null);
    expect(st2!.stats.home.controlledBallSeconds + st2!.stats.away.controlledBallSeconds).toBeGreaterThan(0);

    // Finalize via the multiplayer path: minutes land on players.
    const { finalizeLiveMatch } = await import("../src/game/world");
    const home2 = reloaded!.world.clubs.find((c) => c.id === home.id)!;
    const away2 = reloaded!.world.clubs.find((c) => c.id === away.id)!;
    const clockBeforeResume = st2!.matchClockSeconds;
    tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 5, { ignoreHalfTime: true });
    expect(st2!.matchClockSeconds).toBeGreaterThan(clockBeforeResume);
    tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 200, { ignoreHalfTime: true });
    finalizeLiveMatch(reloaded!.world, st2!);
    const onPitchId = st2!.homeOn[0];
    const p = reloaded!.world.players.find((x) => x.id === onPitchId)!;
    expect(p.recentMinutes.length).toBeGreaterThan(0);
  });

  it("round-trips injury auto-substitutions without duplication on resume", async () => {
    const { saveId } = await freshGlobalWorld(31339);
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const home = world.clubs[0];
    const away = world.clubs[1];
    // Force a high injury rate so an auto-substitution certainly happens.
    const prevTarget = gameConfig.injuries.matchTargetPerMatch;
    gameConfig.injuries.matchTargetPerMatch = 6;
    try {
      const st = createLiveMatchState(world.rng, home, away, world.players, {
        matchId: 992001,
        fixtureId: 992001,
        competitionId: div.id,
      });
      // Tick until the first auto-sub fires, so the save lands directly after
      // an injury+SUB pair — the exact restart boundary where a replay bug
      // would double-fire.
      let guard = 0;
      while (!st.ended && st.events.filter((event) => event.type === EVENT_CODES.SUB).length === 0 && guard < 120) {
        tickLiveMatch(world.rng, home, away, world.players, st, 5, { ignoreHalfTime: true });
        guard++;
      }
      const subsBefore = st.events.filter((event) => event.type === EVENT_CODES.SUB).length;
      const injuriesBefore = st.events.filter((event) => event.type === EVENT_CODES.INJURY).length;
      expect(injuriesBefore).toBeGreaterThan(0);
      expect(subsBefore).toBeGreaterThan(0);
      for (const sub of st.events.filter((event) => event.type === EVENT_CODES.SUB)) {
        expect(st.events.some((event) => event.type === EVENT_CODES.INJURY && event.clubId === sub.clubId && event.playerId === sub.playerId)).toBe(true);
      }

      world.liveMatches = [st];
      await persistWorld(prisma, saveId, saveId, world);
      const reloaded = await loadGlobalWorld(prisma);
      expect(reloaded).not.toBeNull();
      const st2 = reloaded!.world.liveMatches.find((s) => s.matchId === 992001)!;
      expect(st2).not.toBeNull();
      expect(st2!.substitutions.length).toBe(subsBefore);
      expect(st2!.events.filter((event) => event.type === EVENT_CODES.SUB)).toHaveLength(subsBefore);

      // Resume on the reloaded world. Two things must hold:
      //  1. The persisted injury must NOT re-fire — checked two ways below.
      //  2. Any NEW substitution during the resume ticks must be caused by a
      //     NEWLY recorded injury (the forced injury rate makes those legit),
      //     never by an injury whose event predates the resume point.
      const subsAtResume = st2!.substitutions.map((substitution) => ({ ...substitution }));
      const subEventsAtResume = st2!.events.filter((event) => event.type === EVENT_CODES.SUB).length;
      const eventsAtResume = st2!.events.length;
      const home2 = reloaded!.world.clubs.find((c) => c.id === home.id)!;
      const away2 = reloaded!.world.clubs.find((c) => c.id === away.id)!;
      tickLiveMatch(reloaded!.world.rng, home2, away2, reloaded!.world.players, st2!, 3, { ignoreHalfTime: true });
      // 1a. The already-recorded substitutions are untouched.
      expect(st2!.substitutions.slice(0, subsAtResume.length)).toEqual(subsAtResume);
      // 1b. No player is substituted off twice: a replayed persisted injury
      // would substitute the same player again.
      const outs = st2!.substitutions.map((substitution) => substitution.outId);
      expect(new Set(outs).size).toBe(outs.length);
      // 2. Every new SUB event is backed by an INJURY event recorded during the
      //    resume ticks, for the same player and club. The structured list must
      //    mirror the event log one-to-one as well.
      const allSubEvents = st2!.events.filter((event) => event.type === EVENT_CODES.SUB);
      const newSubEvents = allSubEvents.slice(subEventsAtResume);
      const injuriesDuringResume = st2!.events
        .slice(eventsAtResume)
        .filter((event) => event.type === EVENT_CODES.INJURY);
      for (const sub of newSubEvents) {
        expect(
          injuriesDuringResume.some((injury) => injury.clubId === sub.clubId && injury.playerId === sub.playerId),
        ).toBe(true);
      }
      expect(st2!.substitutions.length).toBe(allSubEvents.length);
    } finally {
      gameConfig.injuries.matchTargetPerMatch = prevTarget;
    }
  });

  it("persists ongoing live-match progress without rewriting the world tables", async () => {
    const { saveId } = await freshGlobalWorld(31338);
    const { world } = await withSeason(saveId);
    const home = world.clubs[0];
    const away = world.clubs[1];
    const state = createLiveMatchState(world.rng, home, away, world.players, { matchId: 991001, competitionId: 1, fixtureId: 1 });
    world.liveMatches.push(state);
    await persistWorld(prisma, saveId, saveId, world);

    state.minute = 12;
    const saved = await prisma.save.findUnique({ where: { id: saveId }, select: { revision: true } });
    await persistLiveMatchState(prisma, saveId, saveId, state, world.rng.state, saved!.revision);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.liveMatches[0].minute).toBe(12);
    expect(reloaded?.world.players).toHaveLength(world.players.length);
    expect(reloaded?.world.clubs).toHaveLength(world.clubs.length);
  });

  it("keeps the release clause in sync after development ticks and round-trips", async () => {
    const { saveId } = await freshGlobalWorld(555);
    const { world } = await withSeason(saveId);
    const club = world.clubs[0];
    const p = world.players.find((x) => x.clubId === club.id && !x.isYouth)!;
    for (let day = 1; day <= 10; day++) applyDevelopment(p, club, day);
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

  it("round-trips player-origin metadata and the generation-events ledger (spec §45/§50)", async () => {
    const { saveId } = await freshGlobalWorld(4242);
    const { seasonId, world } = await withSeason(saveId);
    // Tag a generated player with origin metadata.
    const player = world.players.find((p) => !p.isYouth)!;
    player.generatedClubId = world.clubs[0].id;
    player.generatedDivision = 2;
    player.generatedSeasonId = seasonId;
    player.generationType = "initial-senior";
    player.generatedClubHighestDivision = 1;
    player.rawZ = 1.234;
    // Record an intake ledger event.
    world.generationEvents.push("academy-intake:1:7");
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    const rp = rw.players.find((p) => p.id === player.id)!;
    expect(rp.generatedClubId).toBe(world.clubs[0].id);
    expect(rp.generatedDivision).toBe(2);
    expect(rp.generatedSeasonId).toBe(seasonId);
    expect(rp.generationType).toBe("initial-senior");
    expect(rp.generatedClubHighestDivision).toBe(1);
    expect(rp.rawZ).toBeCloseTo(1.234, 5);
    expect(rw.generationEvents).toContain("academy-intake:1:7");
  });

  it("round-trips market listings, bids, reservations, history", async () => {
    const { saveId } = await freshGlobalWorld(901);
    const { seasonId, world } = await withSeason(saveId);
    // Human seller/bidder with User rows (Club.ownerUserId FK) and enough
    // played fixtures to satisfy the new-club outbound sell lock.
    await prisma.user.deleteMany({ where: { id: { in: [9000, 9001] } } });
    await prisma.user.createMany({
      data: [
        { id: 9000, name: "Persist Seller", email: "persist-seller@test.dev", emailVerified: true },
        { id: 9001, name: "Persist Buyer", email: "persist-buyer@test.dev", emailVerified: true },
      ],
    });
    const { createHumanClub } = await import("../src/game/worldgen");
    const { MP_CONFIG } = await import("../src/config");
    const division = world.competitions.find((candidate) => candidate.kind === "division" && candidate.seasonId === seasonId)!;
    const makeTrader = (userId: number, name: string) => {
      const club = createHumanClub(world, { userId, clubName: name, country: "BRA" });
      club.competitionState = "ACTIVE";
      for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
        world.fixtures.push({ id: world.nextId++, competitionId: division.id, round, homeClubId: club.id, awayClubId: -club.id, dayIndex: round, played: true });
      }
      return club;
    };
    const seller = makeTrader(9000, "Seller FC");
    const player = world.players.find((p) => p.clubId === seller.id && !p.isYouth)!;
    const now = Date.now();

    // A public auction listing.
    const { createTransferAuction, applyMaxBid, releaseAllReservations } = await import("../src/game/market");
    const buyer = makeTrader(9001, "Bidder FC");
    const created = createTransferAuction(world, { player, sellerClub: seller, sellerDivision: 1, totalDivisions: 3 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    const listing = created.listing;

    // A club bids (reservation + bid rows).
    const bid = applyMaxBid(world, {
      listing,
      club: buyer,
      player,
      proposedMaximum: Math.round(player.value * 1.1),
      buyerDivision: 1,
      immediateAvailableCash: 50_000_000,
      contractSeasons: 4,
      now,
    });
    expect(bid.ok).toBe(true);

    // History row (with the completed-rounds stamp for the anchor fade).
    const { recordTransaction } = await import("../src/game/market");
    recordTransaction(world, {
      playerId: player.id, listingId: listing.id, type: "TRANSFER",
      fromClubId: seller.id, toClubId: buyer.id, price: listing.currentPrice,
      seasonId, seasonKey: "2026-01", seasonDayIndex: world.dayIndex, contractSeasons: 4, contractSalary: world.marketBids[0].contractSalary, timestamp: now,
    });

    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    expect(rw.transferAuctions).toHaveLength(1);
    expect(rw.transferAuctions[0].id).toBe(listing.id);
    expect(rw.transferAuctions[0].status).toBe("ACTIVE");
    expect(rw.marketBids).toHaveLength(1);
    expect(rw.marketBids[0].clubId).toBe(buyer.id);
    expect(rw.marketBids[0].maxBid).toBe(world.marketBids[0].maxBid);
    expect(rw.marketBids[0].contractSeasons).toBe(4);
    expect(rw.marketBids[0].contractSalary).toBe(world.marketBids[0].contractSalary);
    expect(rw.marketReservations).toHaveLength(1);
    expect(rw.marketReservations[0].amount).toBe(world.marketBids[0].maxBid);
    expect(rw.playerMarketHistory).toHaveLength(1);
    expect(rw.playerMarketHistory[0].type).toBe("TRANSFER");
    expect(rw.playerMarketHistory[0].contractSeasons).toBe(4);
    expect(rw.playerMarketHistory[0].contractSalary).toBe(world.marketBids[0].contractSalary);
    expect(rw.playerMarketHistory[0].completedRounds).toBe(world.mp.completedRounds);

    // A reload after settlement-like release: released reservations survive.
    releaseAllReservations(rw, listing.id, "TRANSFER");
    await persistWorld(prisma, saveId, saveId, rw);
    const reloaded2 = await loadGlobalWorld(prisma);
    expect(reloaded2!.world.marketReservations[0].releasedAt).not.toBeNull();
  });

  it("round-trips financial-intervention audit data and anti-loop fields", async () => {
    const { saveId } = await freshGlobalWorld(902);
    const { seasonId, world } = await withSeason(saveId);
    const club = world.clubs[0];
    const replacement = world.players.find((player) => player.clubId === club.id && !player.isYouth)!;
    replacement.financialInterventionGeneratedSeasonId = seasonId;
    const freeAgent = world.players.find((player) => player.clubId === club.id && !player.isYouth && player.id !== replacement.id)!;
    freeAgent.clubId = null;
    freeAgent.onSale = false;
    const { createFreeAgentListing } = await import("../src/game/freeAgents");
    const created = createFreeAgentListing(world, freeAgent, { blockedClubId: club.id });
    expect(created.ok).toBe(true);
    world.financialInterventions.push({
      id: 990001,
      clubId: club.id,
      seasonId,
      payrollCycleId: 7,
      cashBefore: -1,
      commitmentsBefore: 2,
      cushionBefore: -3,
      forcedAuctionRevenue: 0,
      systemLiquidationRevenue: 4,
      cashAfter: 3,
      commitmentsAfter: 2,
      cushionAfter: 1,
      createdAt: Date.now(),
      entries: [{ playerId: freeAgent.id, kind: "SYSTEM_LIQUIDATION", price: 4, replacementPlayerId: replacement.id }],
      unableToFullyRecover: false,
    });
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;
    expect(rw.financialInterventions).toHaveLength(1);
    expect(rw.financialInterventions[0].entries[0].replacementPlayerId).toBe(replacement.id);
    expect(rw.nextId).toBeGreaterThan(990001);
    expect(rw.players.find((player) => player.id === replacement.id)?.financialInterventionGeneratedSeasonId).toBe(seasonId);
    expect(rw.freeAgentListings.find((listing) => listing.playerId === freeAgent.id)?.blockedClubId).toBe(club.id);
    expect(rw.freeAgentListings.find((listing) => listing.playerId === freeAgent.id)?.unclaimedSince).toBeDefined();
  });

  it("round-trips grouped inbox news metadata (news overhaul)", async () => {
    const { saveId } = await freshGlobalWorld(906);
    const { seasonId, world } = await withSeason(saveId);
    const clubId = world.clubs[0].id;
    world.news.push(
      {
        dayIndex: 3,
        text: "Player contracts expiring soon: A (12 days remaining on his current deal) and B (20 days remaining on his current deal). These deals have entered their renewal window, and the clock is running down before the players reach the open market.",
        kind: "contract",
        clubId,
        recipientClubId: clubId,
        seasonId,
        subject: "contract-warning",
        headline: "Contracts entering their final stretch",
        entries: [
          { key: "warn:1", label: "A", detail: "12 days remaining on his current deal" },
          { key: "warn:2", label: "B", detail: "20 days remaining on his current deal" },
        ],
      },
      { dayIndex: 4, text: "plain legacy item", kind: "mp" },
    );
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const grouped = reloaded!.world.news.find((n) => n.subject === "contract-warning");
    expect(grouped?.headline).toBe("Contracts entering their final stretch");
    expect(grouped?.recipientClubId).toBe(clubId);
    expect(grouped?.seasonId).toBe(seasonId);
    expect(grouped?.entries).toEqual([
      { key: "warn:1", label: "A", detail: "12 days remaining on his current deal" },
      { key: "warn:2", label: "B", detail: "20 days remaining on his current deal" },
    ]);
    expect(grouped?.text).toBe("Player contracts expiring soon: A (12 days remaining on his current deal) and B (20 days remaining on his current deal). These deals have entered their renewal window, and the clock is running down before the players reach the open market.");
    // Legacy rows without inbox metadata keep loading untouched.
    const legacy = reloaded!.world.news.find((n) => n.text === "plain legacy item");
    expect(legacy?.subject).toBeUndefined();
    expect(legacy?.recipientClubId).toBeUndefined();
  });

  it("reads a legacy matchday into seasonDayIndex without losing its value", async () => {
    const { saveId } = await freshGlobalWorld(903);
    const { seasonId, world } = await withSeason(saveId);
    const player = world.players[0];
    await prisma.playerMarketTransaction.create({
      data: {
        saveId,
        playerId: player.id,
        listingId: null,
        type: "LOAN",
        fromClubId: null,
        toClubId: null,
        price: 0,
        seasonId,
        seasonKey: "2026-01",
        seasonDayIndex: null,
        matchday: 9,
        contractSeasons: null,
        contractSalary: null,
        timestamp: BigInt(123),
      },
    });
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.playerMarketHistory[0].seasonDayIndex).toBe(9);
  });

  it("migrates persisted legacy phases through the authoritative calendar", async () => {
    const { saveId, world } = await freshGlobalWorld(904);
    world.mp.seasonDayIndex = 28;
    world.mp.absoluteGameDay = 28;
    world.mp.phase = "ACTIVE";
    await persistWorld(prisma, saveId, saveId, world);

    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded?.world.mp.phase).toBe("POST_MATCH");
  });

  it("round-trips a filler retirement with a force-settled listing without dangling market state", async () => {
    const { saveId } = await freshGlobalWorld(905);
    // Club.ownerUserId has an FK to User: create the owners first.
    await prisma.user.deleteMany({ where: { id: { in: [9051, 9052] } } });
    await prisma.user.createMany({
      data: [
        { id: 9051, name: "Bidder 9051", email: "bidder-9051@test.dev", emailVerified: true },
        { id: 9052, name: "Joiner 9052", email: "joiner-9052@test.dev", emailVerified: true },
      ],
    });
    const { seasonId, world } = await withSeason(saveId);
    const div = world.competitions.find((c) => c.kind === "division" && c.seasonId === seasonId)!;
    const aiId = highestRankedReplaceableAI(world, div)!;
    const ai = world.clubs.find((c) => c.id === aiId)!;
    const player = world.players.filter((p) => p.clubId === aiId && !p.isYouth).reduce((min, p) => (p.value < min.value ? p : min));
    // Raw pre-B3 state: AI-owned listings are hard-blocked now, but legacy
    // worlds can still carry them and rollover must force-settle/cancel them.
    const now = Date.now();
    const listing: import("../src/game/types").TransferAuction = {
      id: world.nextId++,
      playerId: player.id,
      sellerClubId: ai.id,
      playerValueAtListing: player.value,
      openingPrice: Math.max(1, player.value),
      bidIncrement: Math.max(1, Math.round(player.value * 0.01)),
      sellerDivisionAtListing: 1,
      totalDivisionsAtListing: 1,
      salaryBaselineAtListing: player.salary,
      playerOverallAtListing: player.overall,
      playerAgeAtListing: player.age,
      currentPrice: Math.max(1, player.value),
      leadingClubId: null,
      createdAt: now,
      deadline: now + 3_600_000,
      originalDeadline: now + 3_600_000,
      status: "ACTIVE",
      completedAt: null,
      winningClubId: null,
      finalPrice: null,
      cancelledAt: null,
      softClosed: false,
      deadlineVersion: 0,
    };
    world.transferAuctions.push(listing);
    void ai;
    const bidder = createHumanClub(world, { userId: 9051, clubName: "Bidder FC", country: "BRA" });
    bidder.cash = Math.max(bidder.cash, listing.openingPrice + 1_000_000);
    const bid = applyMaxBid(world, {
      listing,
      club: bidder,
      player,
      proposedMaximum: listing.openingPrice,
      buyerDivision: 1,
      immediateAvailableCash: bidder.cash,
      now: Date.now(),
    });
    expect(bid.ok).toBe(true);

    // A human takes the AI's slot; the leading bidder must keep the player.
    const joiner = createHumanClub(world, { userId: 9052, clubName: "Joiner FC", country: "BRA" });
    const result = placeNewClub(world, joiner.id, Date.now(), seasonId, { year: 2026, month: 2 });
    if (result.kind !== "active") throw new Error("expected active placement");
    expect(result.replacedClubId).toBe(aiId);

    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded).not.toBeNull();
    const rw = reloaded!.world;

    expect(rw.clubs.some((c) => c.id === aiId)).toBe(false);
    const settled = rw.transferAuctions.find((a) => a.id === listing.id)!;
    expect(settled.status).toBe("COMPLETED");
    expect(settled.winningClubId).toBe(bidder.id);
    expect(rw.players.find((p) => p.id === player.id)?.clubId).toBe(bidder.id);
    // No dangling commitments referencing the retired filler.
    expect(rw.marketBids.some((b) => b.clubId === aiId)).toBe(false);
    expect(rw.marketReservations.some((r) => r.clubId === aiId && r.releasedAt === null)).toBe(false);
    expect(rw.marketReservations.filter((r) => r.listingId === listing.id).every((r) => r.releasedAt !== null)).toBe(true);
  });
});

describe("news body persistence round-trip", () => {
  it("round-trips a key-native frame body and keeps legacy text rows untouched", async () => {
    const { saveId, world } = await freshGlobalWorld(4311);
    // publishNews does not validate club existence; a synthetic id suffices.
    const clubId = 501;
    world.mp.seasonId = 777;

    // Key-native grouped item: frame body, empty text, message-ref detail.
    publishNews(world, {
      kind: "injury",
      subject: NEWS_SUBJECTS.injuries,
      recipientClubId: clubId,
      headline: "news.headline.injuries",
      entries: [{ key: "injury:1", label: "Player A", detail: msg("news.detail.injury", { count: 3 }) }],
    });
    await persistWorld(prisma, saveId, saveId, world);

    // Insert a legacy-style row directly (English text, no body) so both paths
    // are exercised and history is never rewritten.
    await prisma.newsItem.create({
      data: { saveId, dayIndex: 4, text: "plain legacy item", kind: "mp" },
    });

    let reloaded = await loadGlobalWorld(prisma);
    const grouped = reloaded!.world.news.find((n) => n.subject === NEWS_SUBJECTS.injuries)!;
    expect(grouped.body?.k).toBe("news.injuries");
    expect(grouped.text).toBe("");
    expect(isMessageRef(grouped.entries?.[0].detail)).toBe(true);
    expect(grouped.entries?.[0].detail).toEqual(msg("news.detail.injury", { count: 3 }));
    const legacy = reloaded!.world.news.find((n) => n.text === "plain legacy item")!;
    expect(legacy.body).toBeUndefined();

    // Persist again with NO changes: the key-order trap would rewrite every
    // news row here; assert zero rows were written.
    const before = await prisma.newsItem.count({ where: { saveId } });
    await persistWorld(prisma, saveId, saveId, reloaded!.world);
    const after = await prisma.newsItem.count({ where: { saveId } });
    expect(after).toBe(before);
    // And the legacy row's bodyJson is still NULL (history not rewritten).
    const legacyRow = await prisma.newsItem.findFirst({ where: { saveId, text: "plain legacy item" }, select: { bodyJson: true } });
    expect(legacyRow?.bodyJson).toBeNull();
  });
});

