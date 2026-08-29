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
import { SKILL_TARGET_TOLERANCE_OVR } from "../src/game/playerGeneration";
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

function normalizeSnapshot(snapshot: PlayerSnapshot | Player): PlayerSnapshot {
  const out: PlayerSnapshot = { ...(snapshot as PlayerSnapshot) };
  const skills = (out as { skills?: Record<string, number> }).skills;
  if (skills) {
    const normalized: Record<string, number> = { ...skills };
    if ("vel" in normalized && !("pace" in normalized)) {
      normalized.pace = normalized.vel as number;
      delete normalized.vel;
    }
    if ("arm" in normalized && !("playmaking" in normalized)) {
      normalized.playmaking = normalized.arm as number;
      delete normalized.arm;
    }
    (out as { skills?: Record<string, number> }).skills = normalized;
  }
  return out;
}
function withoutDerivedContractEconomy(snapshot: PlayerSnapshot | Player): PlayerSnapshot {
  const stable = normalizeSnapshot(snapshot);
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
  };
}

function youthContext(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
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
  };
}

describe("generation neutrality", () => {
  it("generates deterministically for a fixed seed and stays within OVR tolerance", () => {
    const position: Position = "DM";
    const target = 75;
    const first = generateSkillsForTarget(createRng(30100000), position, target);
    const second = generateSkillsForTarget(createRng(30100000), position, target);
    expect(first.skills).toEqual(second.skills);
    expect(Math.abs(overallFromSkills(position, first.skills) - target)).toBeLessThanOrEqual(SKILL_TARGET_TOLERANCE_OVR);
  });

  it("keeps the anonymous recipe laws, order, variants, and duplicates per the §12 split", () => {
    const pools = SKILL_SHAPE_RECIPES;
    expect(pools.DM.length).toBeGreaterThan(0);
    expect(pools.DM.every((r) => r.variant === 0)).toBe(true);
    expect(pools.AM.length).toBeGreaterThan(0);
    expect(pools.AM.every((r) => r.variant === 1)).toBe(true);
    expect(pools.LW.every((r) => r.variant === 2)).toBe(true);
    expect(pools.RW.every((r) => r.variant === 2)).toBe(true);
    expect(pools.ST.every((r) => r.variant === 1)).toBe(true);
    expect(pools.LB).toEqual(pools.RB);
    expect(pools.LW).toEqual(pools.RW);
  });

  it("generates a full initial senior roster with the hierarchical position template", () => {
    const template = seniorRosterTemplate(30);
    expect(template).toHaveLength(30);
    // §11: broad counts stay [3,4,5,10,8] at the shipped size.
    const group = (pos: string) => (pos === "GK" ? "GK" : pos === "LB" || pos === "RB" ? "FB" : pos === "CB" ? "CB" : pos === "DM" || pos === "AM" ? "MF" : "FW");
    const counts: Record<string, number> = { GK: 0, FB: 0, CB: 0, MF: 0, FW: 0 };
    for (const pos of template) counts[group(pos)]++;
    expect(counts).toEqual({ GK: 3, FB: 4, CB: 5, MF: 10, FW: 8 });
    const roles = new Set(template);
    expect(roles.size).toBeGreaterThanOrEqual(7);
    expect(roles.has("GK")).toBe(true);
    expect(roles.has("ST")).toBe(true);
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
