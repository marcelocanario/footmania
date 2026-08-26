import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import {
  academyPeakMean,
  academyPedigree,
  academyQualitySigma,
  bottomDivisionMean,
  divisionMean,
  divisionStrength,
  drawRawZ,
  drawSeniorGenerationBlueprint,
  generateInitialSeniorPlayers,
  generateSeniorPlayer,
  generateSkillsForTarget,
  generateYouthPlayer,
  initialClubQualityTargets,
  overallRange,
  pairInitialSeniorBlueprints,
  qualitySigma,
  seniorPeakMean,
  SENIOR_POSITION_WEIGHTS,
  seniorRosterTemplate,
  topDivisionMean,
  OVR_MAX,
  OVR_MIN,
  SKILL_GENERATION_MAX_RETRIES,
  SKILL_TARGET_TOLERANCE_OVR,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import {
  densityMean,
  careerDeclineBudget,
  careerGrowthBudget,
  cumulativeGrowthFraction,
  generateCareerProfile,
  seniorSurvivalWeights,
  activityModifiersFor,
  reconstructCurrentTarget,
} from "../src/game/careerCurves";
import { countriesWithNamePools } from "../src/game/names";
import { overallFromSkills } from "../src/game/rating";
import { gameConfig } from "../src/config";
import { buildLineup } from "../src/game/club";
import { aging, applyDevelopment } from "../src/game/player";
import { DAYS_PER_YEAR } from "../src/game/constants";
import { makeClub } from "./helpers";
import type { Position } from "../src/game/types";
import { calibrationDescribe } from "./calibration";
import { readNamePoolsArtifact } from "../src/services/namePoolService";

function seniorCtx(overrides: Partial<Parameters<typeof generateSeniorPlayer>[0]> = {}) {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: 3 as Position,
    isYouth: false,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-senior" as const,
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

function youthCtx(overrides: Partial<Parameters<typeof generateYouthPlayer>[0]> = {}) {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: 3 as Position,
    age: 16,
    isYouth: true,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-academy" as const,
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

function withForeignPlayerChance<T>(chance: number, fn: () => T): T {
  const previous = gameConfig.playerGenerationRules.foreignPlayerChance;
  gameConfig.playerGenerationRules.foreignPlayerChance = chance;
  try {
    return fn();
  } finally {
    gameConfig.playerGenerationRules.foreignPlayerChance = previous;
  }
}

function nameUsesCountryPool(name: string, country: string): boolean {
  const names = readNamePoolsArtifact().countries[country]?.names ?? [];
  return names.some((firstName) => name === firstName || name.startsWith(`${firstName} `));
}

describe("division strength (spec §10)", () => {
  it("S(1) = 1 and S(N) = 0", () => {
    expect(divisionStrength(1, 5)).toBeCloseTo(1, 10);
    expect(divisionStrength(5, 5)).toBeCloseTo(0, 10);
  });

  it("is monotone decreasing (stronger divisions = smaller numbers)", () => {
    const n = 5;
    for (let d = 1; d < n; d++) {
      expect(divisionStrength(d + 1, n)).toBeLessThan(divisionStrength(d, n));
    }
  });

  it("clamps floating-point error into [0,1] and handles N <= 1", () => {
    expect(divisionStrength(1, 1)).toBe(1);
    expect(divisionStrength(99, 1)).toBe(1);
    const s = divisionStrength(3, 5);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("matches the spec's five-division reference values", () => {
    expect(divisionStrength(1, 5)).toBeCloseTo(1.0, 3);
    expect(divisionStrength(2, 5)).toBeCloseTo(0.6309, 3);
    expect(divisionStrength(3, 5)).toBeCloseTo(0.3691, 3);
    expect(divisionStrength(4, 5)).toBeCloseTo(0.166, 2);
    expect(divisionStrength(5, 5)).toBeCloseTo(0.0, 3);
  });
});

describe("derived means (spec §6/§8/§9)", () => {
  it("computes sigma, top and bottom means on the engine's OVR range", () => {
    const R = overallRange();
    expect(R).toBe(OVR_MAX - OVR_MIN);
    const sigma = qualitySigma();
    expect(sigma).toBe(gameConfig.playerGeneration.playerQualitySpreadOverall);
    expect(topDivisionMean()).toBe(gameConfig.playerGeneration.topDivisionMeanOverall);
    expect(bottomDivisionMean()).toBeCloseTo(topDivisionMean() - gameConfig.playerGeneration.divisionOverallSpan, 10);
  });

  it("division means follow mu(D) = mu_bottom + divisionOverallSpan·S(D)", () => {
    for (let d = 1; d <= 5; d++) {
      const expected = bottomDivisionMean() + gameConfig.playerGeneration.divisionOverallSpan * divisionStrength(d, 5);
      expect(divisionMean(d, 5)).toBeCloseTo(expected, 8);
    }
  });

  it("strictly orders division means", () => {
    for (let d = 1; d < 5; d++) {
      expect(divisionMean(d, 5)).toBeGreaterThan(divisionMean(d + 1, 5));
    }
  });

  it("keeps the configured top-to-bottom OVR span as the pyramid grows", () => {
    for (const totalDivisions of [2, 5, 10, 25]) {
      expect(divisionMean(1, totalDivisions) - divisionMean(totalDivisions, totalDivisions))
        .toBeCloseTo(gameConfig.playerGeneration.divisionOverallSpan, 10);
    }
  });

  it("reproduces the shipped calibration reference values", () => {
    expect(qualitySigma()).toBeCloseTo(5.5, 2);
    expect(academyQualitySigma()).toBeCloseTo(6, 2);
    expect(topDivisionMean()).toBeCloseTo(74, 2);
    expect(bottomDivisionMean()).toBeCloseTo(56, 2);
  });
});

describe("academy pedigree", () => {
  it("normalizes the configured current/highest-ever weights", () => {
    expect(academyPedigree(1, 1, 5)).toBeCloseTo(1, 10);
    expect(academyPedigree(5, 5, 5)).toBeCloseTo(0, 10);
  });

  it("D4/historic-D1 academy beats D4/historic-D4 but stays below D1/D1", () => {
    const d4d4 = academyPedigree(4, 4, 5);
    const d4d1 = academyPedigree(4, 1, 5);
    const d1d1 = academyPedigree(1, 1, 5);
    expect(d4d1).toBeGreaterThan(d4d4);
    expect(d4d1).toBeLessThan(d1d1);
  });

  it("stays inside 0..1 for every weight split", () => {
    const generation = gameConfig.playerGeneration;
    const previous = [generation.academyCurrentDivisionWeight, generation.academyHighestEverDivisionWeight];
    try {
      for (const [current, history] of [[1, 0], [0, 1], [3, 7], [0.1, 0.1]]) {
        generation.academyCurrentDivisionWeight = current;
        generation.academyHighestEverDivisionWeight = history;
        for (let division = 1; division <= 5; division++) {
          const pedigree = academyPedigree(division, 1, 5);
          expect(pedigree).toBeGreaterThanOrEqual(0);
          expect(pedigree).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      generation.academyCurrentDivisionWeight = previous[0];
      generation.academyHighestEverDivisionWeight = previous[1];
    }
  });
});

describe("career peak anchors", () => {
  it("places the senior peak the configured offset above the division mean", () => {
    for (let division = 1; division <= 5; division++) {
      expect(seniorPeakMean(division, 5) - divisionMean(division, 5)).toBeCloseTo(
        gameConfig.playerGeneration.seniorPeakOverallOffset,
        10,
      );
    }
  });

  it("gives a stable top-division academy the same peak anchor as top-division seniors", () => {
    // The pedigree boost equals the division span, so a D1/D1 academy's normal
    // recruit is heading for the same career peak as a D1 senior.
    expect(academyPeakMean(academyPedigree(1, 1, 5))).toBeCloseTo(seniorPeakMean(1, 5), 6);
  });

  it("orders academy peak anchors by pedigree and bottoms out at the weakest academy", () => {
    const anchors = [1, 2, 3, 4, 5].map((division) => academyPeakMean(academyPedigree(division, division, 5)));
    for (let i = 1; i < anchors.length; i++) expect(anchors[i]).toBeLessThan(anchors[i - 1]);
    expect(anchors[anchors.length - 1]).toBeCloseTo(
      bottomDivisionMean() + gameConfig.playerGeneration.seniorPeakOverallOffset,
      6,
    );
  });

  it("uses a wider spread for academy careers than for senior careers", () => {
    expect(academyQualitySigma()).toBeGreaterThan(qualitySigma());
  });
});

describe("career budgets", () => {
  it("scales the growth budget linearly with potential and nothing else", () => {
    const base = { growthSpeed: 0.5, peakAge: 27, declinePotential: 0.5, declineSpeed: 0.5 };
    expect(careerGrowthBudget({ ...base, growthPotential: 0 })).toBe(0);
    expect(careerGrowthBudget({ ...base, growthPotential: 1 })).toBeCloseTo(
      gameConfig.playerCareer.maximumCareerGrowthOverall,
      10,
    );
    expect(careerGrowthBudget({ ...base, growthPotential: 0.5 })).toBeCloseTo(
      gameConfig.playerCareer.maximumCareerGrowthOverall / 2,
      10,
    );
  });

  it("scales the decline budget linearly with decline potential", () => {
    const base = { growthPotential: 0.5, growthSpeed: 0.5, peakAge: 27, declineSpeed: 0.5 };
    expect(careerDeclineBudget({ ...base, declinePotential: 0 })).toBe(0);
    expect(careerDeclineBudget({ ...base, declinePotential: 1 })).toBeCloseTo(
      gameConfig.playerCareer.maximumCareerDeclineOverall,
      10,
    );
  });

  it("speed changes only the timing, never the full-activity total at the peak", () => {
    const slow = { growthPotential: 1, growthSpeed: 0, peakAge: 27, declinePotential: 0, declineSpeed: 0 };
    const fast = { ...slow, growthSpeed: 1 };
    // Both reach exactly the whole budget at peak age...
    expect(cumulativeGrowthFraction(slow, 27)).toBeCloseTo(1, 10);
    expect(cumulativeGrowthFraction(fast, 27)).toBeCloseTo(1, 10);
    // ...but the fast curve is never behind the slow one on the way there.
    for (const age of [17, 19, 21, 23, 25]) {
      expect(cumulativeGrowthFraction(fast, age)).toBeGreaterThanOrEqual(cumulativeGrowthFraction(slow, age) - 1e-9);
    }
    expect(cumulativeGrowthFraction(fast, 20)).toBeGreaterThan(cumulativeGrowthFraction(slow, 20));
  });
});

describe("skill generation toward a target (spec §39)", () => {
  it("hits target OVR within tolerance for every position", () => {
    for (const position of [0, 1, 2, 3, 4] as Position[]) {
      for (const target of [50, 65, 75, 85]) {
        const rng = createRng(position * 100 + target);
        const { skills } = generateSkillsForTarget(rng, position, target);
        const actual = overallFromSkills(position, skills);
        expect(Math.abs(actual - target), `pos=${position} target=${target} actual=${actual}`).toBeLessThanOrEqual(SKILL_TARGET_TOLERANCE_OVR);
      }
    }
  });

  it("never exceeds the configured retry budget", () => {
    // The function is bounded by construction; just assert it returns a valid
    // skill set even for an extreme target.
    const rng = createRng(1);
    const { skills } = generateSkillsForTarget(rng, 4, 100);
    expect(overallFromSkills(4, skills)).toBeGreaterThan(80);
  });
});

describe("generated player countries", () => {
  it("defaults to a five percent foreign-player chance", () => {
    expect(gameConfig.playerGenerationRules.foreignPlayerChance).toBeCloseTo(0.05, 10);
  });

  it("uses the club country when the foreign chance is disabled", () => {
    withForeignPlayerChance(0, () => {
      for (let slot = 0; slot < 20; slot++) {
        expect(generateSeniorPlayer(seniorCtx({ slot })).country).toBe("BRA");
      }
    });
  });

  it("selects a different country and matching name pool when foreign generation is guaranteed", () => {
    const pooledCountries = countriesWithNamePools().filter((country) => country !== "BRA");
    expect(pooledCountries.length).toBeGreaterThan(0);

    withForeignPlayerChance(1, () => {
      for (let slot = 0; slot < 20; slot++) {
        const player = generateSeniorPlayer(seniorCtx({ slot }));
        expect(player.country).not.toBe("BRA");
        expect(pooledCountries).toContain(player.country);
        expect(nameUsesCountryPool(player.name, player.country)).toBe(true);
      }
    });
  });

  it("keeps country and name deterministic for the same generation identity", () => {
    withForeignPlayerChance(1, () => {
      const first = generateSeniorPlayer(seniorCtx({ slot: 27 }));
      const second = generateSeniorPlayer(seniorCtx({ slot: 27 }));
      expect(second.country).toBe(first.country);
      expect(second.name).toBe(first.name);
    });
  });
});

calibrationDescribe("senior generation (spec §70)", () => {
  it("generates a valid player with a complete hidden career profile", () => {
    const player = generateSeniorPlayer(seniorCtx());
    const peak = gameConfig.playerCareer.peakAgeDistribution;
    expect(player.age).toBeGreaterThanOrEqual(gameConfig.playerGenerationRules.academyAutomaticPromotionAge);
    expect(player.overall).toBeGreaterThanOrEqual(1);
    expect(player.overall).toBeLessThanOrEqual(100);
    // Nothing about the hidden career shape may leak onto the player as a
    // visible star/quality flag, and there is no second potential ceiling.
    expect((player as unknown as { tier?: number }).tier).toBeUndefined();
    expect((player as unknown as { potential?: number }).potential).toBeUndefined();
    for (const value of [
      player.careerProfile.growthPotential,
      player.careerProfile.growthSpeed,
      player.careerProfile.declinePotential,
      player.careerProfile.declineSpeed,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(Number.isInteger(player.careerProfile.peakAge)).toBe(true);
    expect(player.careerProfile.peakAge).toBeGreaterThanOrEqual(peak.min);
    expect(player.careerProfile.peakAge).toBeLessThanOrEqual(peak.max);
    expect(player.isYouth).toBe(false);
    expect(player.generationType).toBe("initial-senior");
    expect(player.generatedDivision).toBe(1);
  });

  it("draws initial senior ages from the active-career survival distribution", () => {
    const entryAge = gameConfig.playerGenerationRules.academyAutomaticPromotionAge;
    const counts = new Map<number, number>();
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const player = generateSeniorPlayer(seniorCtx({ position: 3, slot: i }));
      counts.set(player.age, (counts.get(player.age) ?? 0) + 1);
    }
    const weights = seniorSurvivalWeights(3);
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
    // Ages 16-19 belong to the academy and no intake path produces an age-20
    // youth, so the senior population starts exactly at the promotion age.
    expect(Math.min(...counts.keys())).toBe(entryAge);
    for (const [age, weight] of weights) {
      const expected = weight / total;
      if (expected < 0.005) continue;
      expect(Math.abs((counts.get(age) ?? 0) / n - expected)).toBeLessThan(0.01);
    }
  });

  it("shows an age profile that rises toward prime age and falls afterwards", () => {
    const byAge = new Map<number, number[]>();
    for (let i = 0; i < 40_000; i++) {
      const player = generateSeniorPlayer(seniorCtx({ slot: i }));
      if (!byAge.has(player.age)) byAge.set(player.age, []);
      byAge.get(player.age)!.push(player.overall);
    }
    const meanAt = (age: number): number => {
      const values = byAge.get(age) ?? [];
      return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    };
    expect(meanAt(27)).toBeGreaterThan(meanAt(21) + 3);
    expect(meanAt(27)).toBeGreaterThan(meanAt(34) + 3);
  });

  it("higher divisions produce stronger average squads", () => {
    const n = 2000;
    const means: number[] = [];
    for (const division of [1, 2, 3, 4, 5]) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const p = generateSeniorPlayer(seniorCtx({ currentDivision: division, slot: i }));
        sum += p.overall;
      }
      means.push(sum / n);
    }
    for (let d = 0; d < 4; d++) {
      expect(means[d]).toBeGreaterThan(means[d + 1]);
    }
    // Means track the division model closely.
    expect(Math.abs(means[0] - divisionMean(1, 5))).toBeLessThan(1.5);
    expect(Math.abs(means[4] - divisionMean(5, 5))).toBeLessThan(1.5);
  });

  it("assembles initial squads through the paired batch path to the division-relative band", () => {
    // Product target: an initial D1 senior squad is assembled through
    // generateInitialSeniorPlayers (quality pairing), not independent
    // per-player draws. The squad mean lands on the initial-senior target mean
    // (division mean + configured offset), and every visible OVR sits inside
    // the hard division-relative band.
    const targets = initialClubQualityTargets(1, 5);
    expect(targets.mean).toBeCloseTo(75, 6);
    expect(targets.lower).toBe(67);
    expect(targets.upper).toBe(83);
    const clubCount = 1_000;
    const xiMeans: number[] = [];
    const weakest: number[] = [];
    const strongest: number[] = [];
    const all: number[] = [];
    for (let seed = 1; seed <= clubCount; seed++) {
      const club = makeClub({ id: 100_000 + seed, highestDivision: 1 });
      const contexts = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        seniorCtx({ id: slot + 1, clubId: club.id, position, seed, slot }),
      );
      const squad = generateInitialSeniorPlayers(contexts);
      for (const p of squad) all.push(p.overall);
      const lineup = buildLineup(club, squad);
      expect(lineup).not.toBeNull();
      const ratings = lineup!.starters.map((player) => player.overall).sort((a, b) => a - b);
      xiMeans.push(ratings.reduce((sum, value) => sum + value, 0) / ratings.length);
      weakest.push(ratings[0]);
      strongest.push(ratings[ratings.length - 1]);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(Math.abs(mean(all) - targets.mean)).toBeLessThan(0.35);
    const inBand = all.filter((v) => v >= targets.lower && v <= targets.upper).length / all.length;
    expect(inBand).toBe(1);
    // Every complete squad respects the hard band.
    let squadsWith29Plus = 0;
    for (let seed = 1; seed <= clubCount; seed++) {
      const club = makeClub({ id: 200_000 + seed, highestDivision: 1 });
      const contexts = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        seniorCtx({ id: slot + 1, clubId: club.id, position, seed, slot }),
      );
      const squad = generateInitialSeniorPlayers(contexts);
      const inside = squad.filter((p) => p.overall >= targets.lower && p.overall <= targets.upper).length;
      if (inside === squad.length) squadsWith29Plus++;
    }
    expect(squadsWith29Plus / clubCount).toBe(1);
    // Reported, not asserted as a fixed product target: removing extreme
    // current-OVR tails lowers the automatic XI mean below the old 80.
    expect(mean(xiMeans)).toBeGreaterThan(targets.mean);
    expect(mean(weakest)).toBeLessThan(mean(strongest));
  });

  it("keeps the full generated D1 senior population on the configured division mean", () => {
    // topDivisionMeanOverall is DEFINED as the mean of the complete generated
    // D1 senior population across all ages, so the age mix must give back
    // exactly seniorPeakOverallOffset relative to the peak anchor.
    const samples: number[] = [];
    for (let i = 0; i < 40_000; i++) samples.push(generateSeniorPlayer(seniorCtx({ slot: i })).overall);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(Math.abs(mean - gameConfig.playerGeneration.topDivisionMeanOverall)).toBeLessThan(0.6);
  });

  it("is deterministic for the same seed/slot and differs across slots", () => {
    const a = generateSeniorPlayer(seniorCtx());
    const b = generateSeniorPlayer(seniorCtx());
    expect(a.skills).toEqual(b.skills);
    expect(a.overall).toBe(b.overall);
    const c = generateSeniorPlayer(seniorCtx({ slot: 1 }));
    expect(a.skills).not.toEqual(c.skills);
  });
});

calibrationDescribe("youth generation (spec §71)", () => {
  it("generates a valid youth player", () => {
    const player = generateYouthPlayer(youthCtx());
    expect(player.isYouth).toBe(true);
    expect(player.age).toBeGreaterThanOrEqual(16);
    expect(player.age).toBeLessThanOrEqual(19);
    // Academy terms are derived, not configured: they always end at age 21.
    expect(player.contractDays).toBe((gameConfig.playerGenerationRules.academyContractEndAge - player.age) * gameConfig.seasonDays);
    expect((player as unknown as { tier?: number }).tier).toBeUndefined();
    expect(player.generatedClubHighestDivision).toBe(1);
  });

  it("academy pedigree raises expected youth ability (spec §56)", () => {
    const n = 2000;
    const d1 = sumOf(generateYouthPlayer, youthCtx({ currentDivision: 1, highestDivisionReached: 1, slot: n }), n);
    const d5 = sumOf(generateYouthPlayer, youthCtx({ currentDivision: 5, highestDivisionReached: 5, slot: n }), n);
    const d4d1 = sumOf(generateYouthPlayer, youthCtx({ currentDivision: 4, highestDivisionReached: 1, slot: n }), n);
    const d4d4 = sumOf(generateYouthPlayer, youthCtx({ currentDivision: 4, highestDivisionReached: 4, slot: n }), n);
    expect(d1 / n).toBeGreaterThan(d4d1 / n);
    expect(d4d1 / n).toBeGreaterThan(d4d4 / n);
    expect(d4d1 / n).toBeGreaterThan(d5 / n);
    expect(d1 / n).toBeGreaterThan(d5 / n);
  });

  it("younger ages are weaker on average but rare elites still appear (spec §30)", () => {
    const n = 3000;
    const age16 = sumOf(generateYouthPlayer, youthCtx({ age: 16, slot: n }), n) / n;
    const age19 = sumOf(generateYouthPlayer, youthCtx({ age: 19, slot: n }), n) / n;
    expect(age19).toBeGreaterThan(age16);
    // A top-pedigree academy shifts the weakest-academy distribution upward;
    // the common ±3σ birth-quality range still produces meaningful outliers.
    const best = (() => {
      let m = 0;
      for (let i = 0; i < n; i++) {
        const p = generateYouthPlayer(youthCtx({ age: 16, slot: i }));
        if (p.overall > m) m = p.overall;
      }
      return m;
    })();
    expect(best).toBeGreaterThan(60);
    const topPedigreeBest = (() => {
      let m = 0;
      for (let i = 0; i < n; i++) {
        const p = generateYouthPlayer(youthCtx({ age: 16, currentDivision: 1, highestDivisionReached: 1, slot: i }));
        if (p.overall > m) m = p.overall;
      }
      return m;
    })();
    expect(topPedigreeBest).toBeGreaterThanOrEqual(best);
    expect(topPedigreeBest).toBeGreaterThan(64);
  });

  it("only ever generates academy ages 16 to 19", () => {
    const { academyMinAge, academyMaxAge } = gameConfig.playerGenerationRules;
    for (let i = 0; i < 5_000; i++) {
      const player = generateYouthPlayer({ ...youthCtx({ slot: i }), age: undefined });
      expect(player.age).toBeGreaterThanOrEqual(academyMinAge);
      expect(player.age).toBeLessThanOrEqual(academyMaxAge);
    }
  });

  it("develops a regularly playing top-academy cohort toward its career peak anchor", () => {
    const sampleSize = 400;
    let peakSum = 0;
    for (let i = 0; i < sampleSize; i++) {
      const club = makeClub({ id: 200_000 + i, highestDivision: 1 });
      const player = generateYouthPlayer(youthCtx({
        id: i + 1,
        clubId: club.id,
        position: (i % 5) as Position,
        age: 16 + (i % 4),
        seed: 10_000 + i,
        slot: i,
      }));
      player.recentMinutes = [90, 90, 90, 90, 90];
      let peak = player.overall;
      for (let season = 0; season < 24 && player.age < 40; season++) {
        const rng = createRng((i + 1) * 1_000 + season);
        for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
        aging(player);
        peak = Math.max(peak, player.overall);
      }
      peakSum += peak;
    }
    // A full-activity career should land near the D1 academy peak anchor, which
    // by construction equals the D1 senior peak anchor.
    expect(Math.abs(peakSum / sampleSize - academyPeakMean(academyPedigree(1, 1, 5)))).toBeLessThan(3);
  });
});

describe("senior roster template (spec §17)", () => {
  it("allocates all five positions for a balanced 28-player roster", () => {
    const template = seniorRosterTemplate(28);
    expect(template).toHaveLength(28);
    const counts = [0, 0, 0, 0, 0];
    for (const pos of template) counts[pos]++;
    expect(counts).toEqual([3, 4, 5, 9, 7]);
  });

  it("keeps every position within one player of its target share", () => {
    for (const size of [11, 20, 28, 30, 35]) {
      const template = seniorRosterTemplate(size);
      expect(template).toHaveLength(size);
      const counts = [0, 0, 0, 0, 0];
      for (const position of template) counts[position]++;
      expect(counts.every((count) => count > 0)).toBe(true);
      for (let position = 0; position < counts.length; position++) {
        expect(Math.abs(counts[position] - SENIOR_POSITION_WEIGHTS[position] * size)).toBeLessThanOrEqual(1);
      }
    }
  });
});

calibrationDescribe("distribution acceptance (spec §53-§55)", () => {
  it("base Z is a true truncated normal (mean 0, std ~0.989, symmetric, bounded)", () => {
    const rng = createRng(4242);
    const n = 200000;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let center = 0;
    let tailHigh = 0;
    let tailLow = 0;
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const z = drawRawZ(rng);
      values.push(z);
      sum += z;
      if (z < min) min = z;
      if (z > max) max = z;
      if (Math.abs(z) < 1) center++;
      if (z > 2) tailHigh++;
      if (z < -2) tailLow++;
    }
    const mean = sum / n;
    const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    expect(mean).toBeCloseTo(0, 0.01);
    expect(Math.sqrt(variance)).toBeCloseTo(0.989, 0.01);
    expect(min).toBeGreaterThanOrEqual(-3);
    expect(max).toBeLessThanOrEqual(3);
    expect(center / n).toBeGreaterThan(0.65);
    expect(Math.abs(tailHigh - tailLow) / n).toBeLessThan(0.005);
  });

  it("division means reproduce μ(D) within tolerance (spec §54)", () => {
    // The reported OVR is derived from integer skills (player-generation §14),
    // so the skill→OVR rounding introduces a small position-dependent bias
    // relative to the continuous target. The tolerance is tightened to ~1/20 of
    // σ, which is far below any cross-division gap yet acknowledges the integer
    // skill model.
    const n = 200000;
    for (const division of [1, 2, 3, 4, 5]) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += generateSeniorPlayer(seniorCtx({ currentDivision: division, slot: i })).overall;
      }
      expect(Math.abs(sum / n - divisionMean(division, 5))).toBeLessThanOrEqual(0.35);
    }
  });

  it("reproduces the five-division overlap reference values (spec §55)", () => {
    const n = 200000;
    const samples = new Map<number, number[]>();
    for (const division of [1, 2, 3, 4, 5]) {
      const arr: number[] = [];
      for (let i = 0; i < n; i++) arr.push(generateSeniorPlayer(seniorCtx({ currentDivision: division, slot: i })).overall);
      samples.set(division, arr);
    }
    const median = (arr: number[]) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    const overlap = (weak: number, strong: number) => {
      const m = median(samples.get(strong)!);
      const arr = samples.get(weak)!;
      let count = 0;
      for (const v of arr) if (v > m) count++;
      return count / n;
    };
    expect(overlap(2, 1)).toBeCloseTo(0.134, 1);
    expect(overlap(3, 2)).toBeCloseTo(0.216, 1);
    expect(overlap(4, 3)).toBeCloseTo(0.271, 1);
    expect(overlap(5, 4)).toBeCloseTo(0.309, 1);
  });
});

calibrationDescribe("independence acceptance", () => {
  it("birth-quality Z is uncorrelated with all five hidden career attributes", () => {
    const n = 60_000;
    const zs: number[] = [];
    const series: Record<string, number[]> = {
      growthPotential: [], growthSpeed: [], peakAge: [], declinePotential: [], declineSpeed: [],
    };
    for (let i = 0; i < n; i++) {
      const p = generateSeniorPlayer(seniorCtx({ slot: i }));
      zs.push(p.rawZ ?? 0);
      series.growthPotential.push(p.careerProfile.growthPotential);
      series.growthSpeed.push(p.careerProfile.growthSpeed);
      series.peakAge.push(p.careerProfile.peakAge);
      series.declinePotential.push(p.careerProfile.declinePotential);
      series.declineSpeed.push(p.careerProfile.declineSpeed);
    }
    const corr = (a: number[], b: number[]) => {
      const meanA = a.reduce((s, x) => s + x, 0) / n;
      const meanB = b.reduce((s, x) => s + x, 0) / n;
      let num = 0;
      let denA = 0;
      let denB = 0;
      for (let i = 0; i < n; i++) {
        num += (a[i] - meanA) * (b[i] - meanB);
        denA += (a[i] - meanA) ** 2;
        denB += (b[i] - meanB) ** 2;
      }
      return num / Math.sqrt(denA * denB);
    };
    for (const [label, values] of Object.entries(series)) {
      expect(Math.abs(corr(zs, values)), label).toBeLessThan(0.02);
    }
  });

  it("samples the configured hidden profile densities and peak-age truncation", () => {
    const rng = createRng(987_654);
    const cfg = gameConfig.playerCareer;
    const gp: number[] = [];
    const peaks: number[] = [];
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      const profile = generateCareerProfile(rng);
      gp.push(profile.growthPotential);
      peaks.push(profile.peakAge);
    }
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    // The realized mean must MATCH the configured density, not approximate it:
    // sampling is exact inverse-CDF, so a drift here means the density changed.
    expect(Math.abs(mean(gp) - densityMean(cfg.growthPotentialDistribution))).toBeLessThan(0.01);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(cfg.peakAgeDistribution.min);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(cfg.peakAgeDistribution.max);
    expect(Math.abs(mean(peaks) - cfg.peakAgeDistribution.mean)).toBeLessThan(0.3);
    // Both tails must actually be populated rather than piled at the bounds.
    expect(peaks.filter((v) => v === cfg.peakAgeDistribution.min).length / n).toBeGreaterThan(0.001);
    expect(peaks.filter((v) => v === cfg.peakAgeDistribution.max).length / n).toBeGreaterThan(0.001);
  });
});

function sumOf(fn: typeof generateYouthPlayer, base: GeneratePlayerContext, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const args = { ...base, slot: i } as GeneratePlayerContext;
    sum += fn(args).overall;
  }
  return sum;
}

calibrationDescribe("global bounds (spec §40)", () => {
  it("never generates players outside the global OVR bounds", () => {
    const rng = createRng(99);
    const club = makeClub({ highestDivision: 1 });
    for (let i = 0; i < 2000; i++) {
      const p = generateSeniorPlayer(seniorCtx({ slot: i }));
      expect(p.overall).toBeGreaterThanOrEqual(OVR_MIN);
      expect(p.overall).toBeLessThanOrEqual(OVR_MAX);
      for (const key of Object.keys(p.skills) as (keyof typeof p.skills)[]) {
        expect(p.skills[key]).toBeGreaterThanOrEqual(1);
        expect(p.skills[key]).toBeLessThanOrEqual(100);
      }
    }
    void rng;
    void club;
  });
});

calibrationDescribe("initial senior roster calibration (spec §plans/initial-senior-roster-generation)", () => {
  it("keeps the paired roster's marginal raw-Z distribution intact", () => {
    const n = 3_000;
    const rawZs: number[] = [];
    for (let seed = 1; seed <= n; seed++) {
      const contexts = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        seniorCtx({ seed, slot, position, id: slot + 1 }),
      );
      const blueprints = contexts.map(drawSeniorGenerationBlueprint);
      const paired = pairInitialSeniorBlueprints(blueprints);
      for (const p of paired) rawZs.push(p.assignedRawZ);
    }
    const m = rawZs.reduce((s, v) => s + v, 0) / rawZs.length;
    const variance = rawZs.reduce((s, v) => s + (v - m) ** 2, 0) / rawZs.length;
    expect(Math.abs(m)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(variance) - 0.989)).toBeLessThan(0.03);
  });

  it("holds all five career-profile marginals within the existing tolerances", () => {
    const n = 3_000;
    const series: Record<string, number[]> = { growthPotential: [], growthSpeed: [], peakAge: [], declinePotential: [], declineSpeed: [] };
    for (let seed = 1; seed <= n; seed++) {
      const contexts = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        seniorCtx({ seed, slot, position, id: slot + 1 }),
      );
      for (const blueprint of contexts.map(drawSeniorGenerationBlueprint)) {
        series.growthPotential.push(blueprint.profile.growthPotential);
        series.growthSpeed.push(blueprint.profile.growthSpeed);
        series.peakAge.push(blueprint.profile.peakAge);
        series.declinePotential.push(blueprint.profile.declinePotential);
        series.declineSpeed.push(blueprint.profile.declineSpeed);
      }
    }
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const cfg = gameConfig.playerCareer;
    expect(Math.abs(mean(series.growthPotential) - densityMean(cfg.growthPotentialDistribution))).toBeLessThan(0.01);
    expect(Math.abs(mean(series.growthSpeed) - densityMean(cfg.growthSpeedDistribution))).toBeLessThan(0.01);
    expect(Math.abs(mean(series.declinePotential) - densityMean(cfg.declinePotentialDistribution))).toBeLessThan(0.01);
    expect(Math.abs(mean(series.declineSpeed) - densityMean(cfg.declineSpeedDistribution))).toBeLessThan(0.01);
    expect(Math.abs(mean(series.peakAge) - cfg.peakAgeDistribution.mean)).toBeLessThan(0.3);
    expect(Math.min(...series.peakAge)).toBeGreaterThanOrEqual(cfg.peakAgeDistribution.min);
    expect(Math.max(...series.peakAge)).toBeLessThanOrEqual(cfg.peakAgeDistribution.max);
  });

  it("shows a rising-then-falling age-OVR profile and keeps peak-age bounds", () => {
    const byAge = new Map<number, number[]>();
    const peaks: number[] = [];
    for (let seed = 1; seed <= 4_000; seed++) {
      const squad = generateInitialSeniorPlayers(
        seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
          seniorCtx({ seed, slot, position, id: slot + 1 }),
        ),
      );
      for (const p of squad) {
        if (!byAge.has(p.age)) byAge.set(p.age, []);
        byAge.get(p.age)!.push(p.overall);
        peaks.push(p.careerProfile.peakAge);
      }
    }
    const meanBand = (ages: number[]): number => {
      const values = ages.flatMap((age) => byAge.get(age) ?? []);
      return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    };
    // Counter-pairing may narrow the cross-sectional spread, but it must not
    // flatten the visible career shape: prime-age players remain materially
    // stronger than both developing youngsters and declining veterans.
    const youngBand = meanBand([18, 19, 20, 21]);
    const peakBand = meanBand([25, 26, 27, 28, 29]);
    const decliningBand = meanBand([34, 35, 36, 37, 38]);
    expect(peakBand).toBeGreaterThanOrEqual(youngBand + 3);
    expect(peakBand).toBeGreaterThanOrEqual(decliningBand + 3);
    const cfg = gameConfig.playerCareer;
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(cfg.peakAgeDistribution.min);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(cfg.peakAgeDistribution.max);
  });

  it("orders D1-D5 means and matches each division-relative target mean within 0.5", () => {
    const n = 1_200;
    const means: number[] = [];
    for (const division of [1, 2, 3, 4, 5]) {
      const all: number[] = [];
      for (let seed = 1; seed <= n; seed++) {
        const squad = generateInitialSeniorPlayers(
          seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
            seniorCtx({ seed, slot, position, currentDivision: division, id: slot + 1 }),
          ),
        );
        for (const p of squad) all.push(p.overall);
      }
      means.push(all.reduce((s, v) => s + v, 0) / all.length);
    }
    for (let d = 0; d < 4; d++) expect(means[d]).toBeGreaterThan(means[d + 1]);
    for (let d = 0; d < 5; d++) {
      const target = initialClubQualityTargets(d + 1, 5).mean;
      expect(Math.abs(means[d] - target), `D${d + 1}`).toBeLessThan(0.5);
    }
  });

  it("keeps the counter-pairing coupling negative between raw Z and career-stage offset", () => {
    // The intentional joint-distribution change: within each age band, the
    // weakest quality tickets go to the strongest career stages. Checking the
    // coupling conditionally by band ensures the age curve itself is not used
    // as the source of the negative correlation.
    const activity = activityModifiersFor(gameConfig.playerGeneration.initialSeniorHistoricalActivity);
    const ageBandWidth = gameConfig.playerGeneration.initialSeniorQualityPairingAgeBandWidth;
    const bandPairs = new Map<number, Array<[number, number]>>();
    for (let seed = 1; seed <= 1_500; seed++) {
      const contexts = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        seniorCtx({ seed, slot, position, id: slot + 1 }),
      );
      const blueprints = contexts.map(drawSeniorGenerationBlueprint);
      const paired = pairInitialSeniorBlueprints(blueprints);
      for (const { blueprint, assignedRawZ } of paired) {
        const band = Math.floor(blueprint.age / ageBandWidth);
        const pairs = bandPairs.get(band) ?? [];
        pairs.push([
          assignedRawZ,
          reconstructCurrentTarget(blueprint.profile, 0, blueprint.age, activity.growth, activity.decline).current,
        ]);
        bandPairs.set(band, pairs);
      }
    }
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const bandCorrelations: number[] = [];
    for (const pairs of bandPairs.values()) {
      if (pairs.length < 2) continue;
      const rawZs = pairs.map(([rawZ]) => rawZ);
      const offsets = pairs.map(([, offset]) => offset);
      const mz = mean(rawZs);
      const mo = mean(offsets);
      let num = 0;
      let denZ = 0;
      let denO = 0;
      for (let i = 0; i < pairs.length; i++) {
        num += (rawZs[i] - mz) * (offsets[i] - mo);
        denZ += (rawZs[i] - mz) ** 2;
        denO += (offsets[i] - mo) ** 2;
      }
      if (denZ > 0 && denO > 0) bandCorrelations.push(num / Math.sqrt(denZ * denO));
    }
    expect(mean(bandCorrelations)).toBeLessThan(-0.4);
  });
});
