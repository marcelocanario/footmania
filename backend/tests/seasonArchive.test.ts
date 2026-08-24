import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "file:./test-season-archive.db";
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { executeRolloverStep } from "../src/services/seasonRolloverService";
import type { World } from "../src/game/types";

const prisma = new PrismaClient();

async function freshWorldWithStandings(seed: number): Promise<{ saveId: number; world: World }> {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  const world = loaded.world;
  // The season row must exist first: Competition has an FK to MpSeason.
  const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
  initSeason(world, { year: 2026, month: 1 }, season.seasonId);
  // Award eligibility requires a configured share of appearances; seed every
  // senior player above the floor so award rows are produced by the archive.
  for (const player of world.players) {
    if (!player.isYouth) player.seasonAppearances = 99;
  }
  // Deterministic final standings: club id order == final ranking.
  const division = world.competitions.find((c) => c.kind === "division")!;
  Object.values(division.standings).forEach((row, index) => {
    const played = 14;
    const wins = Math.max(0, 8 - index);
    row.played = played;
    row.wins = wins;
    row.draws = 0;
    row.losses = played - wins;
    row.goalsFor = wins * 2;
    row.goalsAgainst = (played - wins) * 2;
    row.points = wins * 3;
  });
  await persistWorld(prisma, save.id, save.id, world);
  return { saveId: save.id, world };
}

describe("season results archive (invariant #19, review C5)", () => {
  it("snapshots standings with names, awards titles, and writes summary/awards/records", async () => {
    const { saveId, world } = await freshWorldWithStandings(910);
    const sourceSeasonId = world.mp.seasonId;
    const division = world.competitions.find((c) => c.kind === "division" && c.seasonId === sourceSeasonId)!;
    const ranked = [...Object.values(division.standings)].sort((a, b) => b.points - a.points || a.clubId - b.clubId);
    const championId = ranked[0].clubId;
    const runnerUpId = ranked[1].clubId;

    await executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE");

    // History: one entry for the finished season, name-snapped rows.
    expect(world.seasonHistory).toHaveLength(1);
    const entry = world.seasonHistory[0];
    expect(entry.seasonId).toBe(sourceSeasonId);
    expect(entry.divisions.length).toBeGreaterThan(0);
    const snapshot = entry.divisions.find((d) => d.divisionId === division.id)!;
    expect(snapshot.standings.map((row) => row.clubId)).toEqual(ranked.map((row) => row.clubId));
    expect(snapshot.standings[0].clubName).toBe(world.clubs.find((c) => c.id === championId)?.name);

    // Trophies: the champion gains one title under the division name.
    const champClub = world.clubs.find((c) => c.id === championId)!;
    expect(champClub.trophies[division.name]).toBe(1);

    // Summary: tier-1 top two.
    expect(world.seasonSummary).not.toBeNull();
    expect(world.seasonSummary!.leagueChampionId).toBe(championId);
    expect(world.seasonSummary!.leagueRunnerUpId).toBe(runnerUpId);

    // Awards + career records are written.
    expect(world.seasonAwards.length).toBeGreaterThan(0);
    expect(world.records.some((r) => r.category === "most_league_titles")).toBe(true);
    const titlesRecord = world.records.find((r) => r.category === "most_league_titles")!;
    expect(titlesRecord.holderName).toBe(champClub.name);

    // Archive survives a save/reload round-trip.
    await persistWorld(prisma, saveId, saveId, world);
    const reloaded = await loadGlobalWorld(prisma);
    expect(reloaded!.world.seasonHistory).toHaveLength(1);
    expect(reloaded!.world.seasonHistory[0].divisions[0].standings[0].clubName).toBe(champClub.name);
    expect(reloaded!.world.seasonSummary?.leagueChampionId).toBe(championId);

    // Idempotent retry after clearing the step marker: no duplicates.
    const context = reloaded!.world.mp.rolloverContext!;
    context.completedSteps = context.completedSteps.filter((step) => step !== "SEASON_RESULTS_FINALIZE");
    await executeRolloverStep(prisma, reloaded!.world, "SEASON_RESULTS_FINALIZE");
    expect(reloaded!.world.seasonHistory).toHaveLength(1);
    expect(reloaded!.world.clubs.find((c) => c.id === championId)!.trophies[division.name]).toBe(1);
  });

  it("also revokes unclaimed loan listings at finalize (review C7)", async () => {
    const { world } = await freshWorldWithStandings(911);
    // Raw pre-B3 state: an unclaimed loan listing owned by an (AI) club.
    // Ephemeral AI clubs are hard-blocked from listing now, but finalize must
    // still revoke whatever the persisted world contains.
    const { gameConfig } = await import("../src/config");
    const owner = world.clubs.find((c) => c.ownerUserId === null)!;
    const player = world.players.find((p) => p.clubId === owner.id && !p.isYouth)!;
    world.loans.push({
      id: world.nextId++,
      playerId: player.id,
      fromClubId: owner.id,
      toClubId: null,
      startDay: 5,
      endDay: gameConfig.seasonDays,
      recalled: false,
      listedAt: Date.now(),
      claimableAt: Date.now() - 1_000,
    });
    player.loanId = world.loans[0].id;

    await executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE");
    expect(world.loans.every((loan) => loan.recalled)).toBe(true);
    expect(player.loanId).toBeNull();
  });
});

