import { describe, expect, it } from "vitest";
import { readShippedMatchSimulatorConfig, validateMatchSimulatorConfig } from "../src/matchSimulatorConfig";

/**
 * Negative tests for §18.2 config validation.
 *
 * These exist because the shipped config silently disagreed with the plan for a
 * whole implementation cycle: `shooterRoleWeights` still carried a `CM` row and
 * had no `AM`, so attacking midfielders shot at a hard-coded fallback weight in
 * nearly every match. Nothing failed. Every rule below must now break startup.
 */

/** Deep clone of the shipped config so each case perturbs exactly one thing. */
function shipped(): Record<string, any> {
  return structuredClone(readShippedMatchSimulatorConfig()) as Record<string, any>;
}

function expectRejected(mutate: (cfg: Record<string, any>) => void, pattern: RegExp): void {
  const cfg = shipped();
  mutate(cfg);
  const result = validateMatchSimulatorConfig(cfg);
  expect(result.ok, "config was accepted but should have been rejected").toBe(false);
  if (!result.ok) expect(result.message).toMatch(pattern);
}

describe("match-simulator config validation", () => {
  it("accepts the shipped config", () => {
    expect(validateMatchSimulatorConfig(shipped())).toEqual({ ok: true });
  });

  // --- §18.2 role-keyed tables -------------------------------------------

  it("rejects a shooter-role table missing a deployed role", () => {
    expectRejected((cfg) => { delete cfg.shotModel.shooterRoleWeights.AM; }, /shooterRoleWeights is missing deployed role AM/);
  });

  it("rejects the obsolete CM row", () => {
    expectRejected((cfg) => { cfg.shotModel.shooterRoleWeights.CM = 0.55; }, /shooterRoleWeights has unknown deployed role CM/);
  });

  it("rejects a formation-support kernel missing a role or not summing to one", () => {
    expectRejected((cfg) => { delete cfg.formationSupport.DM; }, /formationSupport is missing deployed role DM/);
    expectRejected((cfg) => { cfg.formationSupport.ST.BOX = 0.9; }, /formationSupport\.ST sums to/);
  });

  // --- §5.3/§5.4 canonical attributes -------------------------------------

  it("rejects obsolete canonical attribute aliases", () => {
    for (const [alias, action] of [["technical", "PASS"], ["physical", "DRIBBLE"], ["gk", "SHOT"], ["discipline", "CLEARANCE"]] as const) {
      expectRejected((cfg) => {
        cfg.actionQuality.attributeWeights[action] = { [alias]: 1 };
      }, new RegExp(`unknown canonical attribute ${alias}`));
    }
  });

  it("rejects a missing action row and a row that does not sum to one", () => {
    expectRejected((cfg) => { delete cfg.actionQuality.attributeWeights.CROSS; }, /missing the CROSS row/);
    expectRejected((cfg) => { cfg.actionQuality.defensiveResistanceWeights.SHOT.defending = 0.5; }, /defensiveResistanceWeights\.SHOT sums to/);
  });

  it("rejects athleticism combined with either of its constituents", () => {
    expectRejected((cfg) => {
      cfg.actionQuality.attributeWeights.CARRY = { athleticism: 0.6, pace: 0.4 };
    }, /combines athleticism with pace\/defending/);
    expectRejected((cfg) => {
      cfg.actionQuality.defensiveResistanceWeights.PASS = { athleticism: 0.6, defending: 0.4 };
    }, /combines athleticism with pace\/defending/);
  });

  // --- §7 compatibility matrix -------------------------------------------

  it("requires the out-of-position matrix and the defending-control block", () => {
    expectRejected((cfg) => { delete cfg.outOfPosition; }, /outOfPosition/);
    expectRejected((cfg) => { delete cfg.defendingControl; }, /defendingControl/);
  });

  it("rejects a broken GK exclusivity rule in either direction", () => {
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.CB.GK = 20; }, /CB->GK must be null/);
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.GK.CB = 20; }, /GK->CB must be null/);
  });

  it("rejects a non-zero natural identity pairing", () => {
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.DM.DM = 1; }, /DM->DM must be 0/);
  });

  it("rejects a missing cell, an unknown key and an out-of-range penalty", () => {
    expectRejected((cfg) => { delete cfg.outOfPosition.skillPenaltyByNaturalAndRole.LB.DM; }, /LB->DM is missing/);
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.LB.CM = 5; }, /row LB has unknown deployed role CM/);
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.LB.CB = 4.5; }, /must be an integer 0\.\.100 or null/);
    expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.LB.CB = -1; }, /must be an integer 0\.\.100 or null/);
  });

  it("rejects the removed legacy sub-roles as unknown in the matrix", () => {
    for (const legacy of ["SW", "LM", "RM"]) {
      expectRejected((cfg) => { cfg.outOfPosition.skillPenaltyByNaturalAndRole.LB[legacy] = 5; }, /row LB has unknown deployed role/);
    }
  });

  it("rejects suitability bands that are unordered or fail to cover the matrix", () => {
    expectRejected((cfg) => { cfg.outOfPosition.suitabilityBands.reverse(); }, /must be ordered by maxPenalty/);
    expectRejected((cfg) => { cfg.outOfPosition.suitabilityBands.pop(); }, /is not covered by suitabilityBands/);
  });

  // --- §9.2/§9.5/§10 renamed and removed keys -----------------------------

  it("rejects the removed replacementWeights.fit term", () => {
    expectRejected((cfg) => {
      cfg.substitutionAi.replacementWeights = { effectiveSkill: 0.65, energy: 0.25, fit: 0.1 };
    }, /fit/);
  });

  it("rejects replacement weights that do not sum to one", () => {
    expectRejected((cfg) => {
      cfg.substitutionAi.replacementWeights = { effectiveSkill: 0.5, energy: 0.4 };
    }, /replacementWeights must sum to 1/);
  });

  it("rejects the legacy press*Physical* names rather than silently aliasing them", () => {
    expectRejected((cfg) => {
      cfg.aiPregameTactics.pressPhysicalWeight = cfg.aiPregameTactics.pressAthleticismWeight;
      delete cfg.aiPregameTactics.pressAthleticismWeight;
    }, /pressPhysicalWeight|pressAthleticismWeight/);
    expectRejected((cfg) => {
      cfg.aiPregameTactics.pressingHeavyPhysicalMin = 56;
    }, /pressingHeavyPhysicalMin/);
  });

  it("requires the new AI coefficients rather than defaulting them in code", () => {
    expectRejected((cfg) => { delete cfg.aiPregameTactics.futureCostWeight; }, /futureCostWeight/);
    expectRejected((cfg) => { delete cfg.aiPregameTactics.controlPlaymakingShare; }, /controlPlaymakingShare/);
    expectRejected((cfg) => { cfg.aiPregameTactics.controlPlaymakingShare = 1.5; }, /controlPlaymakingShare/);
  });
});
