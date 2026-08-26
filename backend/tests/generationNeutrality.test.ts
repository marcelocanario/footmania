import { describe, expect, it } from "vitest";
import baseline from "./fixtures/generation-golden.json";
import {
  generateSeniorPlayer,
  generateSkillsForTarget,
  generateYouthPlayer,
  SKILL_SHAPE_RECIPES,
  seniorRosterTemplate,
  type GeneratePlayerContext,
} from "../src/game/playerGeneration";
import { createRng } from "../src/game/rng";
import { overallFromSkills, SKILL_KEYS } from "../src/game/rating";
import {
  calculateAcademySalary,
  calculateProfessionalContractSalary,
  calculateReleaseClause,
  remainingSeasons,
} from "../src/game/economy";
import { buildSnapshot, playerView } from "../src/services/snapshot";
import type { Player, Position } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

type OracleRow = [number, number, number, number, number, number, number, number, number, number, number];
type PlayerSnapshot = Record<string, unknown>;
type Baseline = {
  oracle: OracleRow[];
  seniorPlayers: PlayerSnapshot[];
  youthPlayers: PlayerSnapshot[];
};

const fixture = baseline as unknown as Baseline;

function withoutDerivedContractEconomy(snapshot: PlayerSnapshot | Player): PlayerSnapshot {
  const stable: PlayerSnapshot = { ...snapshot };
  delete stable.salary;
  delete stable.releaseClause;
  delete stable.value;
  return stable;
}

function expectAuthoritativeGeneratedContractEconomy(player: Player): void {
  const seasons = remainingSeasons(player.contractDays);
  const expectedSalary = player.isYouth
    ? calculateAcademySalary(player.overall, player.age)
    : calculateProfessionalContractSalary({
      currentOverall: player.overall,
      currentAge: player.age,
      futureCompleteSeasons: Math.max(0, seasons - 1),
      currentSeasonFraction: 1,
    });
  expect(player.salary).toBe(expectedSalary);
  expect(player.releaseClause).toBe(calculateReleaseClause(expectedSalary, seasons));
}

function seniorContext(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
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
  };
}

function youthContext(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
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
  };
}

describe("generation neutrality", () => {
  it("matches the fixed-seed skill and OVR oracle exactly", () => {
    for (const [position, target, seed, ...expected] of fixture.oracle) {
      const { skills } = generateSkillsForTarget(createRng(seed), position as Position, target);
      const actual = [...SKILL_KEYS.map((key) => skills[key]), overallFromSkills(position as Position, skills)];
      expect(actual, `position=${position} target=${target} seed=${seed}`).toEqual(expected);
    }
  });

  it("keeps the anonymous recipe laws, order, variants, and duplicates", () => {
    const expected = [
      [
        [0, [["tec", 2, 5], ["tec", 0, 2]]],
        [0, [["tec", 2, 5], ["gol", 0, 2]]],
        [0, [["vel", 2, 5], ["tec", 0, 2]]],
        [0, [["gol", 1, 3], ["vel", 0, 2]]],
        [0, [["tec", 2, 5], ["gol", 0, 2]]],
        [0, [["tec", 2, 5], ["vel", 0, 2]]],
      ],
      [
        [1, [["pas", 2, 3], ["des", 3, 5]]],
        [1, [["pas", 2, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 5], ["pas", 3, 3]]],
        [0, [["des", 3, 5], ["vel", 16, 3]]],
        [0, [["des", 3, 5], ["pas", 2, 3]]],
        [0, [["des", 3, 5], ["fin", 3, 3], ["vel", 3, 3]]],
        [1, [["pas", 2, 3], ["pas", 3, 3]]],
      ],
      [
        [0, [["des", 3, 3], ["des", 3, 3], ["pas", 2, 3]]],
        [0, [["des", 3, 3], ["des", 3, 2]]],
        [0, [["des", 3, 3], ["arm", 3, 6]]],
        [0, [["des", 3, 3], ["pas", 2, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["des", 3, 3], ["pas", 2, 3]]],
        [0, [["des", 3, 3], ["arm", 3, 6]]],
        [0, [["des", 3, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["des", 3, 2]]],
        [0, [["des", 3, 3], ["arm", 3, 3], ["fin", 3, 3]]],
        [0, [["des", 3, 3], ["des", 3, 3], ["pas", 2, 3]]],
        [0, [["arm", 3, 6], ["des", 3, 2]]],
      ],
      [
        [1, [["arm", 3, 5], ["pas", 3, 5], ["pas", 3, 2]]],
        [1, [["arm", 3, 5], ["pas", 3, 5], ["fin", 3, 3]]],
        [1, [["fin", 3, 3], ["pas", 3, 2]]],
        [1, [["pas", 3, 2], ["fin", 3, 3]]],
        [1, [["arm", 3, 5], ["pas", 3, 5], ["tec", 3, 3]]],
        [1, [["arm", 3, 5], ["pas", 3, 5], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["des", 3, 3]]],
        [0, [["des", 3, 3], ["pas", 3, 2]]],
        [0, [["des", 3, 3], ["fin", 2, 3], ["des", 2, 3]]],
        [0, [["des", 3, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["pas", 3, 2]]],
        [1, [["fin", 3, 3], ["arm", 3, 5], ["pas", 3, 5]]],
        [0, [["des", 3, 3], ["des", 3, 3]]],
        [1, [["arm", 3, 5], ["pas", 3, 5], ["pas", 3, 2]]],
        [1, [["tec", 3, 3], ["pas", 3, 2]]],
        [0, [["des", 3, 3], ["fin", 3, 3]]],
        [1, [["pas", 3, 2], ["vel", 16, 3]]],
        [0, [["des", 3, 3], ["pas", 3, 2]]],
      ],
      [
        [1, [["fin", 3, 3], ["fin", 2, 3]]],
        [2, [["vel", 16, 3], ["fin", 3, 3]]],
        [1, [["fin", 3, 3], ["fin", 2, 3]]],
        [2, [["tec", 3, 3], ["fin", 3, 3]]],
        [1, [["fin", 3, 3], ["vel", 16, 3]]],
        [1, [["fin", 3, 3], ["fin", 2, 3]]],
        [1, [["fin", 3, 3], ["tec", 3, 3]]],
        [1, [["fin", 2, 3], ["vel", 16, 3]]],
        [2, [["tec", 3, 3], ["pas", 16, 2]]],
        [1, [["fin", 3, 3], ["pas", 16, 2]]],
        [1, [["fin", 3, 3], ["des", 3, 3], ["fin", 2, null]]],
        [2, [["vel", 16, 3], ["tec", 3, 3]]],
      ],
    ] as const;

    for (let position = 0; position < expected.length; position++) {
      const recipes = SKILL_SHAPE_RECIPES[position as Position];
      expect(recipes).toHaveLength(expected[position].length);
      expect(recipes.map((item) => [item.variant, item.steps.map((step) => [step.key, step.fixed, step.randomExclusive ?? null])] as const))
        .toEqual(expected[position]);
    }
  });

  it("keeps generated senior and youth output identical outside authoritative contract pricing", () => {
    const seniorPositions = seniorRosterTemplate(28);
    let seniorIndex = 0;
    for (const division of [1, 3]) {
      for (let slot = 0; slot < 28; slot++) {
        const player = generateSeniorPlayer(seniorContext({
          id: slot + 1,
          clubId: 100 + division,
          position: seniorPositions[slot],
          currentDivision: division,
          highestDivisionReached: division,
          seed: 4200 + division,
          slot,
        }));
        expect(withoutDerivedContractEconomy(player)).toEqual(
          withoutDerivedContractEconomy(fixture.seniorPlayers[seniorIndex++]),
        );
        expectAuthoritativeGeneratedContractEconomy(player);
        expect(player.recentLoad).toBe(0);
      }
    }

    const pedigrees: [number, number][] = [[1, 1], [4, 2], [5, 5]];
    let youthIndex = 0;
    for (const [current, highest] of pedigrees) {
      for (let slot = 0; slot < 20; slot++) {
        const player = generateYouthPlayer(youthContext({
          id: 500 + youthIndex,
          clubId: 300 + current * 10 + highest,
          position: (slot % 5) as Position,
          age: 16 + (slot % 4),
          currentDivision: current,
          highestDivisionReached: highest,
          seed: 9000 + youthIndex,
          slot,
        }));
        expect(withoutDerivedContractEconomy(player)).toEqual(
          withoutDerivedContractEconomy(fixture.youthPlayers[youthIndex++]),
        );
        expectAuthoritativeGeneratedContractEconomy(player);
        expect(player.recentLoad).toBe(0);
      }
    }
  });

  it("exposes retained fields in player API views", () => {
    const player = generateSeniorPlayer(seniorContext({ clubId: 1 }));
    const view = playerView(player);
    expect(view).toHaveProperty("skills");
    expect(view).toHaveProperty("overall");

    const snapshot = buildSnapshot(makeWorld([makeClub({ id: 1 })], [player], { humanClubId: 1 }), 1);
    expect(snapshot.squad[0]).toHaveProperty("skills");
    expect(snapshot.squad[0]).toHaveProperty("overall");
  });
});
