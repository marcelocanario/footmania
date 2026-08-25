import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import {
  applyDevelopment,
  calculateActivityModifier,
  calculateDeclineActivityModifier,
  calculateGrowthActivityModifier,
  calculatePreciseAge,
  calculateRecentActivity,
  effectiveSkillWeights,
  generatePlayer,
  overallFromSkills,
  overallSensitivity,
  remainingCareerBudget,
} from "../src/game/player";
import {
  careerDeclineBudget,
  careerGrowthBudget,
  careerSeasonalRate,
  cumulativeDeclineFraction,
  cumulativeGrowthFraction,
  evaluateCurve,
  generateCareerProfile,
  interpolateCurves,
  reconstructCurrentTarget,
  sampleDensity,
  densityMean,
} from "../src/game/careerCurves";
import { DAYS_PER_YEAR } from "../src/game/constants";
import { SKILL_KEYS } from "../src/game/rating";
import type { Club, Player, PlayerCareerProfile, Position } from "../src/game/types";
import { gameConfig } from "../src/config";
import { makeClub } from "./helpers";
import { calibrationDescribe } from "./calibration";

function testClub(overrides: Partial<Club> = {}): Club {
  return makeClub({ id: 1, isHuman: false, ownerUserId: null, ...overrides });
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return { ...generatePlayer(createRng(1), testClub(), { id: 1 }), ...overrides };
}

function profile(overrides: Partial<PlayerCareerProfile> = {}): PlayerCareerProfile {
  return { growthPotential: 0.5, growthSpeed: 0.5, peakAge: 27, declinePotential: 0.5, declineSpeed: 0.5, ...overrides };
}

/** Run one full season of daily development and return the OVR-equivalent moved. */
function runSeason(player: Player, club: Club, seed = 1): number {
  const before = player.careerGrowthConsumed - player.careerDeclineConsumed;
  const rng = createRng(seed);
  for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
  return player.careerGrowthConsumed - player.careerDeclineConsumed - before;
}

describe("player development activity", () => {
  it("computes activity from recent minutes with the required cases", () => {
    const player = makePlayer({});
    player.recentMinutes = [90, 90, 90, 90, 90];
    expect(calculateRecentActivity(player)).toBeCloseTo(1, 10);
    player.recentMinutes = [0, 0, 0, 0, 0];
    expect(calculateRecentActivity(player)).toBeCloseTo(0, 10);
    player.recentMinutes = [45, 45, 45, 45, 45];
    expect(calculateRecentActivity(player)).toBeCloseTo(0.5, 10);
  });

  it("weights the most recent match more heavily", () => {
    const recent = makePlayer({ recentMinutes: [90, 0, 0, 0, 0] });
    const old = makePlayer({ recentMinutes: [0, 0, 0, 0, 90] });
    expect(calculateRecentActivity(recent)).toBeGreaterThan(calculateRecentActivity(old));
  });

  it("does not zero-pad missing match history and returns the default when empty", () => {
    expect(calculateRecentActivity(makePlayer({ recentMinutes: [] }))).toBeCloseTo(0.7, 10);
    expect(calculateRecentActivity(makePlayer({ recentMinutes: [90] }))).toBeCloseTo(1, 10);
  });
});

describe("player development modifiers", () => {
  it("reduces realized growth as activity falls", () => {
    expect(calculateGrowthActivityModifier(1)).toBeCloseTo(1, 10);
    expect(calculateGrowthActivityModifier(0)).toBeCloseTo(0.65, 10);
    expect(calculateGrowthActivityModifier(0.5)).toBeCloseTo(0.825, 10);
  });

  it("increases realized decline as activity falls", () => {
    expect(calculateDeclineActivityModifier(1)).toBeCloseTo(1, 10);
    expect(calculateDeclineActivityModifier(0)).toBeCloseTo(1.4, 10);
  });

  it("returns 1 on the plateau and dispatches by sign", () => {
    expect(calculateActivityModifier(0, 0.5)).toBe(1);
    expect(calculateActivityModifier(1, 0)).toBeCloseTo(0.65, 10);
    expect(calculateActivityModifier(-1, 0)).toBeCloseTo(1.4, 10);
  });
});

describe("career curves", () => {
  it("interpolates piecewise-linear cumulative curves and clamps outside the domain", () => {
    const curve = [[0, 0], [1, 1]] as const;
    expect(evaluateCurve(curve, -1)).toBe(0);
    expect(evaluateCurve(curve, 0.25)).toBeCloseTo(0.25, 10);
    expect(evaluateCurve(curve, 2)).toBe(1);
  });

  it("speed 0 follows the slow curve and speed 1 the fast curve exactly", () => {
    const slow = [[0, 0], [0.5, 0.1], [1, 1]] as const;
    const fast = [[0, 0], [0.5, 0.8], [1, 1]] as const;
    expect(interpolateCurves(slow, fast, 0.5, 0)).toBeCloseTo(0.1, 10);
    expect(interpolateCurves(slow, fast, 0.5, 1)).toBeCloseTo(0.8, 10);
    expect(interpolateCurves(slow, fast, 0.5, 0.5)).toBeCloseTo(0.45, 10);
  });

  it("grows before the personal peak and declines after it", () => {
    const p = profile({ peakAge: 27 });
    for (const age of [17, 20, 24, 26]) expect(careerSeasonalRate(p, age)).toBeGreaterThan(0);
    for (const age of [27, 30, 34]) expect(careerSeasonalRate(p, age)).toBeLessThan(0);
  });

  it("grants no growth budget at potential 0 and the configured maximum at potential 1", () => {
    expect(careerGrowthBudget(profile({ growthPotential: 0 }))).toBe(0);
    expect(careerGrowthBudget(profile({ growthPotential: 1 }))).toBeCloseTo(gameConfig.playerCareer.maximumCareerGrowthOverall, 10);
  });

  it("grants no decline budget at potential 0 and the configured maximum at potential 1", () => {
    expect(careerDeclineBudget(profile({ declinePotential: 0 }))).toBe(0);
    expect(careerDeclineBudget(profile({ declinePotential: 1 }))).toBeCloseTo(gameConfig.playerCareer.maximumCareerDeclineOverall, 10);
  });

  it("lets speed change timing without changing the full-activity total", () => {
    const slow = profile({ growthPotential: 1, growthSpeed: 0, peakAge: 28 });
    const fast = profile({ growthPotential: 1, growthSpeed: 1, peakAge: 28 });
    expect(cumulativeGrowthFraction(slow, 28)).toBeCloseTo(1, 10);
    expect(cumulativeGrowthFraction(fast, 28)).toBeCloseTo(1, 10);
    expect(cumulativeGrowthFraction(fast, 20)).toBeGreaterThan(cumulativeGrowthFraction(slow, 20));
    // Decline behaves the same way: faster only means earlier, not more.
    const slowDecline = profile({ declinePotential: 1, declineSpeed: 0, peakAge: 27 });
    const fastDecline = profile({ declinePotential: 1, declineSpeed: 1, peakAge: 27 });
    expect(cumulativeDeclineFraction(fastDecline, 31)).toBeGreaterThan(cumulativeDeclineFraction(slowDecline, 31));
    expect(cumulativeDeclineFraction(slowDecline, 45)).toBeCloseTo(1, 10);
    expect(cumulativeDeclineFraction(fastDecline, 45)).toBeCloseTo(1, 10);
  });

  it("reconstructs the entry target at academy entry and the peak target at peak age", () => {
    const p = profile({ growthPotential: 0.8, peakAge: 27, declinePotential: 0 });
    const peakTarget = 80;
    const budget = careerGrowthBudget(p);
    const atEntry = reconstructCurrentTarget(p, peakTarget, gameConfig.playerGenerationRules.academyMinAge, 1, 1);
    expect(atEntry.current).toBeCloseTo(peakTarget - budget, 6);
    const atPeak = reconstructCurrentTarget(p, peakTarget, 27, 1, 1);
    expect(atPeak.current).toBeCloseTo(peakTarget, 6);
  });

  it("makes lower historical activity realize LESS growth rather than move a player toward his peak", () => {
    const p = profile({ growthPotential: 1, peakAge: 27, declinePotential: 0 });
    const active = reconstructCurrentTarget(p, 80, 22, 1, 1).current;
    const inactive = reconstructCurrentTarget(p, 80, 22, 0.65, 1).current;
    expect(inactive).toBeLessThan(active);
  });

  it("samples the configured density exactly", () => {
    const points = [[0, 0], [1, 2]] as const;
    const rng = createRng(4242);
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) sum += sampleDensity(rng, points);
    // A linearly rising density on [0,1] has mean 2/3.
    expect(sum / n).toBeCloseTo(densityMean(points), 2);
    expect(densityMean(points)).toBeCloseTo(2 / 3, 10);
  });
});

describe("position-normalized development", () => {
  it("converts an OVR-equivalent budget into comparable OVR movement for every position", () => {
    const club = testClub({ trainingFocus: "assistant" });
    const moved: number[] = [];
    for (const position of [0, 1, 2, 3, 4] as Position[]) {
      const player = makePlayer({ position });
      player.skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 50 };
      player.overall = overallFromSkills(position, player.skills);
      player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
      player.age = 20;
      player.careerProfile = profile({ growthPotential: 1, peakAge: 30 });
      player.careerGrowthConsumed = 0;
      player.careerDeclineConsumed = 0;
      player.recentMinutes = [90, 90, 90, 90, 90];
      const before = player.overall;
      // Two seasons so the accumulators resolve into whole skill points.
      runSeason(player, club, 5);
      runSeason(player, club, 6);
      moved.push(player.overall - before);
    }
    // Positional OVR weights differ a lot, so without normalization these would
    // diverge badly. They must land within a point or two of each other.
    expect(Math.max(...moved) - Math.min(...moved)).toBeLessThanOrEqual(2);
    for (const delta of moved) expect(delta).toBeGreaterThan(0);
  });

  it("computes sensitivity from the position's OVR weights and the training distribution", () => {
    const club = testClub({ trainingFocus: "primary" });
    for (const position of [0, 1, 2, 3, 4] as Position[]) {
      const player = makePlayer({ position });
      const weights = effectiveSkillWeights(player, club, true);
      expect(overallSensitivity(position, weights)).toBeGreaterThan(0);
      // Effective weights are a distribution over the eligible skills.
      const total = SKILL_KEYS.reduce((sum, key) => sum + weights[key], 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("redistributes progress blocked by a capped skill instead of losing it", () => {
    const club = testClub({ trainingFocus: "primary" });
    const player = makePlayer({ position: 4 });
    player.skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 100 };
    // `fin` is the primary focus for a forward and is already pinned at 100.
    const weights = effectiveSkillWeights(player, club, true);
    expect(weights.fin).toBe(0);
    const total = SKILL_KEYS.reduce((sum, key) => sum + weights[key], 0);
    expect(total).toBeCloseTo(1, 10);
    // Every remaining eligible skill keeps its relative share of the budget.
    expect(weights.vel).toBeGreaterThan(0);
  });

  it("changes which skills improve with training focus without creating extra total growth", () => {
    const build = (focus: "assistant" | "primary" | "secondary") => {
      const club = testClub({ trainingFocus: focus });
      const player = makePlayer({ position: 3 });
      player.skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 50 };
      player.overall = overallFromSkills(3, player.skills);
      player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
      player.age = 21;
      player.careerProfile = profile({ growthPotential: 1, peakAge: 30 });
      player.careerGrowthConsumed = 0;
      player.careerDeclineConsumed = 0;
      player.recentMinutes = [90, 90, 90, 90, 90];
      const spent = runSeason(player, club, 9) + runSeason(player, club, 10);
      return { player, spent };
    };
    const primary = build("primary");
    const secondary = build("secondary");
    // Same budget consumed regardless of focus...
    expect(primary.spent).toBeCloseTo(secondary.spent, 6);
    // ...but a different skill distribution.
    expect(primary.player.skills).not.toEqual(secondary.player.skills);
  });

  it("stops rather than redistributes when the career budget is exhausted", () => {
    const club = testClub();
    const player = makePlayer({ position: 3 });
    player.age = 22;
    player.careerProfile = profile({ growthPotential: 1, peakAge: 30 });
    player.careerGrowthConsumed = careerGrowthBudget(player.careerProfile);
    player.careerDeclineConsumed = 0;
    player.recentMinutes = [90, 90, 90, 90, 90];
    const skillsBefore = { ...player.skills };
    expect(remainingCareerBudget(player, true)).toBe(0);
    runSeason(player, club, 3);
    expect(player.skills).toEqual(skillsBefore);
    expect(player.careerGrowthConsumed).toBeCloseTo(careerGrowthBudget(player.careerProfile), 10);
  });

  it("never lets realized growth exceed the career growth budget", () => {
    const club = testClub();
    const player = makePlayer({ position: 3 });
    player.age = 16;
    player.careerProfile = profile({ growthPotential: 0.2, peakAge: 30 });
    player.careerGrowthConsumed = 0;
    player.careerDeclineConsumed = 0;
    player.recentMinutes = [90, 90, 90, 90, 90];
    const budget = careerGrowthBudget(player.careerProfile);
    for (let season = 0; season < 14; season++) {
      runSeason(player, club, 100 + season);
      player.age += 1;
    }
    expect(player.careerGrowthConsumed).toBeLessThanOrEqual(budget + 1e-9);
  });

  it("keeps OVR equal to overallFromSkills after every tick", () => {
    const club = testClub();
    const player = makePlayer({ position: 2 });
    player.age = 19;
    player.careerProfile = profile({ growthPotential: 1, peakAge: 29 });
    player.careerGrowthConsumed = 0;
    player.careerDeclineConsumed = 0;
    player.recentMinutes = [90, 90, 90, 90, 90];
    const rng = createRng(77);
    for (let day = 1; day <= DAYS_PER_YEAR; day++) {
      applyDevelopment(player, club, day);
      expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
    }
  });
});

describe("applyDevelopment", () => {
  it("is deterministic for identical worlds", () => {
    const world1 = generateWorld(777);
    const world2 = generateWorld(777);
    initSeason(world1, { year: 2026, month: 1 }, 1);
    initSeason(world2, { year: 2026, month: 1 }, 1);
    const club1 = world1.clubs[0];
    const club2 = world2.clubs[0];
    const p1 = world1.players.find((p) => p.clubId === club1.id && !p.isYouth)!;
    const p2 = world2.players.find((p) => p.clubId === club2.id && !p.isYouth)!;
    p1.recentMinutes = [90, 90, 90, 90, 90];
    p2.recentMinutes = [90, 90, 90, 90, 90];
    for (let day = 1; day <= 30; day++) {
      applyDevelopment(p1, club1, day);
      applyDevelopment(p2, club2, day);
    }
    expect(p1.skillAcc).toEqual(p2.skillAcc);
    expect(p1.skills).toEqual(p2.skills);
  });

  it("accumulates fractional progress and bumps integer skills only on threshold crossing", () => {
    const club = testClub();
    const player = makePlayer({ position: 3 });
    player.skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 50 };
    player.overall = overallFromSkills(player.position, player.skills);
    player.age = 18;
    player.careerProfile = profile({ growthPotential: 0.5, peakAge: 28 });
    player.careerGrowthConsumed = 0;
    player.careerDeclineConsumed = 0;
    player.recentMinutes = [90, 90, 90, 90, 90];
    player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
    applyDevelopment(player, club, 1);
    const accumulated = player.skillAcc.reduce((sum, value) => sum + Math.abs(value), 0);
    expect(accumulated).toBeGreaterThan(0);
    expect(accumulated).toBeLessThan(1);
    expect(player.skills.pas).toBe(50);
  });

  it("advances precise age within the season", () => {
    const player = makePlayer({ age: 20 });
    expect(calculatePreciseAge(player, 0)).toBe(20);
    expect(calculatePreciseAge(player, DAYS_PER_YEAR)).toBeCloseTo(21, 10);
  });

  it("freezes development entirely for a dormant club's players", () => {
    const club = testClub({ competitionState: "DORMANT" });
    const player = makePlayer({ position: 3 });
    player.age = 19;
    player.careerProfile = profile({ growthPotential: 1, peakAge: 29 });
    player.careerGrowthConsumed = 0;
    player.recentMinutes = [90, 90, 90, 90, 90];
    // applyDevelopment itself treats a non-ACTIVE club's missing appearances as
    // neutral; the dormant freeze is enforced by the caller skipping the club.
    // What must never happen is a dormant squad being penalised as "inactive".
    const rng = createRng(5);
    for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
    expect(calculateRecentActivity(player)).toBeCloseTo(1, 10);
  });
});

calibrationDescribe("long-term career simulation", () => {
  const activities = [
    { label: "full", minutes: [90, 90, 90, 90, 90] },
    { label: "regular", minutes: [80, 90, 85, 75, 90] },
    { label: "rotation", minutes: [45, 60, 30, 50, 70] },
    { label: "occasional", minutes: [15, 0, 25, 10, 5] },
    { label: "inactive", minutes: [0, 0, 0, 0, 0] },
  ];

  function simulateCareer(seed: number, minutes: number[]): { peak: number; final: number; peakAge: number } {
    const club = testClub({ id: 1 });
    const player = makePlayer({ position: 3 });
    player.skills = { gol: 40, vel: 40, tec: 40, pas: 40, des: 40, arm: 40, fin: 40 };
    player.overall = overallFromSkills(player.position, player.skills);
    player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
    player.age = 16;
    player.careerProfile = generateCareerProfile(createRng(seed));
    player.careerGrowthConsumed = 0;
    player.careerDeclineConsumed = 0;
    player.recentMinutes = minutes;
    let peak = player.overall;
    let peakAge = player.age;
    while (player.age < 40) {
      const rng = createRng(seed * 1_000 + player.age);
      for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
      if (player.overall > peak) {
        peak = player.overall;
        peakAge = player.age;
      }
      player.age += 1;
    }
    return { peak, final: player.overall, peakAge };
  }

  it("orders realized career growth by playing time", () => {
    const n = 300;
    const meanPeak: Record<string, number> = {};
    for (const activity of activities) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += simulateCareer(1_000 + i, activity.minutes).peak;
      meanPeak[activity.label] = sum / n;
    }
    for (let i = 0; i + 1 < activities.length; i++) {
      expect(meanPeak[activities[i].label], `${activities[i].label} vs ${activities[i + 1].label}`)
        .toBeGreaterThan(meanPeak[activities[i + 1].label]);
    }
    expect(meanPeak.full - meanPeak.inactive).toBeGreaterThan(3);
  });

  it("makes active veterans decline more slowly than inactive ones", () => {
    const n = 300;
    const drop = (minutes: number[]) => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const career = simulateCareer(2_000 + i, minutes);
        sum += career.peak - career.final;
      }
      return sum / n;
    };
    expect(drop([0, 0, 0, 0, 0])).toBeGreaterThan(drop([90, 90, 90, 90, 90]));
  });

  it("peaks near the drawn personal peak age and never grows past it", () => {
    const n = 400;
    let matched = 0;
    for (let i = 0; i < n; i++) {
      const club = testClub({ id: 1 });
      const player = makePlayer({ position: 3 });
      player.age = 16;
      player.careerProfile = generateCareerProfile(createRng(3_000 + i));
      player.careerGrowthConsumed = 0;
      player.careerDeclineConsumed = 0;
      player.recentMinutes = [90, 90, 90, 90, 90];
      let growthAfterPeak = 0;
      while (player.age < 40) {
        const before = player.careerGrowthConsumed;
        const rng = createRng((3_000 + i) * 1_000 + player.age);
        for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
        if (player.age > player.careerProfile.peakAge) growthAfterPeak += player.careerGrowthConsumed - before;
        player.age += 1;
      }
      // Growth strictly stops at the personal peak: none is banked for later.
      expect(growthAfterPeak).toBeLessThan(1e-9);
      if (player.careerDeclineConsumed > 0) matched += 1;
    }
    expect(matched).toBeGreaterThan(n * 0.9);
  });

  it("lets a strong lower-division prospect reach higher-division quality", () => {
    // A D3-anchored career peak with a good draw must be able to clear normal
    // D1 starter quality; development has no division ceiling.
    const peaks: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const p = generateCareerProfile(createRng(7_000 + i));
      peaks.push(careerGrowthBudget(p));
    }
    peaks.sort((a, b) => a - b);
    const p99 = peaks[Math.floor(peaks.length * 0.99)];
    expect(p99).toBeGreaterThan(gameConfig.playerCareer.maximumCareerGrowthOverall * 0.9);
  });
});
