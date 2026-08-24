import { describe, expect, it } from "vitest";
import { generatePlayer } from "../src/game/player";
import { processSeasonEndContracts, processSeasonalAcademyIntake } from "../src/game/season";
import { divisionAnalytics } from "../src/game/adminAnalytics";
import { createRng } from "../src/game/rng";
import { gameConfig } from "../src/config";
import type { Competition, Player } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function makeDivision(clubId: number, seasonId: number): Competition {
  return {
    id: 1,
    kind: "division",
    name: "1",
    round: 0,
    stage: "group",
    seasonId,
    tier: 1,
    groupIndex: 0,
    status: "ACTIVE",
    config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings: { [clubId]: { clubId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 } },
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
}

describe("population analytics", () => {
  it("records one population snapshot per season, carrying retirees across the two rollover steps", () => {
    const club = makeClub();
    const players: Player[] = [];
    for (let i = 0; i < 20; i++) players.push(generatePlayer(createRng(100 + i), club, { id: i + 1 }));
    const world = makeWorld([club], players);

    processSeasonEndContracts(world.rng, world);
    expect(world.mp.pendingSeasonRetirees).toBe(0);

    processSeasonalAcademyIntake(world.rng, world);
    expect(world.mp.pendingSeasonRetirees).toBeNull();
    expect(world.mp.populationHistory).toHaveLength(1);

    const entry = world.mp.populationHistory![0];
    expect(entry.seasonId).toBe(world.mp.seasonId);
    expect(entry.retirees).toBe(0);
    expect(entry.clubCount).toBe(1);
    expect(entry.seniorCount).toBeGreaterThanOrEqual(20);

    // Idempotent: re-running the intake step for the same season must not
    // duplicate the snapshot (mirrors the archiveSeasonResults guard).
    processSeasonalAcademyIntake(world.rng, world);
    expect(world.mp.populationHistory).toHaveLength(1);
  });

  it("exposes population, age, position and free-agent analytics alongside the existing quality metrics", () => {
    const club = makeClub();
    const players: Player[] = [];
    for (let i = 0; i < 20; i++) players.push(generatePlayer(createRng(200 + i), club, { id: i + 1 }));
    const world = makeWorld([club], players);
    world.competitions.push(makeDivision(club.id, world.mp.seasonId));

    const analytics = divisionAnalytics(world);
    // makeWorld seeds its own (empty-standings) division for sell-lock tests;
    // find the one this test built rather than assuming array order.
    const row = analytics.divisions.find((d) => d.divisionId === 1)!;

    expect(row.realSeniorCount).toBe(20);
    expect(row.projectedSeniorCount).toBe(gameConfig.playerGenerationRules.initialSeniorSquadSize);
    expect(row.projectedYouthCount).toBe(gameConfig.playerGenerationRules.initialAcademySize);
    expect(row.clubsBelowSquadFloor).toBe(0);
    expect(Object.values(row.positionCounts).reduce((sum, n) => sum + n, 0)).toBe(20);

    const ageShareSum = analytics.ageDistribution.reduce((sum, bucket) => sum + bucket.projectedShare, 0);
    expect(ageShareSum).toBeGreaterThan(0.99);
    expect(ageShareSum).toBeLessThan(1.01);

    expect(analytics.freeAgentPool.activeCount).toBe(0);
    expect(analytics.freeAgentPool.avgAge).toBeNull();
    expect(analytics.population.history).toEqual([]);
    expect(analytics.population.currentSeason).toBeNull();
  });
});
