import { describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "./testDbUrl";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";

import { PrismaClient } from "@prisma/client";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "../src/services/saveService";
import { ensureSeasonRow } from "../src/services/mpService";
import { initSeason } from "../src/game/multiplayer";
import { executeRolloverStep } from "../src/services/seasonRolloverService";
import { makeClub } from "./helpers";
import type { Player, World } from "../src/game/types";

const prisma = new PrismaClient();

/** Fresh global save with the season row + world in sync (mirrors seasonArchive). */
async function freshTrendWorld(seed: number, players: Player[]): Promise<{ saveId: number; world: World }> {
  await prisma.save.deleteMany({ where: { isGlobal: true } });
  const save = await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("world did not load");
  const world = loaded.world;
  const season = await ensureSeasonRow(prisma, { year: 2026, month: 1 });
  initSeason(world, { year: 2026, month: 1 }, season.seasonId);
  // Replace the generated population with the fixture under test.
  world.players = players;
  const clubIds = new Set(players.map((p) => p.clubId).filter((id): id is number => id !== null));
  world.clubs = world.clubs.filter((c) => clubIds.has(c.id));
  await persistWorld(prisma, save.id, save.id, world);
  return { saveId: save.id, world };
}

describe("player season history trend snapshots", () => {
  it("stores the end-of-season overall and value on each archived season row", async () => {
    const club = makeClub({ id: 1, ownerUserId: null });
    // Two owned players with distinct OVR/value, one free agent with stats
    // (so it also gets a row) and one free agent without production (skipped).
    const ownedPlayers = [
      makePlayer(1, 78, 450_000, club.id),
      makePlayer(2, 88, 12_500_000, club.id),
    ];
    const freeAgentWithStats = { ...makePlayer(3, 65, 90_000, null), seasonGoals: 4, seasonAssists: 2 };
    const freeAgentWithoutStats = makePlayer(4, 55, 40_000, null);
    const { saveId, world } = await freshTrendWorld(2026, [ownedPlayers[0], ownedPlayers[1], freeAgentWithStats, freeAgentWithoutStats]);

    // The rollover snapshot needs a source season id to archive against.
    const sourceSeasonId = world.mp.seasonId;
    world.mp.rolloverContext = {
      sourceSeasonId,
      targetSeasonId: sourceSeasonId + 1,
      targetYear: 2026,
      targetMonth: 2,
      assignments: {},
      abandonedClubIds: [],
      provisionalClubIds: [],
      completedSteps: [],
    };

    await executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE");

    const rows = await prisma.playerSeasonHistory.findMany({ where: { saveId }, orderBy: { playerId: "asc" } });
    expect(rows).toHaveLength(3);
    const byPlayer = new Map(rows.map((row) => [row.playerId, row]));
    expect(byPlayer.get(1)).toMatchObject({ seasonId: sourceSeasonId, overall: 78, value: 450_000 });
    expect(byPlayer.get(2)).toMatchObject({ seasonId: sourceSeasonId, overall: 88, value: 12_500_000 });
    expect(byPlayer.get(3)).toMatchObject({ overall: 65, value: 90_000 });
    expect(byPlayer.has(4)).toBe(false);
  });

  it("refreshes overall/value on an idempotent retry instead of keeping stale rows", async () => {
    const club = makeClub({ id: 1, ownerUserId: null });
    const player = makePlayer(1, 80, 500_000, club.id);
    const { saveId, world } = await freshTrendWorld(2027, [player]);
    const sourceSeasonId = world.mp.seasonId;
    world.mp.rolloverContext = {
      sourceSeasonId,
      targetSeasonId: sourceSeasonId + 1,
      targetYear: 2026,
      targetMonth: 2,
      assignments: {},
      abandonedClubIds: [],
      provisionalClubIds: [],
      completedSteps: [],
    };

    await executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE");

    // Simulate a retry after the player developed between attempts.
    player.overall = 82;
    player.value = 600_000;
    world.mp.rolloverContext!.completedSteps = world.mp.rolloverContext!.completedSteps.filter((step) => step !== "SEASON_RESULTS_FINALIZE");
    await executeRolloverStep(prisma, world, "SEASON_RESULTS_FINALIZE");

    const rows = await prisma.playerSeasonHistory.findMany({ where: { saveId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ overall: 82, value: 600_000 });
  });
});

function makePlayer(id: number, overall: number, value: number, clubId: number | null) {
  return {
    id,
    saveId: 0,
    clubId,
    name: `P${id}`,
    country: "BRA",
    age: 22,
    position: "DM" as Player["position"],
    side: 1,
    overall,
    energy: 90,
    recentLoad: 0,
    salary: 20_000,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    value,
    releaseClause: 0,
    injuryDays: 0,
    injuryUntilAbsoluteGameDay: null,
    injuryInitialGameDays: null,
    injuryEquivalentRealDays: null,
    injuryCause: null,
    contractDays: 100,
    isYouth: false,
    starter: false,
    careerGrowthConsumed: 0,
    careerDeclineConsumed: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    seasonAppearances: 0,
    yellows: 0,
    reds: 0,
    tacPos: 3,
    squadNumber: null,
    onSale: false,
    suspendedGames: 0,
    turnYellows: 0,
    yellowsTurnKey: null,
    loanId: null,
    careerProfile: {
      growthPotential: 0.5,
      growthSpeed: 0.5,
      peakAge: 27,
      declinePotential: 0.5,
      declineSpeed: 0.5,
    } as { growthPotential: number; growthSpeed: number; peakAge: number; declinePotential: number; declineSpeed: number },
    recentMinutes: [],
    skills: { gol: 1, pace: 70, tec: 70, pas: 70, des: 70, playmaking: 70, fin: 70 },
  };
}
