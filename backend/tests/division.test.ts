import { describe, it, expect } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { initSeason, createDivision, ensureDivisionFull, divisionForClub, recordDivision, tierOf } from "../src/game/multiplayer";
import { divisionTicketTier, calcGate } from "../src/game/club";
import { matchRepsForDivisions } from "../src/game/match";
import { createRng } from "../src/game/rng";
import { generatePlayer } from "../src/game/player";

function makeHumanClub(world: ReturnType<typeof generateWorld>, userId: number, name: string) {
  return createHumanClub(world, { userId, clubName: name, country: "BRA", timezone: "UTC" });
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
  it("records the all-time highest division reached", () => {
    const world = generateWorld(7);
    const club = makeHumanClub(world, 3, "Climber FC");
    expect(club.highestDivision).toBe(1);
    recordDivision(world, club.id, 2);
    expect(club.highestDivision).toBe(2);
    recordDivision(world, club.id, 1);
    expect(club.highestDivision).toBe(2);
    recordDivision(world, club.id, 5);
    expect(club.highestDivision).toBe(5);
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

describe("divisionTicketTier", () => {
  it("maps the strongest division to the strongest bucket", () => {
    expect(divisionTicketTier(1)).toBe(5);
  });
  it("decays sublinearly with division number", () => {
    // Monotone non-increasing as division deepens.
    const divisions = [1, 2, 3, 4, 5, 8, 16, 32];
    for (let i = 1; i < divisions.length; i++) {
      expect(divisionTicketTier(divisions[i])).toBeLessThanOrEqual(divisionTicketTier(divisions[i - 1]));
    }
    expect(divisionTicketTier(1)).toBeGreaterThanOrEqual(divisionTicketTier(1000));
  });
  it("clamps within 1..5", () => {
    expect(divisionTicketTier(1)).toBeLessThanOrEqual(5);
    expect(divisionTicketTier(1000)).toBeGreaterThanOrEqual(1);
  });
});

describe("calcGate with division-derived tiers", () => {
  it("computes gate from a division-based tier without a level field", () => {
    const rng = createRng(1);
    const world = generateWorld(1);
    const home = makeHumanClub(world, 10, "Home FC");
    const away = makeHumanClub(world, 11, "Away FC");
    const away2 = makeHumanClub(world, 12, "Away 2 FC");
    const players = [
      generatePlayer(rng, home, { id: 1 }),
      generatePlayer(rng, away, { id: 2 }),
      generatePlayer(rng, away2, { id: 3 }),
    ];
    const gate = calcGate(rng, home, away, "division", undefined, 1, 2);
    expect(gate.attendance).toBeGreaterThan(0);
    expect(gate.revenue).toBeGreaterThan(0);
    // A stronger home division (1) prices higher than a weak one (16).
    const strongHome = calcGate(rng, home, away, "division", undefined, 1, 16);
    const weakHome = calcGate(rng, home, away2, "division", undefined, 16, 1);
    expect(strongHome.revenue).toBeGreaterThanOrEqual(weakHome.revenue);
    expect(players.length).toBe(3);
  });
});

describe("matchRepsForDivisions", () => {
  it("derives strength reps from divisions via the shared curve", () => {
    expect(matchRepsForDivisions(1, 1)).toEqual({ homeRep: 5, awayRep: 5 });
    expect(matchRepsForDivisions(1, 16)).toEqual({ homeRep: 5, awayRep: 1 });
    const r = matchRepsForDivisions(3, 7);
    expect(r.homeRep).toBeGreaterThanOrEqual(1);
    expect(r.homeRep).toBeLessThanOrEqual(5);
    expect(r.awayRep).toBeGreaterThanOrEqual(1);
    expect(r.awayRep).toBeLessThanOrEqual(5);
  });
});
