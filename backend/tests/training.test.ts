import { describe, expect, it } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import { applyDevelopment, overallFromSkills } from "../src/game/player";
import { allOverallGroups, trainingWeights, weightTotal } from "../src/game/rating";

describe("skill-based overall and training", () => {
  it("keeps every overall weight set normalized", () => {
    for (const { weights } of Object.values(allOverallGroups())) {
      expect(weightTotal(weights)).toBeCloseTo(1, 10);
    }
  });

  it("makes goalkeeper overall sensitive to gol and outfield overall mostly independent of gol", () => {
    const base = { gol: 10, pace: 70, tec: 70, pas: 70, des: 70, playmaking: 70, fin: 70 };
    const strongGoalkeeper = { ...base, gol: 95 };
    const strongOutfielder = { ...base, gol: 95 };
    expect(overallFromSkills("GK", strongGoalkeeper) - overallFromSkills("GK", base)).toBeGreaterThan(60);
    expect(overallFromSkills("ST", strongOutfielder) - overallFromSkills("ST", base)).toBeLessThan(2);
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
    const skills = { gol: 50, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 1 };
    const primary = trainingWeights("ST", "primary");
    const secondary = trainingWeights("ST", "secondary");
    const assistant = trainingWeights("ST", "assistant", skills);
    expect(primary.fin).toBeGreaterThan(primary.pace);
    expect(secondary.pace).toBeGreaterThan(secondary.tec);
    expect(assistant.fin).toBeGreaterThan(assistant.pace);
    expect(weightTotal(assistant)).toBeCloseTo(1, 10);
  });

  it("changes skills through daily development while preserving caps and the overall invariant", () => {
    const world = generateWorld(9876);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const club = world.clubs[0];
    const player = world.players.find((candidate) => candidate.clubId === club.id && !candidate.isYouth)!;
    player.skills = { gol: 10, pace: 10, tec: 10, pas: 10, des: 10, playmaking: 10, fin: 10 };
    player.overall = overallFromSkills(player.position, player.skills);
    player.age = 20;
    player.starter = true;
    player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
    player.recentMinutes = [90, 90, 90, 90, 90];
    club.trainingFocus = "primary";
    const before = { ...player.skills };
    // One season of daily development is below a single skill point for most
    // focus targets; run several seasons to observe a deterministic bump.
    for (let season = 0; season < 5; season++) {
      for (let day = 1; day <= 30; day++) applyDevelopment(player, club, day);
    }
    expect(player.skills).not.toEqual(before);
    expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
    expect(Object.values(player.skills).every((skill) => skill >= 1 && skill <= 100)).toBe(true);
  });
});
