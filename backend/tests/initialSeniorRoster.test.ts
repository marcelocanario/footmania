import { describe, expect, it } from "vitest";
import {
  drawSeniorGenerationBlueprint,
  drawYouthGenerationBlueprint,
  buildSeniorPlayerFromBlueprint,
  conditionInitialAcademyBlueprints,
  conditionInitialSeniorBlueprints,
  generateInitialAcademyPlayers,
  generateInitialSeniorPlayers,
  generateSeniorPlayer,
  generateYouthPlayer,
  initialClubQualityTargets,
  pairInitialSeniorBlueprints,
  projectValuesToBoundedMean,
  seniorRosterTemplate,
  seniorPeakMean,
  academyPeakMean,
  academyPedigree,
  academyQualitySigma,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import { overallFromSkills } from "../src/game/rating";
import { activityModifiersFor, reconstructCurrentTarget } from "../src/game/careerCurves";
import { makeWorld, makeClub } from "./helpers";
import { gameConfig } from "../src/config";
import { generateNewClubRoster, generateInitialAcademy, generateInitialSeniorSquad, generateSeasonalAcademyIntake } from "../src/game/clubGenerator";
import { initialClubPlayerValueTarget } from "../src/game/generationProjection";
import { tierBudget } from "../src/game/budget";
import type { Position } from "../src/game/types";

function seniorCtx(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
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
    generationType: "initial-senior",
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

function squadContexts(seed: number, size: number, division = 1): GeneratePlayerContext[] {
  return seniorRosterTemplate(size).map((position, slot) =>
    seniorCtx({ seed, slot, position, id: slot + 1, currentDivision: division }),
  );
}

function academyContexts(seed: number, division = 1): GeneratePlayerContext[] {
  const size = gameConfig.playerGenerationRules.initialAcademySize;
  const minimumAge = gameConfig.playerGenerationRules.academyMinAge;
  const ageCount = gameConfig.playerGenerationRules.academyMaxAge - minimumAge + 1;
  return Array.from({ length: size }, (_, slot) => ({
    id: 100 + slot,
    clubId: 10,
    country: "BRA",
    position: (slot % 5) as Position,
    age: minimumAge + (slot % ageCount),
    isYouth: true,
    currentDivision: division,
    highestDivisionReached: division,
    totalDivisions: 5,
    seasonId: 1,
    generationType: "initial-academy" as const,
    seed,
    slot,
  }));
}

const ACTIVITY = gameConfig.playerGeneration.initialSeniorHistoricalActivity;

describe("bounded-mean projection", () => {
  it("uses one shared shift until heterogeneous bounds bind and hits the exact mean", () => {
    const projected = projectValuesToBoundedMean(
      [1, 5, 9],
      [4, 4, 4],
      [6, 8, 10],
      7,
    );
    expect(projected[0]).toBe(4);
    expect(projected[1]).toBeCloseTo(7, 8);
    expect(projected[2]).toBeCloseTo(10, 8);
    expect(projected.reduce((sum, value) => sum + value, 0) / projected.length).toBeCloseTo(7, 8);
  });

  it("handles empty input and rejects malformed or infeasible inputs", () => {
    expect(projectValuesToBoundedMean([], [], [], 5)).toEqual([]);
    expect(() => projectValuesToBoundedMean([1], [], [2], 1)).toThrow(/length mismatch/);
    expect(() => projectValuesToBoundedMean([1], [2], [1], 1)).toThrow(/inverted bounds/);
    expect(() => projectValuesToBoundedMean([1, 2], [0, 0], [1, 1], 2)).toThrow(/infeasible/);
    expect(() => projectValuesToBoundedMean([Number.NaN], [0], [1], 0.5)).toThrow(/finite/);
  });
});

describe("initial club player-value target", () => {
  it("uses the configured D1 anchor and the authoritative budget decay for lower divisions", () => {
    expect(initialClubPlayerValueTarget(1)).toBe(gameConfig.playerGeneration.initialClubPlayerValueTargetTopDivision);
    for (const division of [2, 3, 5]) {
      expect(initialClubPlayerValueTarget(division)).toBe(Math.round(
        gameConfig.playerGeneration.initialClubPlayerValueTargetTopDivision * tierBudget(division) / tierBudget(1),
      ));
    }
  });
});

describe("initial senior roster pairing", () => {
  it("returns [] for an empty input and a self-paired single blueprint", () => {
    expect(pairInitialSeniorBlueprints([])).toEqual([]);
    const single = [drawSeniorGenerationBlueprint(seniorCtx({ slot: 7 }))];
    const paired = pairInitialSeniorBlueprints(single);
    expect(paired).toHaveLength(1);
    expect(paired[0].blueprint).toBe(single[0]);
    expect(paired[0].assignedRawZ).toBe(single[0].rawZ);
  });

  it("preserves the roster-level multiset of raw-Z draws exactly", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const blueprints = squadContexts(seed, 30).map(drawSeniorGenerationBlueprint);
      const expected = blueprints.map((b) => b.rawZ).sort((a, b) => a - b);
      const paired = pairInitialSeniorBlueprints(blueprints);
      const actual = paired.map((p) => p.assignedRawZ).sort((a, b) => a - b);
      expect(actual).toEqual(expected);
    }
  });

  it("keeps every career bundle intact and returns players in slot order", () => {
    const blueprints = squadContexts(99, 30).map(drawSeniorGenerationBlueprint);
    const paired = pairInitialSeniorBlueprints(blueprints);
    // Slots stay in original order.
    expect(paired.map((p) => p.blueprint.ctx.slot)).toEqual(blueprints.map((b) => b.ctx.slot));
    // Every blueprint appears exactly once.
    const ids = new Set(paired.map((p) => p.blueprint));
    expect(ids.size).toBe(blueprints.length);
  });

  it("is deterministic for the same contexts and moves quality from its original slots", () => {
    const contexts = squadContexts(1234, 30);
    const a = pairInitialSeniorBlueprints(contexts.map(drawSeniorGenerationBlueprint));
    const b = pairInitialSeniorBlueprints(contexts.map(drawSeniorGenerationBlueprint));
    expect(a.map((p) => [p.blueprint.ctx.slot, p.assignedRawZ])).toEqual(b.map((p) => [p.blueprint.ctx.slot, p.assignedRawZ]));
    const identity = contexts.map((c) => c.slot).join(",");
    const assigned = a.map((p) => p.blueprint.ctx.slot).join(",");
    expect(assigned).toBe(identity); // slots preserve order
    const rawZSorted = a.map((p) => p.assignedRawZ);
    const rawZOriginal = contexts.map(drawSeniorGenerationBlueprint).map((b) => b.rawZ);
    expect(rawZSorted).not.toEqual(rawZOriginal);
  });

  it("consumes no global RNG (world.rng untouched by the batch)", () => {
    const world = makeWorld([makeClub({ id: 5 })], []);
    const before = { ...world.rng };
    const club = makeClub({ id: 5 });
    generateInitialSeniorSquad(
      {
        world,
        club,
        currentDivision: 1,
        highestDivisionReached: 1,
        totalDivisions: 5,
        seasonId: 1,
      },
      30,
    );
    expect(world.rng).toEqual(before);
  });

  it("rejects non-initial-senior contexts with a clear error", () => {
    const contexts = squadContexts(1, 5);
    contexts[0] = { ...contexts[0], generationType: "replacement" };
    expect(() => generateInitialSeniorPlayers(contexts)).toThrow(/initial-senior/);
    const youthContext = { ...squadContexts(1, 5)[0], isYouth: true };
    expect(() => generateInitialSeniorPlayers([youthContext])).toThrow(/initial-senior/);
  });

  it("rejects duplicate slots and mixed squad identities before pairing", () => {
    const duplicateSlots = squadContexts(1, 5);
    duplicateSlots[1] = { ...duplicateSlots[1], slot: duplicateSlots[0].slot };
    expect(() => generateInitialSeniorPlayers(duplicateSlots)).toThrow(/unique slots/);

    for (const override of [
      { clubId: 99 },
      { seed: 99 },
      { seasonId: 99 },
      { currentDivision: 2 },
      { totalDivisions: 6 },
    ]) {
      const mixed = squadContexts(1, 5);
      mixed[1] = { ...mixed[1], ...override };
      expect(() => generateInitialSeniorPlayers(mixed)).toThrow(/coherent club\/seed\/season\/division batch/);
    }
  });
});

describe("initial senior roster assembly", () => {
  it("two worlds with identical seed, club id, division, season and size produce identical rosters", () => {
    const build = () =>
      generateInitialSeniorPlayers(squadContexts(777, 30)).map((p) => ({
        id: p.id,
        name: p.name,
        age: p.age,
        position: p.position,
        skills: p.skills,
        overall: p.overall,
        rawZ: p.rawZ,
        careerProfile: p.careerProfile,
        careerGrowthConsumed: p.careerGrowthConsumed,
        careerDeclineConsumed: p.careerDeclineConsumed,
      }));
    expect(build()).toEqual(build());
  });

  it("keeps every visible senior inside the division-relative hard band", () => {
    for (const division of [1, 3, 5]) {
      const targets = initialClubQualityTargets(division, 5);
      for (const seed of [11, 22, 33, 44]) {
        const contexts = squadContexts(seed, 30, division);
        const assignments = conditionInitialSeniorBlueprints(contexts.map(drawSeniorGenerationBlueprint));
        const targetMean = assignments.reduce((sum, assignment) => sum + assignment.targetCurrentOverall, 0) / assignments.length;
        expect(targetMean).toBeCloseTo(targets.mean, 7);
        const squad = generateInitialSeniorPlayers(contexts);
        for (const player of squad) {
          expect(player.overall).toBeGreaterThanOrEqual(Math.ceil(targets.lower));
          expect(player.overall).toBeLessThanOrEqual(Math.floor(targets.upper));
        }
      }
    }
  });

  it("differs from the independent per-player build only in the re-paired quality column", () => {
    const contexts = squadContexts(555, 30);
    const blueprints = contexts.map(drawSeniorGenerationBlueprint);
    const paired = generateInitialSeniorPlayers(contexts);
    const unpaired = blueprints.map((b) =>
      buildSeniorPlayerFromBlueprint(b, b.rawZ, gameConfig.playerCareer.generationHistoricalActivity),
    );
    // By slot, identity/position/age/profile/country/side/contract match; only
    // assigned raw Z, skills, OVR, salary, value, release clause, and consumed
    // progression may change.
    for (let slot = 0; slot < paired.length; slot++) {
      const p = paired[slot];
      const u = unpaired[slot];
      expect(p.id).toBe(u.id);
      expect(p.name).toBe(u.name);
      expect(p.age).toBe(u.age);
      expect(p.position).toBe(u.position);
      expect(p.country).toBe(u.country);
      expect(p.side).toBe(u.side);
      expect(p.contractDays).toBe(u.contractDays);
      expect(p.careerProfile).toEqual(u.careerProfile);
    }
    // The pairing actually moved quality around (skills differ somewhere).
    expect(paired.map((p) => p.skills)).not.toEqual(unpaired.map((p) => p.skills));
  });

  it("persists reconstructed consumed budgets and an OVR consistent with the assigned raw Z", () => {
    const division = 1;
    const totalDivisions = 5;
    const contexts = squadContexts(888, 30, division).map((ctx) => ({ ...ctx, totalDivisions }));
    for (const player of generateInitialSeniorPlayers(contexts)) {
      const activity = activityModifiersFor(ACTIVITY);
      const rawZ = player.rawZ ?? 0;
      const reconstructed = reconstructCurrentTarget(
        player.careerProfile,
        seniorPeakMean(player.generatedDivision ?? division, totalDivisions) + gameConfig.playerGeneration.playerQualitySpreadOverall * rawZ,
        player.age,
        activity.growth,
        activity.decline,
      );
      expect(player.careerGrowthConsumed).toBeCloseTo(reconstructed.growthConsumed, 6);
      expect(player.careerDeclineConsumed).toBeCloseTo(reconstructed.declineConsumed, 6);
      expect(Math.abs(player.overall - reconstructed.current)).toBeLessThanOrEqual(1.5);
      expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
    }
  });

  it("keeps exact largest-remainder position counts for sizes 30 and 35", () => {
    for (const size of [30, 35]) {
      const squad = generateInitialSeniorPlayers(squadContexts(444, size));
      const counts = [0, 0, 0, 0, 0];
      for (const p of squad) counts[p.position]++;
      const template = seniorRosterTemplate(size);
      const expected = [0, 0, 0, 0, 0];
      for (const pos of template) expected[pos]++;
      expect(counts).toEqual(expected);
    }
  });

  it("keeps the new-club roster generation idempotent (no duplicates, no RNG rerolls)", () => {
    const world = makeWorld([makeClub({ id: 42 })], []);
    const club = world.clubs[0];
    const ctx = {
      world,
      club,
      currentDivision: 3,
      highestDivisionReached: 3,
      totalDivisions: 5,
      seasonId: 1,
    };
    const first = generateNewClubRoster(ctx);
    const playersAfterFirst = world.players.length;
    const idsAfterFirst = new Set(world.players.map((p) => p.id));
    const second = generateNewClubRoster(ctx);
    expect(world.players.length).toBe(playersAfterFirst);
    expect(new Set(world.players.map((p) => p.id)).size).toBe(idsAfterFirst.size);
    expect(second.seniors).toHaveLength(first.seniors.length);
    expect(second.youth).toHaveLength(first.youth.length);
  });

  it("does not leak initial-cohort conditioning into direct replacement or youth generation", () => {
    const world = makeWorld([makeClub({ id: 7 })], []);
    const club = world.clubs[0];
    const academy = generateInitialAcademy({
      world,
      club,
      currentDivision: 1,
      highestDivisionReached: 1,
      totalDivisions: 5,
      seasonId: 1,
    });
    expect(academy).toHaveLength(gameConfig.playerGenerationRules.initialAcademySize);
    // Direct per-player generation remains the unpaired baseline (fixed seed).
    const a = generateSeniorPlayer(seniorCtx({ seed: 31415, slot: 3 }));
    const b = generateSeniorPlayer(seniorCtx({ seed: 31415, slot: 3 }));
    expect(a.skills).toEqual(b.skills);
    // Direct youth generation remains independent; only the initial-academy
    // batch assembly path conditions the cohort.
    const youth = generateYouthPlayer({
      ...seniorCtx({ slot: 1 }),
      age: 16,
      isYouth: true,
      generationType: "initial-academy",
    });
    expect(youth.isYouth).toBe(true);
  });
});

describe("initial academy cohort conditioning", () => {
  it("conditions future personal peaks to the division band while preserving age and profile", () => {
    for (const division of [1, 3, 5]) {
      const contexts = academyContexts(700 + division, division);
      const blueprints = contexts.map(drawYouthGenerationBlueprint);
      const assignments = conditionInitialAcademyBlueprints(blueprints);
      const targets = initialClubQualityTargets(division, 5);
      const peakMean = academyPeakMean(academyPedigree(division, division, 5));
      const peaks = assignments.map((assignment) => peakMean + academyQualitySigma() * assignment.assignedRawZ);
      expect(peaks.reduce((sum, value) => sum + value, 0) / peaks.length).toBeCloseTo(targets.mean, 7);
      for (let slot = 0; slot < assignments.length; slot++) {
        expect(assignments[slot].blueprint).toBe(blueprints[slot]);
        expect(assignments[slot].blueprint.age).toBe(contexts[slot].age);
        expect(assignments[slot].assignedPeakTarget).toBeGreaterThanOrEqual(targets.lower);
        expect(assignments[slot].assignedPeakTarget).toBeLessThanOrEqual(targets.upper);
        expect(peaks[slot]).toBeCloseTo(assignments[slot].assignedPeakTarget, 8);
      }
    }
  });

  it("builds coherent youth careers from the conditioned peaks", () => {
    const contexts = academyContexts(811, 1);
    const players = generateInitialAcademyPlayers(contexts);
    const pedigree = academyPedigree(1, 1, 5);
    const activity = activityModifiersFor(gameConfig.playerCareer.generationHistoricalActivity);
    for (const player of players) {
      const peak = academyPeakMean(pedigree) + academyQualitySigma() * (player.rawZ ?? 0);
      const reconstructed = reconstructCurrentTarget(
        player.careerProfile,
        peak,
        player.age,
        activity.growth,
        activity.decline,
      );
      expect(player.careerGrowthConsumed).toBeCloseTo(reconstructed.growthConsumed, 7);
      expect(player.careerDeclineConsumed).toBeCloseTo(reconstructed.declineConsumed, 7);
      expect(Math.abs(player.overall - reconstructed.current)).toBeLessThanOrEqual(1.5);
      expect(player.overall).toBe(overallFromSkills(player.position, player.skills));
    }
  });

  it("validates batch identity and consumes no global RNG", () => {
    const duplicate = academyContexts(900);
    duplicate[1] = { ...duplicate[1], slot: duplicate[0].slot };
    expect(() => generateInitialAcademyPlayers(duplicate)).toThrow(/unique slots/);
    const wrongType = academyContexts(901);
    wrongType[0] = { ...wrongType[0], generationType: "seasonal-academy" };
    expect(() => generateInitialAcademyPlayers(wrongType)).toThrow(/initial-academy/);
    const mixed = academyContexts(902);
    mixed[1] = { ...mixed[1], currentDivision: 2 };
    expect(() => generateInitialAcademyPlayers(mixed)).toThrow(/coherent club\/seed\/season\/division batch/);

    const club = makeClub({ id: 61 });
    const world = makeWorld([club], [], { seed: 902 });
    const before = { ...world.rng };
    generateInitialAcademy({ world, club, currentDivision: 1, highestDivisionReached: 1, totalDivisions: 5, seasonId: 1 });
    expect(world.rng).toEqual(before);
  });

  it("leaves periodic academy intake independent of initial-cohort tunables", () => {
    const buildSeasonal = () => {
      const club = makeClub({ id: 71 });
      const world = makeWorld([club], [], { seed: 1001 });
      return generateSeasonalAcademyIntake({
        world,
        club,
        currentDivision: 1,
        highestDivisionReached: 1,
        totalDivisions: 5,
        seasonId: 9,
        allocated: 3,
      }).map((player) => ({
        age: player.age,
        overall: player.overall,
        skills: player.skills,
        rawZ: player.rawZ,
        profile: player.careerProfile,
      }));
    };
    const baseline = buildSeasonal();
    const originalOffset = gameConfig.playerGeneration.initialClubTargetMeanOffsetOverall;
    const originalHalfWidth = gameConfig.playerGeneration.initialClubTargetBandHalfWidthOverall;
    try {
      gameConfig.playerGeneration.initialClubTargetMeanOffsetOverall = originalOffset + 7;
      gameConfig.playerGeneration.initialClubTargetBandHalfWidthOverall = originalHalfWidth / 2;
      expect(buildSeasonal()).toEqual(baseline);
    } finally {
      gameConfig.playerGeneration.initialClubTargetMeanOffsetOverall = originalOffset;
      gameConfig.playerGeneration.initialClubTargetBandHalfWidthOverall = originalHalfWidth;
    }
  });
});
