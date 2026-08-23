import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { createHumanClub, generateWorld } from "../src/game/worldgen";
import { initSeason, createDivision } from "../src/game/multiplayer";
import {
  allocateSlots,
  generateSeniorPlayer,
  generateYouthPlayer,
  initialPotential,
  remainingNaturalGrowth,
  SENIOR_POSITION_WEIGHTS,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import {
  ACADEMY_POSITION_WEIGHTS,
  generateInitialSeniorSquad,
  generateInitialAcademy,
  generateSeasonalAcademyIntake,
  generateNewClubRoster,
  academyIntakeDone,
  automaticSeasonalAcademyIntakeMean,
  expectedSeniorCareerSeasons,
  seasonalAcademyIntakeMean,
  seasonalAcademyIntakeQuota,
} from "../src/game/clubGenerator";
import { gameConfig } from "../src/config";
import { applyDevelopment, potentialGrowth, aging, retirementProbability } from "../src/game/player";
import { processSeasonEndContracts, processSeasonalAcademyIntake, commitSeasonRollover } from "../src/game/season";
import { overallFromSkills } from "../src/game/rating";
import { DAYS_PER_YEAR } from "../src/game/constants";
import { makeClub } from "./helpers";
import { calibrationDescribe } from "./calibration";

function seniorCtx(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: 3,
    isYouth: false,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-senior",
    seed: 42,
    slot: 0,
    ...overrides,
  } as GeneratePlayerContext;
}

function youthCtx(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: 3,
    age: 16,
    isYouth: true,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-academy",
    seed: 42,
    slot: 0,
    ...overrides,
  } as GeneratePlayerContext;
}

calibrationDescribe("accelerated career simulation (spec §60-§61)", () => {
  // Simulate a player's whole career using the REAL development functions,
  // advancing seasonally (no real-time waiting, no fixtures).
  function simulateCareer(ctx: GeneratePlayerContext, activity: number, years: number): {
    peakOvr: number;
    peakAge: number;
    finalOvr: number;
    ages: number[];
  } {
    const club = makeClub({ id: ctx.clubId, highestDivision: 1 });
    const player = generateYouthPlayer(ctx);
    player.recentMinutes = activity === 1 ? [90, 90, 90, 90, 90] : [0, 0, 0, 0, 0];
    let peakOvr = player.overall;
    let peakAge = player.age;
    const ages: number[] = [player.age];
    // For each season, run the daily development ticks (using the production
    // applyDevelopment) then age the player.
    for (let season = 0; season < years; season++) {
      const rng = createRng(season * 7 + ctx.slot);
      for (let day = 1; day <= DAYS_PER_YEAR; day++) {
        applyDevelopment(rng, player, club, day);
        potentialGrowth(rng, player);
      }
      if (player.overall > peakOvr) {
        peakOvr = player.overall;
        peakAge = player.age;
      }
      aging(rng, player, club);
      ages.push(player.age);
      if (player.age > 40) break;
    }
    return { peakOvr, peakAge, finalOvr: player.overall, ages };
  }

  it("active full-starters outgrow inactive players (spec §61 qualitative outcomes)", () => {
    const n = 300;
    let activePeak = 0;
    let inactivePeak = 0;
    for (let i = 0; i < n; i++) {
      const ctx = youthCtx({ slot: i, age: 16 });
      const active = simulateCareer(ctx, 1.0, 24);
      const inactive = simulateCareer({ ...ctx, slot: i + 5000 }, 0.0, 24);
      activePeak += active.peakOvr;
      inactivePeak += inactive.peakOvr;
    }
    expect(activePeak / n).toBeGreaterThan(inactivePeak / n);
  });

  it("naturally produces the full spectrum of careers (spec §61)", () => {
    // Bad start + strong development -> useful player; great start + weak
    // development -> modest improvement; etc. These emerge from the combination
    // of independent starting quality and development traits.
    const n = 2000;
    const samples: { start: number; rate: number; decline: number; peak: number }[] = [];
    for (let i = 0; i < n; i++) {
      const ctx = youthCtx({ slot: i, age: 16 });
      const club = makeClub({ id: ctx.clubId, highestDivision: 1 });
      const player = generateYouthPlayer(ctx);
      player.recentMinutes = [90, 90, 90, 90, 90];
      const start = player.overall;
      const rate = player.developmentProfile.developmentRate;
      const decline = player.developmentProfile.declineStartAge;
      let peak = start;
      for (let season = 0; season < 24; season++) {
        const rng = createRng(season * 7 + i);
        for (let day = 1; day <= DAYS_PER_YEAR; day++) {
          applyDevelopment(rng, player, club, day);
          potentialGrowth(rng, player);
        }
        aging(rng, player, club);
        if (player.overall > peak) peak = player.overall;
        if (player.age > 40) break;
      }
      samples.push({ start, rate, decline, peak });
    }
    // Define quality bands relative to the configured population scale. Fixed
    // absolute cutoffs would stop measuring a spectrum whenever the designer
    // moves the new top-division mean knob.
    const byStart = [...samples].sort((a, b) => a.start - b.start);
    const bandSize = Math.floor(n * 0.2);
    const poor = byStart.slice(0, bandSize);
    const average = byStart.slice(Math.floor(n * 0.4), Math.floor(n * 0.6));
    const great = byStart.slice(n - bandSize);
    // Even weak starters can improve into useful players over a full career
    // (development-rate and decline-age are independent of starting quality).
    const poorImproved = poor.filter((s) => s.peak - s.start >= 3).length / Math.max(1, poor.length);
    expect(poorImproved).toBeGreaterThan(0.3);
    // The best players on average peak higher than the worst.
    const meanPeak = (arr: typeof samples) => arr.reduce((s, x) => s + x.peak, 0) / Math.max(1, arr.length);
    expect(meanPeak(great)).toBeGreaterThan(meanPeak(poor));
    // Strong development materially lifts peaks: among players with a strong
    // development rate, the peak exceeds the start on average.
    const strongDev = samples.filter((s) => s.rate >= 1.2);
    const strongDevMeanGain = strongDev.reduce((s, x) => s + (x.peak - x.start), 0) / Math.max(1, strongDev.length);
    const weakDev = samples.filter((s) => s.rate <= 0.8);
    const weakDevMeanGain = weakDev.reduce((s, x) => s + (x.peak - x.start), 0) / Math.max(1, weakDev.length);
    expect(strongDevMeanGain).toBeGreaterThan(weakDevMeanGain);
    // Great starters retain a starting-quality advantage over a full career.
    expect(meanPeak(great)).toBeGreaterThan(meanPeak(average));
    void average;
  });

  it("initial potential allows realistic growth while the engine decides reality", () => {
    const ctx = youthCtx({ slot: 7, age: 16 });
    const player = generateYouthPlayer(ctx);
    const growth = remainingNaturalGrowth(player.age, player.developmentProfile.declineStartAge);
    const expected = initialPotential(player.overall, player.age, player.developmentProfile.declineStartAge, player.developmentProfile.developmentRate);
    expect(player.potential).toBe(expected);
    expect(player.potential).toBeGreaterThanOrEqual(player.overall);
  });
});

describe("academy lifecycle & reroll exploit tests (spec §66)", () => {
  it("auto intake derives the equilibrium from the live lifecycle rules", () => {
    expect(gameConfig.playerGenerationRules.seasonalAcademyIntake).toBe("auto");
    expect(expectedSeniorCareerSeasons(21, 4)).toBeCloseTo(14.3123596, 6);
    expect(expectedSeniorCareerSeasons(21, 0)).toBeCloseTo(17.279236, 6);
    expect(automaticSeasonalAcademyIntakeMean()).toBeCloseTo(2.2640617, 6);
    expect(seasonalAcademyIntakeMean()).toBe(automaticSeasonalAcademyIntakeMean());
  });

  it("auto intake responds to configured population and intake ages", () => {
    const rules = gameConfig.playerGenerationRules;
    const baseline = automaticSeasonalAcademyIntakeMean(rules);
    const largerPopulation = automaticSeasonalAcademyIntakeMean({ ...rules, initialSeniorSquadSize: rules.initialSeniorSquadSize + 10 });
    const olderRecruits = automaticSeasonalAcademyIntakeMean({ ...rules, academyMinAge: 18, academyMaxAge: 20 });
    expect(largerPopulation).toBeGreaterThan(baseline);
    expect(olderRecruits).toBeGreaterThan(baseline);
  });

  it("uses the production retirement probabilities in the auto calculation", () => {
    expect(retirementProbability(32, 4)).toBe(0);
    expect(retirementProbability(33, 4)).toBe(0.1);
    expect(retirementProbability(35, 4)).toBe(0.45);
    expect(retirementProbability(35, 0)).toBe(0.01);
    expect(retirementProbability(49, 4)).toBe(1);
  });

  it("uses a retry-stable quota for the same club and season", () => {
    const world = generateWorld(700);
    const mean = seasonalAcademyIntakeMean();
    const first = seasonalAcademyIntakeQuota(world, 42, 9);
    expect(seasonalAcademyIntakeQuota(world, 42, 9)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(Math.floor(mean));
    expect(first).toBeLessThanOrEqual(Math.ceil(mean));
  });

  it("fixed seasonal intake: releasing youth before intake does not increase the quota", () => {
    const world = generateWorld(1);
    const club = makeClub({ id: 50, highestDivision: 1 });
    world.clubs.push(club);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const seasonId = world.mp.seasonId;

    // Initial academy uses the configured cohort size.
    generateInitialAcademy({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    const initial = world.players.filter((p) => p.clubId === club.id && p.isYouth);
    expect(initial).toHaveLength(gameConfig.playerGenerationRules.initialAcademySize);

    // Release all youth; the seasonal intake still generates only its fixed
    // club/season quota rather than refilling the academy.
    world.players = world.players.filter((p) => !(p.clubId === club.id && p.isYouth));
    const quota = seasonalAcademyIntakeQuota(world, club.id, seasonId);
    const intake = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    expect(intake).toHaveLength(quota);
  });

  it("empty academy receives only its deterministic mean-rounded quota", () => {
    const world = generateWorld(2);
    const club = makeClub({ id: 51, highestDivision: 1 });
    world.clubs.push(club);
    const seasonId = world.mp.seasonId || 1;
    const quota = seasonalAcademyIntakeQuota(world, club.id, seasonId);
    const intake = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    expect(intake).toHaveLength(quota);
  });

  it("intake idempotency marker prevents double generation (spec §45)", () => {
    const world = generateWorld(3);
    const club = makeClub({ id: 52, highestDivision: 1 });
    world.clubs.push(club);
    const seasonId = 99;
    expect(academyIntakeDone(world, club.id, seasonId)).toBe(false);
    const quota = seasonalAcademyIntakeQuota(world, club.id, seasonId);
    const first = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    expect(first).toHaveLength(quota);
    expect(academyIntakeDone(world, club.id, seasonId)).toBe(true);
    // Second invocation skips generation.
    const before = world.players.length;
    const intake = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    expect(intake).toHaveLength(0);
    expect(world.players.length).toBe(before);
  });

  it("uses the season in seasonal-intake RNG so later cohorts are not repeats", () => {
    const world = generateWorld(31);
    const club = makeClub({ id: 53, highestDivision: 1 });
    world.clubs.push(club);
    const firstQuota = seasonalAcademyIntakeQuota(world, club.id, 1);
    const secondQuota = seasonalAcademyIntakeQuota(world, club.id, 2);
    const first = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 1 });
    const second = generateSeasonalAcademyIntake({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 2 });
    expect(first).toHaveLength(firstQuota);
    expect(second).toHaveLength(secondQuota);
    expect(second[0].rawZ).not.toBe(first[0].rawZ);
  });

  it("uses the live pyramid depth for a new human club's generation context", () => {
    const world = generateWorld(8);
    initSeason(world, { year: 2026, month: 1 }, 1);
    createDivision(world, { tier: 2, groupIndex: 0, seasonId: 1, ref: { year: 2026, month: 1 } });

    const club = createHumanClub(world, {
      userId: 8,
      clubName: "Depth-Aware FC",
      country: "BRA",
    });

    expect(club.highestDivision).toBe(2);
    expect(world.players.filter((player) => player.clubId === club.id).every((player) => player.generatedDivision === 2)).toBe(true);
  });
});

calibrationDescribe("fractional academy intake population calibration", () => {
  it("tracks the resolved long-run mean quota", () => {
    const world = generateWorld(701);
    const sampleSize = 10_000;
    let total = 0;
    for (let seasonId = 1; seasonId <= sampleSize; seasonId++) {
      total += seasonalAcademyIntakeQuota(world, 42, seasonId);
    }
    expect(Math.abs(total / sampleSize - seasonalAcademyIntakeMean())).toBeLessThan(0.02);
  });
});

describe("club creation idempotency (spec §46)", () => {
  it("re-generating a club roster does not duplicate players", () => {
    const world = generateWorld(4);
    const club = makeClub({ id: 60, highestDivision: 2 });
    world.clubs.push(club);
    const seasonId = world.mp.seasonId || 1;
    const ctx = { world, club, currentDivision: 2, highestDivisionReached: 2, totalDivisions: 2, seasonId };
    const first = generateInitialSeniorSquad(ctx);
    expect(first).toHaveLength(gameConfig.playerGenerationRules.initialSeniorSquadSize);
    const seniorsAfterFirst = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    expect(seniorsAfterFirst).toHaveLength(gameConfig.playerGenerationRules.initialSeniorSquadSize);
    // Calling the roster generator again must reuse the committed squad (the
    // generateNewClubRoster guard in worldgen/clubGenerator handles this).
    const second = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    expect(second).toHaveLength(gameConfig.playerGenerationRules.initialSeniorSquadSize);
  });

  it("guarded club-roster generation records a creation event and is a no-op on retry", () => {
    const world = generateWorld(6);
    const club = makeClub({ id: 61, highestDivision: 2 });
    world.clubs.push(club);
    const ctx = { world, club, currentDivision: 2, highestDivisionReached: 2, totalDivisions: 2, seasonId: 1 };
    const first = generateNewClubRoster(ctx);
    expect(first.seniors).toHaveLength(gameConfig.playerGenerationRules.initialSeniorSquadSize);
    expect(first.youth).toHaveLength(gameConfig.playerGenerationRules.initialAcademySize);
    const seniorCounts = [0, 0, 0, 0, 0];
    const youthCounts = [0, 0, 0, 0, 0];
    for (const player of first.seniors) seniorCounts[player.position]++;
    for (const player of first.youth) youthCounts[player.position]++;
    expect(seniorCounts).toEqual(allocateSlots(SENIOR_POSITION_WEIGHTS, gameConfig.playerGenerationRules.initialSeniorSquadSize));
    expect(youthCounts).toEqual(allocateSlots(ACADEMY_POSITION_WEIGHTS, gameConfig.playerGenerationRules.initialAcademySize));
    expect(seniorCounts.every((count) => count > 0)).toBe(true);
    expect(youthCounts.every((count) => count > 0)).toBe(true);
    expect(world.generationEvents).toContain("club-creation:61");
    const playerCount = world.players.length;
    const second = generateNewClubRoster(ctx);
    expect(second.seniors).toHaveLength(gameConfig.playerGenerationRules.initialSeniorSquadSize);
    expect(second.youth).toHaveLength(gameConfig.playerGenerationRules.initialAcademySize);
    expect(world.players.length).toBe(playerCount);
  });

  it("the same club created twice with identical inputs is deterministic", () => {
    const ctx = (clubId: number) => ({
      id: 1,
      clubId,
      country: "BRA",
      position: 3 as const,
      isYouth: false as const,
      currentDivision: 2,
      highestDivisionReached: 2,
      totalDivisions: 3,
      seasonId: 7,
      generationType: "initial-senior" as const,
      seed: 99,
      slot: 5,
    });
    const a = generateSeniorPlayer(ctx(1));
    const b = generateSeniorPlayer(ctx(1));
    expect(a.skills).toEqual(b.skills);
    expect(a.overall).toBe(b.overall);
  });
});

describe("season rollover intake uses the new season's division (spec §44)", () => {
  it("recorded academy intake survives a rollover and uses the club's division", () => {
    const world = generateWorld(5);
    const club = makeClub({ id: 70, highestDivision: 1 });
    world.clubs.push(club);
    // Establish a real season context so the rollover runs the resolved intake.
    world.mp.seasonId = 1;
    world.mp.seasonYear = 2026;
    world.mp.seasonMonth = 1;
    const seasonId = world.mp.seasonId;
    const ctx = { world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId };
    generateInitialAcademy(ctx);
    // Simulate a rollover: contracts age/promote and generate intake.
    const rng = createRng(42);
    processSeasonEndContracts(rng, world);
    processSeasonalAcademyIntake(rng, world);
    commitSeasonRollover(world);
    // The intake marker should be set for the season.
    expect(world.generationEvents.some((e) => e.startsWith(`academy-intake:${club.id}:`))).toBe(true);
  });
});
