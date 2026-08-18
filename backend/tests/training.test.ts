import { describe, expect, it } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import { applyDevelopment, overallFromSkills } from "../src/game/player";
import { OVERALL_WEIGHTS, trainingWeights, weightTotal } from "../src/game/rating";

describe("skill-based overall and training", () => {
  it("keeps every overall weight set normalized", () => {
    for (const weights of Object.values(OVERALL_WEIGHTS)) {
      expect(weightTotal(weights)).toBeCloseTo(1, 10);
    }
  });

  it("makes goalkeeper overall sensitive to gol and outfield overall mostly independent of gol", () => {
    const base = { gol: 10, vel: 70, tec: 70, pas: 70, des: 70, arm: 70, fin: 70 };
    const strongGoalkeeper = { ...base, gol: 95 };
    const strongOutfielder = { ...base, gol: 95 };
    expect(overallFromSkills(0, strongGoalkeeper) - overallFromSkills(0, base)).toBeGreaterThan(60);
    expect(overallFromSkills(4, strongOutfielder) - overallFromSkills(4, base)).toBeLessThan(2);
  });

  it("derives generated overall from the generated skills", () => {
    const world = generateWorld(12345);
    initSeason(world, { year: 2026, month: 1 }, 1);
    for (const player of world.players) {
      expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
      expect(player.salary).toBeGreaterThan(0);
      expect(player.value).toBeGreaterThan(0);
    }
  });

  it("uses deterministic primary, secondary, and weakest-area assistant focus", () => {
    const skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 1 };
    const primary = trainingWeights(4, "primary");
    const secondary = trainingWeights(4, "secondary");
    const assistant = trainingWeights(4, "assistant", skills);
    expect(primary.fin).toBeGreaterThan(primary.vel);
    expect(secondary.vel).toBeGreaterThan(secondary.tec);
    expect(assistant.fin).toBeGreaterThan(assistant.vel);
    expect(weightTotal(assistant)).toBeCloseTo(1, 10);
  });

  it("changes skills through daily development while preserving caps and the overall invariant", () => {
    const world = generateWorld(9876);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const club = world.clubs[0];
    const player = world.players.find((candidate) => candidate.clubId === club.id && !candidate.isYouth)!;
    player.skills = { gol: 10, vel: 10, tec: 10, pas: 10, des: 10, arm: 10, fin: 10 };
    player.overall = overallFromSkills(player.position, player.skills);
    player.potential = 100;
    player.age = 20;
    player.starter = true;
    player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
    player.recentMinutes = [90, 90, 90, 90, 90];
    club.trainingFocus = "primary";
    const before = { ...player.skills };
    // One season of daily development is below a single skill point for most
    // focus targets; run several seasons to observe a deterministic bump.
    for (let season = 0; season < 5; season++) {
      for (let day = 1; day <= 30; day++) applyDevelopment(world.rng, player, club, day);
    }
    expect(player.skills).not.toEqual(before);
    expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
    expect(Object.values(player.skills).every((skill) => skill >= 1 && skill <= 100)).toBe(true);
  });
});
