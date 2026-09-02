import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { createHumanClub, generateWorld } from "../src/game/worldgen";
import { initSeason, createDivision } from "../src/game/multiplayer";
import {
  allocateSlots,
  generateSeniorPlayer,
  generateYouthPlayer,
  seniorPositionWeights,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import {
  academyPositionWeights,
  generateInitialSeniorSquad,
  generateInitialAcademy,
  generateSeasonalAcademyIntake,
  generateNewClubRoster,
  academyIntakeDone,
} from "../src/game/clubGenerator";
import {
  allocatedIntakeForClub,
  ensurePopulationLedger,
  expectedActivePlayerLifetimeFromAcademyEntry,
  planSeasonalIntake,
  retirementBaselinePerClub,
} from "./populationHelpers";
import { gameConfig } from "../src/config";
import { applyDevelopment, aging, retirementProbability } from "../src/game/player";
import { careerGrowthBudget } from "../src/game/careerCurves";
import { processSeasonEndContracts, processSeasonalAcademyIntake, commitSeasonRollover } from "../src/game/season";
import { overallFromSkills } from "../src/game/rating";
import { DAYS_PER_YEAR } from "../src/game/constants";
import { makeClub } from "./helpers";
import { calibrationDescribe, yieldToEventLoop } from "./calibration";

function seniorCtx(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: "DM",
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
    position: "DM",
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

calibrationDescribe("accelerated career simulation", () => {
  // Simulate a whole career using the REAL development functions, advancing
  // seasonally (no real-time waiting, no fixtures).
  function simulateCareer(ctx: GeneratePlayerContext, activity: number, years: number): {
    peakOvr: number;
    peakAge: number;
    finalOvr: number;
  } {
    const club = makeClub({ id: ctx.clubId, highestDivision: 1 });
    const player = generateYouthPlayer(ctx);
    player.recentMinutes = activity === 1 ? [90, 90, 90, 90, 90] : [0, 0, 0, 0, 0];
    let peakOvr = player.overall;
    let peakAge = player.age;
    for (let season = 0; season < years; season++) {
      const rng = createRng(season * 7 + ctx.slot);
      for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
      if (player.overall > peakOvr) {
        peakOvr = player.overall;
        peakAge = player.age;
      }
      aging(player);
      if (player.age > 40) break;
    }
    return { peakOvr, peakAge, finalOvr: player.overall };
  }

  it("active full-starters outgrow inactive players", async () => {
    const n = 200;
    let activePeak = 0;
    let inactivePeak = 0;
    for (let i = 0; i < n; i++) {
      const ctx = youthCtx({ slot: i, age: 16 });
      activePeak += simulateCareer(ctx, 1.0, 24).peakOvr;
      inactivePeak += simulateCareer({ ...ctx, slot: i + 5000 }, 0.0, 24).peakOvr;
      if (i % 10 === 9) await yieldToEventLoop();
    }
    expect(activePeak / n).toBeGreaterThan(inactivePeak / n);
  }, 180000);

  it("naturally produces the full spectrum of careers", async () => {
    // A weak start with a big growth budget still becomes a useful player; a
    // strong start with a small budget improves little. Both emerge from the
    // independence of birth quality and the hidden career profile.
    const n = 1200;
    const samples: { start: number; budget: number; peak: number }[] = [];
    for (let i = 0; i < n; i++) {
      const ctx = youthCtx({ slot: i, age: 16 });
      const club = makeClub({ id: ctx.clubId, highestDivision: 1 });
      const player = generateYouthPlayer(ctx);
      player.recentMinutes = [90, 90, 90, 90, 90];
      const start = player.overall;
      const budget = careerGrowthBudget(player.careerProfile);
      let peak = start;
      for (let season = 0; season < 24; season++) {
        const rng = createRng(season * 7 + i);
        for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
        aging(player);
        if (player.overall > peak) peak = player.overall;
        if (player.age > 40) break;
      }
      samples.push({ start, budget, peak });
      if (i % 10 === 9) await yieldToEventLoop();
    }
    const meanPeak = (arr: typeof samples) => arr.reduce((sum, x) => sum + x.peak, 0) / Math.max(1, arr.length);
    const meanGain = (arr: typeof samples) => arr.reduce((sum, x) => sum + (x.peak - x.start), 0) / Math.max(1, arr.length);
    // Bands are relative to the generated population, so moving the top-division
    // mean knob cannot silently stop this from measuring a spectrum.
    const byStart = [...samples].sort((a, b) => a.start - b.start);
    const bandSize = Math.floor(n * 0.2);
    const poor = byStart.slice(0, bandSize);
    const average = byStart.slice(Math.floor(n * 0.4), Math.floor(n * 0.6));
    const great = byStart.slice(n - bandSize);
    expect(poor.filter((sample) => sample.peak - sample.start >= 3).length / poor.length).toBeGreaterThan(0.3);
    expect(meanPeak(great)).toBeGreaterThan(meanPeak(average));
    expect(meanPeak(average)).toBeGreaterThan(meanPeak(poor));
    // The growth budget, and only the growth budget, drives total improvement.
    const maximum = gameConfig.playerCareer.maximumCareerGrowthOverall;
    const bigBudget = samples.filter((sample) => sample.budget >= maximum * 0.7);
    const smallBudget = samples.filter((sample) => sample.budget <= maximum * 0.3);
    expect(meanGain(bigBudget)).toBeGreaterThan(meanGain(smallBudget));
  }, 180000);

  it("realizes no more improvement than the drawn career growth budget", async () => {
    for (let i = 0; i < 200; i++) {
      const ctx = youthCtx({ slot: i, age: 16 });
      const club = makeClub({ id: ctx.clubId, highestDivision: 1 });
      const player = generateYouthPlayer(ctx);
      player.recentMinutes = [90, 90, 90, 90, 90];
      const budget = careerGrowthBudget(player.careerProfile);
      for (let season = 0; season < 24 && player.age < 40; season++) {
        const rng = createRng(season * 13 + i);
        for (let day = 1; day <= DAYS_PER_YEAR; day++) applyDevelopment(player, club, day);
        aging(player);
      }
      expect(player.careerGrowthConsumed).toBeLessThanOrEqual(budget + 1e-9);
      if (i % 10 === 9) await yieldToEventLoop();
    }
  }, 180000);
});

describe("academy intake lifecycle", () => {
  it("derives the retirement baseline from the full active-career lifetime", () => {
    const lifetime = expectedActivePlayerLifetimeFromAcademyEntry(academyPositionWeights());
    const rules = gameConfig.playerGenerationRules;
    // Lifetime spans the academy pipeline plus the standing senior career.
    expect(lifetime).toBeGreaterThan(rules.academyAutomaticPromotionAge - rules.academyMaxAge);
    expect(retirementBaselinePerClub()).toBeCloseTo(rules.targetOwnedPlayersPerActiveClub / lifetime, 9);
  });

  it("uses the production retirement probabilities, including the goalkeeper grace", () => {
    expect(retirementProbability(32, "ST")).toBe(0);
    expect(retirementProbability(33, "ST")).toBe(0.1);
    expect(retirementProbability(35, "ST")).toBe(0.45);
    // Goalkeepers are treated as three years younger.
    expect(retirementProbability(35, "GK")).toBe(0.01);
    expect(retirementProbability(49, "ST")).toBe(1);
  });

  it("generates exactly the allocation the population plan resolved", () => {
    const world = generateWorld(1);
    const club = makeClub({ id: 50, highestDivision: 1 });
    world.clubs.push(club);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const seasonId = world.mp.seasonId;
    const plan = planSeasonalIntake(world, seasonId);
    const allocated = allocatedIntakeForClub(plan, club.id);
    const intake = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId, allocated,
    });
    expect(intake).toHaveLength(allocated);
  });

  it("gives a dismissing club no extra intake in the same cycle", () => {
    const world = generateWorld(1);
    const club = makeClub({ id: 50, highestDivision: 1 });
    world.clubs.push(club);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const seasonId = world.mp.seasonId;

    generateInitialAcademy({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    expect(world.players.filter((p) => p.clubId === club.id && p.isYouth)).toHaveLength(
      gameConfig.playerGenerationRules.initialAcademySize,
    );

    const before = allocatedIntakeForClub(planSeasonalIntake(world, seasonId), club.id);
    // Dismiss the whole academy: the club's own share must not move.
    world.players = world.players.filter((p) => !(p.clubId === club.id && p.isYouth));
    ensurePopulationLedger(world).pendingYouthDismissals.push({ seasonId, count: 8 });
    const after = allocatedIntakeForClub(planSeasonalIntake(world, seasonId), club.id);
    expect(after).toBe(before);
  });

  it("respects the academy roster limit and reports the blocked slots", () => {
    const world = generateWorld(2);
    const club = makeClub({ id: 51, highestDivision: 1 });
    world.clubs.push(club);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const seasonId = world.mp.seasonId;
    const limit = gameConfig.playerGenerationRules.academyRosterLimit;
    generateInitialAcademy({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId });
    // Fill the academy right up to the cap before intake runs.
    while (world.players.filter((p) => p.clubId === club.id && p.isYouth).length < limit) {
      const filler = generateYouthPlayer(youthCtx({ id: world.nextId++, clubId: club.id, slot: world.nextId }));
      world.players.push(filler);
    }
    const intake = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId, allocated: 5,
    });
    expect(intake).toHaveLength(0);
    expect(world.players.filter((p) => p.clubId === club.id && p.isYouth)).toHaveLength(limit);
  });

  it("intake idempotency marker prevents double generation", () => {
    const world = generateWorld(3);
    const club = makeClub({ id: 52, highestDivision: 1 });
    world.clubs.push(club);
    const seasonId = 99;
    expect(academyIntakeDone(world, club.id, seasonId)).toBe(false);
    const first = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId, allocated: 2,
    });
    expect(first).toHaveLength(2);
    expect(academyIntakeDone(world, club.id, seasonId)).toBe(true);
    const before = world.players.length;
    const again = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId, allocated: 2,
    });
    expect(again).toHaveLength(0);
    expect(world.players.length).toBe(before);
  });

  it("folds the season into the intake RNG so later cohorts are not repeats", () => {
    const world = generateWorld(31);
    const club = makeClub({ id: 53, highestDivision: 1 });
    world.clubs.push(club);
    const first = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 1, allocated: 2,
    });
    const second = generateSeasonalAcademyIntake({
      world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 1, seasonId: 2, allocated: 2,
    });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
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
    const groupOf = (pos: string) => (pos === "GK" ? 0 : pos === "LB" || pos === "RB" ? 1 : pos === "CB" ? 2 : pos === "DM" || pos === "AM" ? 3 : 4);
    const seniorCounts = [0, 0, 0, 0, 0];
    const youthCounts = [0, 0, 0, 0, 0];
    for (const player of first.seniors) seniorCounts[groupOf(player.position)]++;
    for (const player of first.youth) youthCounts[groupOf(player.position)]++;
    expect(seniorCounts).toEqual(allocateSlots(seniorPositionWeights(), gameConfig.playerGenerationRules.initialSeniorSquadSize));
    expect(youthCounts).toEqual(allocateSlots(academyPositionWeights(), gameConfig.playerGenerationRules.initialAcademySize));
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
      position: "DM" as const,
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