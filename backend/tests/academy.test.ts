import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { generatePlayer } from "../src/game/player";
import {
  dismissYouthPlayer,
  promoteYouthPlayer,
  processSeasonEndContracts,
  processSeasonalAcademyIntake,
  commitSeasonRollover,
} from "../src/game/season";
import { academyContractSeasonsForAge, calculateAcademySalary, calculateProfessionalContractSalary } from "../src/game/economy";
import { seniorRosterCount, seniorRosterFullError, seniorRosterOverflowError } from "../src/game/club";
import { SENIOR_SQUAD_LIMIT } from "../src/game/constants";
import { generateYouthPlayer } from "../src/game/playerGeneration";
import { pendingYouthDismissalCount } from "./populationHelpers";
import { gameConfig } from "../src/config";
import type { Player, Position, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

const RULES = gameConfig.playerGenerationRules;

function youth(world: World, clubId: number, age: number, id: number): Player {
  const player = generateYouthPlayer({
    id,
    clubId,
    country: "BRA",
    position: 3 as Position,
    age,
    isYouth: true,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 1,
    seasonId: 1,
    generationType: "initial-academy",
    seed: 4242,
    slot: id,
  });
  world.players.push(player);
  return player;
}

describe("academy contract terms", () => {
  it("derives the term from the age-21 boundary rather than a configured length", () => {
    expect(academyContractSeasonsForAge(16)).toBe(5);
    expect(academyContractSeasonsForAge(17)).toBe(4);
    expect(academyContractSeasonsForAge(18)).toBe(3);
    expect(academyContractSeasonsForAge(19)).toBe(2);
    expect(RULES.academyContractEndAge).toBe(21);
  });

  it("gives every generated academy player a contract that ends at age 21", () => {
    const world = makeWorld([makeClub({ id: 1 })], []);
    for (let age = RULES.academyMinAge; age <= RULES.academyMaxAge; age++) {
      const player = youth(world, 1, age, 100 + age);
      expect(player.contractDays).toBe((RULES.academyContractEndAge - age) * gameConfig.seasonDays);
    }
  });

  it("prices a five-season academy contract as the current season plus four future ones", () => {
    // Intake happens at the season boundary, so the current-season fraction is
    // one: a 16-year-old's five seasons are 1 + 4, never six seasons of service.
    const professionalEquivalent = calculateProfessionalContractSalary({
      currentOverall: 60,
      currentAge: 16,
      futureCompleteSeasons: 4,
      currentSeasonFraction: 1,
    });
    expect(calculateAcademySalary(60, 16)).toBe(
      Math.max(1, Math.round(professionalEquivalent * gameConfig.academySalaryMultiplier)),
    );
    const sixSeasons = calculateProfessionalContractSalary({
      currentOverall: 60,
      currentAge: 16,
      futureCompleteSeasons: 5,
      currentSeasonFraction: 1,
    });
    expect(sixSeasons).toBeGreaterThan(professionalEquivalent);
  });

  it("is exactly the configured fraction of the professional-equivalent salary", () => {
    for (const [overall, age] of [[45, 16], [70, 18], [88, 19]] as [number, number][]) {
      const professionalEquivalent = calculateProfessionalContractSalary({
        currentOverall: overall,
        currentAge: age,
        futureCompleteSeasons: academyContractSeasonsForAge(age) - 1,
        currentSeasonFraction: 1,
      });
      // No professional floor is reapplied afterwards, so the fraction is exact.
      expect(calculateAcademySalary(overall, age) / professionalEquivalent).toBeCloseTo(
        gameConfig.academySalaryMultiplier,
        2,
      );
    }
  });

  it("keeps the academy multiplier strictly between zero and one", () => {
    expect(gameConfig.academySalaryMultiplier).toBeGreaterThan(0);
    expect(gameConfig.academySalaryMultiplier).toBeLessThan(1);
  });
});

describe("voluntary promotion", () => {
  it("is refused below the voluntary promotion age", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    const player = youth(world, 1, RULES.academyVoluntaryPromotionAge - 1, 1);
    const result = promoteYouthPlayer(world, player);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`age ${RULES.academyVoluntaryPromotionAge}`);
    expect(player.isYouth).toBe(true);
  });

  it("succeeds at the voluntary age and at the last academy age", () => {
    for (const age of [RULES.academyVoluntaryPromotionAge, RULES.academyMaxAge]) {
      const club = makeClub({ id: 1 });
      const world = makeWorld([club], []);
      const player = youth(world, 1, age, 1);
      expect(promoteYouthPlayer(world, player).ok).toBe(true);
      expect(player.isYouth).toBe(false);
    }
  });

  it("preserves salary, contract length and release clause exactly", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    const player = youth(world, 1, 18, 1);
    const before = { salary: player.salary, contractDays: player.contractDays, releaseClause: player.releaseClause };
    expect(promoteYouthPlayer(world, player).ok).toBe(true);
    expect(player.salary).toBe(before.salary);
    expect(player.contractDays).toBe(before.contractDays);
    // The low academy-origin release clause is a deliberate mobility mechanism
    // and must NOT be silently replaced with a professional-equivalent clause.
    expect(player.releaseClause).toBe(before.releaseClause);
  });

  it("is blocked when the senior squad is already full", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    for (let i = 0; i < SENIOR_SQUAD_LIMIT; i++) {
      world.players.push(generatePlayer(createRng(i + 1), club, { id: 1000 + i }));
    }
    const player = youth(world, 1, 19, 1);
    const result = promoteYouthPlayer(world, player);
    expect(result.ok).toBe(false);
    expect(player.isYouth).toBe(true);
  });
});

describe("mandatory age promotion", () => {
  it("promotes every remaining academy player at the automatic boundary", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    const player = youth(world, 1, RULES.academyAutomaticPromotionAge - 1, 1);
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    commitSeasonRollover(world);
    expect(player.age).toBe(RULES.academyAutomaticPromotionAge);
    expect(player.isYouth).toBe(false);
    expect(world.news.some((n) => n.entries?.some((e) => e.detail?.includes("on his existing terms")))).toBe(true);
  });

  it("leaves no player in the academy at or after the automatic promotion age", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    for (let age = RULES.academyMinAge; age <= RULES.academyMaxAge; age++) youth(world, 1, age, age);
    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);
    commitSeasonRollover(world);
    for (const player of world.players.filter((p) => p.isYouth)) {
      expect(player.age).toBeLessThan(RULES.academyAutomaticPromotionAge);
    }
  });

  it("creates a temporary overflow instead of releasing anyone when the squad is full", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    for (let i = 0; i < SENIOR_SQUAD_LIMIT; i++) {
      const senior = generatePlayer(createRng(i + 1), club, { id: 1000 + i });
      senior.age = 25;
      world.players.push(senior);
    }
    const player = youth(world, 1, RULES.academyAutomaticPromotionAge - 1, 1);
    const originalSeniorIds = world.players.filter((p) => !p.isYouth).map((p) => p.id);

    processSeasonEndContracts(world.rng, world);
    processSeasonalAcademyIntake(world.rng, world);

    expect(player.isYouth).toBe(false);
    // Nobody is released, listed, replaced or overwritten to make room.
    for (const id of originalSeniorIds) expect(world.players.some((p) => p.id === id)).toBe(true);
    expect(seniorRosterCount(world, 1)).toBeGreaterThan(SENIOR_SQUAD_LIMIT);
    // While over the cap, every voluntary addition AND every renewal is blocked.
    expect(seniorRosterFullError(world, 1)).not.toBeNull();
    expect(seniorRosterOverflowError(world, 1)).not.toBeNull();
  });

  it("clears the overflow block once the squad is back at the limit", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    for (let i = 0; i < SENIOR_SQUAD_LIMIT; i++) {
      world.players.push(generatePlayer(createRng(i + 1), club, { id: 1000 + i }));
    }
    expect(seniorRosterOverflowError(world, 1)).toBeNull();
    // At the limit, adding is blocked but renewing is not.
    expect(seniorRosterFullError(world, 1)).not.toBeNull();
  });
});

describe("academy dismissal", () => {
  it("releases the player and hands his replenishment to the global pool", () => {
    const club = makeClub({ id: 1 });
    const world = makeWorld([club], []);
    const player = youth(world, 1, 17, 1);
    expect(dismissYouthPlayer(world, player).ok).toBe(true);
    expect(world.players).toHaveLength(0);
    expect(world.news.at(-1)?.entries?.some((e) => e.detail?.includes("released from the youth academy"))).toBe(true);
    // The loss is recorded as pending global compensation: the next seasonal
    // intake converts it into shared recruits, never into a reroll entitlement
    // for this club.
    expect(pendingYouthDismissalCount(world)).toBe(1);
  });
});
