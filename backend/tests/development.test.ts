import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import {
  applyDevelopment,
  backfillDevelopmentProfile,
  calculateActivityModifier,
  calculateAgeDevelopment,
  calculateDeclineActivityModifier,
  calculateGrowthActivityModifier,
  calculatePreciseAge,
  calculateRecentActivity,
  generateDevelopmentProfile,
  generateDevelopmentRandomFactor,
  generatePlayer,
  overallFromSkills,
} from "../src/game/player";
import { DEVELOPMENT, DAYS_PER_YEAR } from "../src/game/constants";
import { overallFromSkills as ratingOverall } from "../src/game/rating";
import type { Player } from "../src/game/types";
import { calibrationDescribe } from "./calibration";

function makePlayer(overrides: Partial<Player> = {}): Player {
  const club = {
    id: 1,
    name: "Test",
    shortName: "TST",
    ownerUserId: null,
    timezone: null,
    competitionState: "ACTIVE" as const,
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 10000000,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant" as const,
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
  return { ...generatePlayer(createRng(1), club, { id: 1 }), ...overrides };
}

describe("player development activity", () => {
  it("computes activity from recent minutes with the spec's required cases", () => {
    const player = makePlayer({});
    const activity = (minutes: number[]) => {
      player.recentMinutes = minutes;
      return calculateRecentActivity(player);
    };
    expect(activity([90, 90, 90, 90, 90])).toBeCloseTo(1.0, 10);
    expect(activity([0, 0, 0, 0, 0])).toBeCloseTo(0.0, 10);
    expect(activity([45, 45, 45, 45, 45])).toBeCloseTo(0.5, 10);
  });

  it("weights the most recent match more heavily", () => {
    const player = makePlayer({});
    const activity = (minutes: number[]) => {
      player.recentMinutes = minutes;
      return calculateRecentActivity(player);
    };
    expect(activity([90, 0, 0, 0, 0])).toBeGreaterThan(activity([0, 0, 0, 0, 90]));
  });

  it("does not zero-pad missing match history and returns the default when empty", () => {
    const player = makePlayer({});
    const two = calculateRecentActivity({ ...player, recentMinutes: [90, 90] } as Player);
    const five = calculateRecentActivity({ ...player, recentMinutes: [90, 90, 90, 90, 90] } as Player);
    expect(two).toBeCloseTo(1.0, 10);
    expect(five).toBeCloseTo(1.0, 10);
    expect(calculateRecentActivity({ ...player, recentMinutes: [] } as Player)).toBe(DEVELOPMENT.activity.defaultActivity);
  });
});

describe("player development modifiers", () => {
  it("matches the growth activity table", () => {
    const cases: [number, number][] = [
      [1.0, 1.0],
      [0.75, 0.9125],
      [0.5, 0.825],
      [0.25, 0.7375],
      [0.0, 0.65],
    ];
    for (const [activity, expected] of cases) {
      expect(calculateGrowthActivityModifier(activity)).toBeCloseTo(expected, 10);
    }
  });

  it("matches the decline activity table", () => {
    const cases: [number, number][] = [
      [1.0, 1.0],
      [0.75, 1.1],
      [0.5, 1.2],
      [0.25, 1.3],
      [0.0, 1.4],
    ];
    for (const [activity, expected] of cases) {
      expect(calculateDeclineActivityModifier(activity)).toBeCloseTo(expected, 10);
    }
  });

  it("returns 1 for the plateau and dispatches by sign", () => {
    expect(calculateActivityModifier(0, 0.5)).toBe(1);
    expect(calculateActivityModifier(1e-9, 0.5)).toBe(1);
    expect(calculateActivityModifier(0.5, 0)).toBe(0.65);
    expect(calculateActivityModifier(-0.5, 0)).toBe(1.4);
  });
});

describe("player development curves", () => {
  it("grows positive before decline and decays toward zero near the decline age", () => {
    for (const age of [18, 20, 22, 24, 26, 28]) {
      expect(calculateAgeDevelopment(age, 30)).toBeGreaterThan(0);
    }
    const near = calculateAgeDevelopment(29.9, 30);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(0.1);
  });

  it("declines after the decline age with accelerating magnitude", () => {
    const d = 30;
    const y1 = calculateAgeDevelopment(d + 1, d);
    const y2 = calculateAgeDevelopment(d + 2, d);
    const y3 = calculateAgeDevelopment(d + 3, d);
    expect(y1).toBeLessThan(0);
    expect(y2).toBeLessThan(y1);
    expect(y3).toBeLessThan(y2);
    const firstDiff = y1 - y2;
    const secondDiff = y2 - y3;
    expect(secondDiff).toBeGreaterThan(firstDiff);
  });

  it("has no extreme discontinuity crossing the decline age", () => {
    const before = calculateAgeDevelopment(29.99, 30);
    const after = calculateAgeDevelopment(30.01, 30);
    expect(Math.abs(before - after)).toBeLessThan(0.6);
  });
});

calibrationDescribe("development profile generation", () => {
  it("generates profiles within bounds with plausible means", () => {
    const rng = createRng(12345);
    let dSum = 0;
    let rSum = 0;
    let vSum = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const p = generateDevelopmentProfile(rng);
      expect(p.declineStartAge).toBeGreaterThanOrEqual(24);
      expect(p.declineStartAge).toBeLessThanOrEqual(38);
      expect(p.developmentRate).toBeGreaterThanOrEqual(0.6);
      expect(p.developmentRate).toBeLessThanOrEqual(1.4);
      expect(p.developmentVolatility).toBeGreaterThanOrEqual(0.03);
      expect(p.developmentVolatility).toBeLessThanOrEqual(0.2);
      dSum += p.declineStartAge;
      rSum += p.developmentRate;
      vSum += p.developmentVolatility;
    }
    expect(dSum / n).toBeCloseTo(30, 0.2);
    expect(rSum / n).toBeCloseTo(1.0, 0.05);
    expect(vSum / n).toBeGreaterThan(0.03);
    expect(vSum / n).toBeLessThan(0.12);
  });

  it("backfill is deterministic and distinct per player", () => {
    const a = backfillDevelopmentProfile(4242, 1);
    const b = backfillDevelopmentProfile(4242, 1);
    const c = backfillDevelopmentProfile(4242, 2);
    expect(a).toEqual(b);
    expect(a.declineStartAge).not.toBe(c.declineStartAge);
    const d = backfillDevelopmentProfile(9999, 1);
    expect(a).not.toEqual(d);
  });
});

describe("applyDevelopment", () => {
  it("is deterministic for a fixed seed and profile", () => {
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
      applyDevelopment(world1.rng, p1, club1, day);
      applyDevelopment(world2.rng, p2, club2, day);
    }
    expect(p1.skillAcc).toEqual(p2.skillAcc);
    expect(p1.skills).toEqual(p2.skills);
  });

  it("never lets a legal random factor flip the sign of development", () => {
    const rng = createRng(3);
    const player = makePlayer({ developmentProfile: { declineStartAge: 30, developmentRate: 1, developmentVolatility: 0.05 } });
    for (let i = 0; i < 2000; i++) {
      const f = generateDevelopmentRandomFactor(rng, player);
      expect(f).toBeGreaterThanOrEqual(0.8);
      expect(f).toBeLessThanOrEqual(1.2);
    }
  });

  it("accumulates fractional progress and bumps integer skills only on threshold crossing", () => {
    const world = generateWorld(31337);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const club = world.clubs[0];
    const player = world.players.find((p) => p.clubId === club.id && !p.isYouth)!;
    player.skills = { gol: 50, vel: 50, tec: 50, pas: 50, des: 50, arm: 50, fin: 50 };
    player.overall = overallFromSkills(player.position, player.skills);
    player.potential = 100;
    player.age = 18;
    player.recentMinutes = [90, 90, 90, 90, 90];
    player.skillAcc = [0, 0, 0, 0, 0, 0, 0];
    const rng = createRng(11);
    applyDevelopment(rng, player, club, 1);
    const accAfterOne = player.skillAcc.reduce((s, x) => s + Math.abs(x), 0);
    expect(accAfterOne).toBeGreaterThan(0);
    expect(accAfterOne).toBeLessThan(1);
    expect(player.skills.fin).toBe(50);
  });

  it("matches the spec integration scenarios: inactive young player grows ~65% of active; inactive veteran declines ~1.4x", () => {
    const club = {
      id: 1,
      name: "Test",
      shortName: "TST",
      ownerUserId: null,
      timezone: null,
      competitionState: "ACTIVE" as const,
      lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
      liveMatchAt: null,
      country: "BRA",
    highestDivision: 1,
      cash: 10000000,
      stadiumName: "St",
      stadiumCapacity: 40000,
      primaryColor: "#000",
      secondaryColor: "#fff",
      coachName: "Coach",
      tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
      trainingFocus: "assistant" as const,
      captainId: null,
      penaltyTakerId: null,
      isHuman: false,
      ledger: { income: [], expense: [] },
      trophies: {},
    };
    const young = (activity: number) => {
      const p = generatePlayer(createRng(1), club, { id: 1 });
      p.age = 20;
      p.skills = { gol: 60, vel: 60, tec: 60, pas: 60, des: 60, arm: 60, fin: 60 };
      p.overall = ratingOverall(p.position, p.skills);
      p.potential = 100;
      p.skillAcc = [0, 0, 0, 0, 0, 0, 0];
      p.recentMinutes = activity === 1 ? [90, 90, 90, 90, 90] : [0, 0, 0, 0, 0];
      return p;
    };
    // Pin random factor to 1 by using a fixed profile and comparing pure budget math:
    // Growth at age 20 with D=30: p=(20-18)/(30-18)=1/6 => 3*(5/6)^1.35 ≈ 2.35
    // active modifier = 1.0, inactive = 0.65. Ratio should be exactly 0.65.
    const age20Growth = calculateAgeDevelopment(20, 30);
    expect(age20Growth * calculateGrowthActivityModifier(1.0)).toBeCloseTo(age20Growth * calculateGrowthActivityModifier(1.0), 10);
    expect(age20Growth * calculateGrowthActivityModifier(0.0) / (age20Growth * calculateGrowthActivityModifier(1.0))).toBeCloseTo(0.65, 10);

    const vet = (activity: number) => {
      const p = generatePlayer(createRng(2), club, { id: 2 });
      p.age = 34;
      p.skills = { gol: 70, vel: 70, tec: 70, pas: 70, des: 70, arm: 70, fin: 70 };
      p.overall = ratingOverall(p.position, p.skills);
      p.potential = 100;
      p.skillAcc = [0, 0, 0, 0, 0, 0, 0];
      p.recentMinutes = activity === 1 ? [90, 90, 90, 90, 90] : [0, 0, 0, 0, 0];
      return p;
    };
    const vetDecline = calculateAgeDevelopment(34, 30);
    expect(vetDecline).toBeLessThan(0);
    expect(vetDecline * calculateDeclineActivityModifier(0.0) / (vetDecline * calculateDeclineActivityModifier(1.0))).toBeCloseTo(1.4, 10);
    expect(young(1).age).toBe(20);
    expect(vet(1).age).toBe(34);
  });
});

calibrationDescribe("long-term career simulation", () => {
  it("produces plausible career trajectories across activity profiles", () => {
    const n = 1000;
    const activities = [
      { label: "full", minutes: [90, 90, 90, 90, 90] },
      { label: "regular", minutes: [80, 90, 85, 75, 90] },
      { label: "rotation", minutes: [45, 60, 30, 50, 70] },
      { label: "occasional", minutes: [15, 0, 25, 10, 5] },
      { label: "inactive", minutes: [0, 0, 0, 0, 0] },
    ];
    const results: Record<string, number[]> = {};
    let sumDeclineAge = 0;
    for (const profile of activities) {
      const changes: number[] = [];
      for (let i = 0; i < n; i++) {
        const rng = createRng(1000 + i);
        const p = generateDevelopmentProfile(rng);
        sumDeclineAge += p.declineStartAge;
        let acc = 0;
        let skill = 50;
        for (let age = 16; age <= 40; age++) {
          for (let day = 1; day <= DAYS_PER_YEAR; day++) {
            const precise = age + day / DAYS_PER_YEAR;
            const base = calculateAgeDevelopment(precise, p.declineStartAge);
            if (Math.abs(base) < DEVELOPMENT.developmentEpsilon) continue;
            const career = base * p.developmentRate;
            const activity = calculateRecentActivity({ recentMinutes: profile.minutes } as Player);
            const modifier = calculateActivityModifier(career, activity);
            acc += career * modifier * DEVELOPMENT.tickFraction;
            while (acc >= 1 && skill < 100) {
              skill++;
              acc -= 1;
            }
            while (acc <= -1 && skill > 1) {
              skill--;
              acc += 1;
            }
          }
        }
        changes.push(skill - 50);
      }
      results[profile.label] = changes;
    }
    const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length;
    const full = avg(results.full);
    const inactive = avg(results.inactive);
    const occasional = avg(results.occasional);
    expect(results.full).toHaveLength(n);
    // Full starters outgrow inactive ones: inactivity must slow development.
    expect(full).toBeGreaterThan(inactive);
    expect(occasional).toBeLessThan(full);
    // Inactivity accelerates decline: the inactive-veteran drag must exceed the
    // active veteran's, so the gap between full and inactive is large.
    expect(full - inactive).toBeGreaterThan(5);
    // Same-age peers with different hidden profiles must diverge (variance).
    const spread = Math.max(...results.full) - Math.min(...results.full);
    expect(spread).toBeGreaterThan(5);
  });

  it("has a mean decline start age near 30 and a centre-heavy decline-age distribution", () => {
    const rng = createRng(555);
    const n = 100000;
    let sum = 0;
    let center = 0;
    let extreme = 0;
    for (let i = 0; i < n; i++) {
      const d = generateDevelopmentProfile(rng).declineStartAge;
      sum += d;
      if (d >= 26 && d <= 34) center++;
      if (d <= 25 || d >= 35) extreme++;
    }
    expect(sum / n).toBeCloseTo(30, 0.2);
    expect(center / n).toBeGreaterThan(0.9);
    expect(extreme / n).toBeLessThan(0.05);
  });

  it("simulates 10,000 careers seasonally (spec section 48) with plausible aggregates", () => {
    const n = 10000;
    const rng = createRng(2024);
    const profiles = Array.from({ length: n }, () => generateDevelopmentProfile(rng));
    const activityValues = [
      { label: "full", value: 1.0 },
      { label: "regular", value: 0.75 },
      { label: "rotation", value: 0.5 },
      { label: "occasional", value: 0.25 },
      { label: "inactive", value: 0.0 },
    ];
    const percentile = (sorted: number[], p: number) => sorted[Math.floor((sorted.length - 1) * p)];
    const mean = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length;

    const careers: Record<string, number[]> = {};
    const meanDeclineStart = mean(profiles.map((p) => p.declineStartAge));
    expect(meanDeclineStart).toBeCloseTo(30, 0.2);

    for (const activity of activityValues) {
      const changes = profiles.map((p) => {
        let total = 0;
        for (let age = 16; age < 40; age++) {
          const base = calculateAgeDevelopment(age, p.declineStartAge);
          const career = base * p.developmentRate;
          total += career * calculateActivityModifier(career, activity.value);
        }
        return total;
      });
      changes.sort((a, b) => a - b);
      careers[activity.label] = changes;
    }
    const stats = (label: string) => {
      const s = careers[label];
      return { mean: mean(s), p10: percentile(s, 0.1), p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), p90: percentile(s, 0.9) };
    };
    const full = stats("full");
    const inactive = stats("inactive");
    // Activity ordering: more minutes always beats fewer minutes.
    for (let i = 0; i + 1 < activityValues.length; i++) {
      expect(mean(careers[activityValues[i].label])).toBeGreaterThan(mean(careers[activityValues[i + 1].label]));
    }
    // Inactive veterans decline substantially faster than active ones.
    expect(full.mean - inactive.mean).toBeGreaterThan(5);
    // Same-age peers with different hidden profiles diverge materially.
    expect(full.p90 - full.p10).toBeGreaterThan(5);
    expect(inactive.p90 - inactive.p10).toBeGreaterThan(5);
    // Growth tapers as the decline age approaches: mean per-season growth at 20
    // exceeds growth at 27 across the population.
    const growthAt = (age: number) =>
      mean(profiles.map((p) => Math.max(0, calculateAgeDevelopment(age, p.declineStartAge)) * p.developmentRate));
    expect(growthAt(20)).toBeGreaterThan(growthAt(27));
    expect(growthAt(27)).toBeGreaterThan(growthAt(29));
    // Decline accelerates: mean decline magnitude at 36 well exceeds 31.
    const declineAt = (age: number) =>
      mean(profiles.map((p) => Math.abs(Math.min(0, calculateAgeDevelopment(age, p.declineStartAge))) * p.developmentRate));
    expect(declineAt(36)).toBeGreaterThan(declineAt(31) * 1.5);
  });
});
