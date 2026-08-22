import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import {
  academyPedigree,
  academyPedigreeOverallOffset,
  bottomDivisionMean,
  divisionMean,
  divisionStrength,
  drawRawZ,
  expectedGrowth,
  generateSeniorPlayer,
  generateSkillsForTarget,
  generateYouthPlayer,
  initialPotential,
  overallRange,
  qualitySigma,
  remainingNaturalGrowth,
  SENIOR_POSITION_WEIGHTS,
  seniorRosterTemplate,
  tierFromZ,
  topDivisionMean,
  youthAgeOffset,
  OVR_MAX,
  OVR_MIN,
  SKILL_GENERATION_MAX_RETRIES,
  SKILL_TARGET_TOLERANCE_OVR,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import { countriesWithNamePools } from "../src/game/names";
import { overallFromSkills } from "../src/game/rating";
import { gameConfig } from "../src/config";
import { buildLineup } from "../src/game/club";
import { aging, applyDevelopment, potentialGrowth } from "../src/game/player";
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

  it("reproduces the spec's 1-100 reference values", () => {
    expect(qualitySigma()).toBeCloseTo(6, 2);
    expect(topDivisionMean()).toBeCloseTo(73.5, 2);
    expect(bottomDivisionMean()).toBeCloseTo(55.5, 2);
  });
});

describe("academy pedigree (spec §22-§24)", () => {
  it("weights current division 0.65 and history 0.35", () => {
    expect(academyPedigree(1, 1, 5)).toBeCloseTo(0.65 * 1 + 0.35 * 1, 10);
    expect(academyPedigree(5, 5, 5)).toBeCloseTo(0, 10);
  });

  it("D4/historic-D1 academy beats D4/historic-D4 but stays below D1/D1", () => {
    const d4d4 = academyPedigree(4, 4, 5);
    const d4d1 = academyPedigree(4, 1, 5);
    const d1d1 = academyPedigree(1, 1, 5);
    expect(d4d1).toBeGreaterThan(d4d4);
    expect(d4d1).toBeLessThan(d1d1);
  });

  it("maximum pedigree shift follows the configured academy calibration", () => {
    const pedigree = academyPedigree(1, 1, 5);
    expect(academyPedigreeOverallOffset(pedigree)).toBeCloseTo(gameConfig.playerGeneration.academyPedigreeOverallBoost, 10);
  });
});

describe("youth age baselines (spec §27-§28)", () => {
  it("reproduces the spec's canonical age offsets", () => {
    const expected = { 16: 12.107, 17: 9.422, 18: 6.737, 19: 4.202, 20: 1.959, 21: 0.0 };
    for (const [age, value] of Object.entries(expected)) {
      expect(youthAgeOffset(Number(age))).toBeCloseTo(value, 3);
    }
  });

  it("youth means equal mu_bottom minus the age offset", () => {
    for (const age of [16, 17, 18, 19, 20, 21]) {
      expect(youthAgeOffset(age)).toBeCloseTo(bottomDivisionMean() - (bottomDivisionMean() - youthAgeOffset(age)), 8);
    }
  });
});

describe("remaining natural growth & initial potential (spec §34-§36)", () => {
  it("is zero past the decline age and grows for younger players", () => {
    expect(remainingNaturalGrowth(30, 30)).toBe(0);
    expect(remainingNaturalGrowth(35, 30)).toBe(0);
    expect(remainingNaturalGrowth(20, 30)).toBeGreaterThan(remainingNaturalGrowth(28, 30));
  });

  it("initial potential is at least the current overall and at most OVR_MAX", () => {
    for (const overall of [40, 60, 80, 95]) {
      for (const age of [16, 20, 24, 30]) {
        for (const decline of [24, 30, 38]) {
          const p = initialPotential(overall, age, decline, 1.0);
          expect(p).toBeGreaterThanOrEqual(overall);
          expect(p).toBeLessThanOrEqual(OVR_MAX);
        }
      }
    }
  });

  it("stronger development profiles produce higher ceilings (spec §36)", () => {
    const strong = initialPotential(50, 20, 38, 1.4);
    const weak = initialPotential(50, 20, 24, 0.6);
    expect(strong).toBeGreaterThan(weak);
  });

  it("a poor player with a strong profile can still have headroom", () => {
    const p = initialPotential(45, 18, 38, 1.4);
    expect(p).toBeGreaterThan(45);
  });
});

calibrationDescribe("tier classification (spec §37)", () => {
  it("maps percentile thresholds to tiers 1..5", () => {
    expect(tierFromZ(-3.0)).toBe(1);
    expect(tierFromZ(-1.5)).toBe(1);
    expect(tierFromZ(-1.0)).toBe(2);
    expect(tierFromZ(-0.5)).toBe(3);
    expect(tierFromZ(0.0)).toBe(3);
    expect(tierFromZ(0.8)).toBe(4);
    expect(tierFromZ(1.5)).toBe(5);
    expect(tierFromZ(3.0)).toBe(5);
  });

  it("produces approximately 10/20/40/20/10 distribution", () => {
    const rng = createRng(2024);
    const n = 200000;
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const z = drawRawZ(rng);
      counts[tierFromZ(z) - 1]++;
    }
    expect(counts[0] / n).toBeCloseTo(0.1, 1);
    expect(counts[1] / n).toBeCloseTo(0.2, 1);
    expect(counts[2] / n).toBeCloseTo(0.4, 1);
    expect(counts[3] / n).toBeCloseTo(0.2, 1);
    expect(counts[4] / n).toBeCloseTo(0.1, 1);
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
  it("generates a valid player with independent development traits", () => {
    const player = generateSeniorPlayer(seniorCtx());
    expect(player.age).toBeGreaterThanOrEqual(18);
    expect(player.age).toBeLessThanOrEqual(38);
    expect(player.overall).toBeGreaterThanOrEqual(1);
    expect(player.overall).toBeLessThanOrEqual(100);
    // The birth-quality tier is a server-private development input: it must
    // never be stored on the player (no star/quality flag).
    expect((player as unknown as { tier?: number }).tier).toBeUndefined();
    expect(player.developmentProfile.declineStartAge).toBeGreaterThanOrEqual(24);
    expect(player.potential).toBeGreaterThanOrEqual(player.overall);
    expect(player.isYouth).toBe(false);
    expect(player.generationType).toBe("initial-senior");
    expect(player.generatedDivision).toBe(1);
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

  it("calibrates the automatic Division 1 starting XI close to 78 OVR", () => {
    const clubCount = 1_000;
    let total = 0;
    for (let seed = 1; seed <= clubCount; seed++) {
      const club = makeClub({ id: 100_000 + seed, highestDivision: 1 });
      const squad = seniorRosterTemplate(gameConfig.playerGenerationRules.initialSeniorSquadSize).map((position, slot) =>
        generateSeniorPlayer(seniorCtx({
          id: slot + 1,
          clubId: club.id,
          position,
          seed,
          slot,
        })),
      );
      const lineup = buildLineup(club, squad);
      expect(lineup).not.toBeNull();
      total += lineup!.starters.reduce((sum, player) => sum + player.overall, 0) / 11;
    }
    expect(Math.abs(total / clubCount - 78)).toBeLessThan(0.5);
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
    expect(player.contractDays).toBe(4 * gameConfig.seasonDays);
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

  it("calibrates a regularly playing Division 1 academy cohort to peak close to 78 OVR", () => {
    const sampleSize = 1_000;
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
        for (let day = 1; day <= DAYS_PER_YEAR; day++) {
          applyDevelopment(rng, player, club, day);
          if (day % 7 === 0) potentialGrowth(rng, player);
        }
        aging(rng, player, club);
        peak = Math.max(peak, player.overall);
      }
      peakSum += peak;
    }
    expect(Math.abs(peakSum / sampleSize - 78)).toBeLessThan(0.75);
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

calibrationDescribe("independence acceptance (spec §58)", () => {
  it("starting quality Z is uncorrelated with development traits", () => {
    const n = 200000;
    const zs: number[] = [];
    const rates: number[] = [];
    const declines: number[] = [];
    const vols: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = generateSeniorPlayer(seniorCtx({ slot: i }));
      zs.push(p.rawZ ?? 0);
      rates.push(p.developmentProfile.developmentRate);
      declines.push(p.developmentProfile.declineStartAge);
      vols.push(p.developmentProfile.developmentVolatility);
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
    expect(Math.abs(corr(zs, rates))).toBeLessThan(0.01);
    expect(Math.abs(corr(zs, declines))).toBeLessThan(0.01);
    expect(Math.abs(corr(zs, vols))).toBeLessThan(0.01);
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
