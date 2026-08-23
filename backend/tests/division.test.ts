import { describe, it, expect } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { initSeason, createDivision, ensureDivisionFull, divisionForClub, recordDivision, tierOf } from "../src/game/multiplayer";

function makeHumanClub(world: ReturnType<typeof generateWorld>, userId: number, name: string) {
  return createHumanClub(world, { userId, clubName: name, country: "BRA" });
}

describe("divisionForClub", () => {
  it("resolves ACTIVE/filler clubs through their division's standings", () => {
    const world = generateWorld(12345);
    initSeason(world, { year: 2026, month: 1 }, 1);
    // Division 1 has 8 filler AI.
    const div = world.competitions.find((c) => c.kind === "division")!;
    expect(div).toBeDefined();
    for (const clubId of Object.keys(div.standings).map(Number)) {
      expect(divisionForClub(world, clubId)).toBe(1);
    }
  });

  it("resolves clubs in deeper divisions by tier", () => {
    const world = generateWorld(12345);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const d2 = createDivision(world, { tier: 2, groupIndex: 0, seasonId: 1, ref: { year: 2026, month: 1 } });
    ensureDivisionFull(world, d2);
    for (const clubId of Object.keys(d2.standings).map(Number)) {
      expect(divisionForClub(world, clubId)).toBe(2);
    }
  });

  it("falls back to the most recent MpClubSeason tier for a DORMANT/PROVISIONAL club", () => {
    const world = generateWorld(99);
    const club = makeHumanClub(world, 1, "Historic FC");
    // No active division: fall back to MpClubSeason.
    world.mpClubSeasons.push({
      clubId: club.id,
      seasonId: 5,
      divisionId: null,
      tier: 3,
      played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, points: 0,
      promotionStatus: "NONE", relegationStatus: "NONE",
    });
    expect(divisionForClub(world, club.id)).toBe(3);
    // A newer season's tier wins.
    world.mpClubSeasons.push({
      clubId: club.id,
      seasonId: 6,
      divisionId: null,
      tier: 2,
      played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, points: 0,
      promotionStatus: "NONE", relegationStatus: "NONE",
    });
    expect(divisionForClub(world, club.id)).toBe(2);
  });

  it("defaults to 1 for a club with no membership at all", () => {
    const world = generateWorld(7);
    const club = makeHumanClub(world, 2, "Solo FC");
    expect(divisionForClub(world, club.id)).toBe(1);
  });
});

describe("recordDivision / highestDivision", () => {
  it("records the all-time highest (best = lowest number) division reached", () => {
    const world = generateWorld(7);
    const club = makeHumanClub(world, 3, "Climber FC");
    expect(club.highestDivision).toBe(1);
    // Relegation to a weaker (higher-numbered) division never downgrades the
    // historical best.
    recordDivision(world, club.id, 2);
    expect(club.highestDivision).toBe(1);
    // Playing in a higher (lower-numbered) division upgrades it.
    recordDivision(world, club.id, 1);
    expect(club.highestDivision).toBe(1);
    // Returning to a weaker division again does not erase the milestone.
    recordDivision(world, club.id, 5);
    expect(club.highestDivision).toBe(1);
  });

  it("filler AI clubs start with their tier as highestDivision", () => {
    const world = generateWorld(12345);
    initSeason(world, { year: 2026, month: 1 }, 1);
    for (const club of world.clubs) {
      const div = world.competitions.find((c) => c.kind === "division" && c.standings[club.id] !== undefined);
      expect(club.highestDivision).toBe(tierOf(div!));
    }
  });
});
