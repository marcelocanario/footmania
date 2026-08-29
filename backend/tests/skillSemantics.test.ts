import { describe, expect, it } from "vitest";
import {
  cardProbabilities,
  outcomeProbabilities,
  actionQualityWithOverride,
  defensiveResistanceWithOverride,
  weightedUsableZ,
  type FrozenContext,
  type FrozenSide,
} from "../src/game/probabilityEval";
import { athleticismOf, canonicalFromSkills, type CanonicalAttr } from "../src/game/matchSim";
import { athleticism, energyLoss, physicalSkill, recoverEnergy } from "../src/game/energyInjury";
import { MATCH_SIMULATOR_CONFIG as MS } from "../src/matchSimulatorConfig";
import { gameConfig } from "../src/config";
import type { SkillSet } from "../src/game/types";

const MS_POSITIONS = gameConfig.playerPositions;

/**
 * §20.15-20.17: the skill SEMANTIC contract. INVARIANTS #44 claims Passing and
 * Playmaking have distinct causal pathways, that Playmaking never enters a
 * physical calculation, and that higher Defending is controlled technique that
 * cannot raise foul or card risk. Those are the claims this file proves.
 */

const BASE: SkillSet = { gol: 50, pace: 50, tec: 50, pas: 50, des: 50, playmaking: 50, fin: 50 };

const CANONICAL: CanonicalAttr[] = [
  "goalkeeping", "pace", "technique", "passing", "defending", "playmaking", "athleticism", "finishing",
];

function usableZOf(skills: SkillSet): Record<string, number> {
  // Straight linear map from the raw skill so a single-skill delta is visible;
  // the pathway question is which weights READ which attribute, not the scale.
  return Object.fromEntries(CANONICAL.map((attr) => [attr, (canonicalFromSkills(skills, attr) - 50) / 10]));
}

function side(skills: SkillSet, overrides: Partial<FrozenSide> = {}): FrozenSide {
  return {
    involved: [{ playerId: 1, weight: 1, usableZ: usableZOf(skills) }],
    localDensity: 1,
    tactics: { style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
    supportRatio: 1,
    coverageRatio: 1,
    readinessMean: 1,
    organisation: 1,
    ...overrides,
  };
}

function context(attacker: SkillSet, defender: SkillSet): FrozenContext {
  return {
    phase: "OPEN",
    zone: "MID_CENTRAL",
    lane: "CENTRE",
    possessionSide: 0,
    homeNeutral: true,
    sides: { home: side(attacker), away: side(defender) },
    stateValue: 0.1,
  };
}

/** Action quality for one action with a single involved player. */
function quality(skills: SkillSet, action: string): number {
  // playerId 999 never matches, so no term is overridden: this is the plain
  // weighted mean the engine consumes.
  return actionQualityWithOverride(side(skills), "MID_CENTRAL", action, 999, {});
}

function resistance(skills: SkillSet, action: string): number {
  return defensiveResistanceWithOverride(side(skills), "MID_CENTRAL", action, 999, {});
}

describe("skill semantics: Passing vs Playmaking", () => {
  it("makes Passing — and only Passing — drive PASS and CROSS execution quality", () => {
    const better = { ...BASE, pas: 90 };
    expect(quality(better, "PASS")).toBeGreaterThan(quality(BASE, "PASS"));
    expect(quality(better, "CROSS")).toBeGreaterThan(quality(BASE, "CROSS"));
    // Playmaking is not an execution attribute: it appears in NO action row.
    const creative = { ...BASE, playmaking: 90 };
    for (const action of ["PASS", "CROSS", "CARRY", "DRIBBLE", "CLEARANCE", "SHOT"]) {
      expect(quality(creative, action), `${action} action quality`).toBe(quality(BASE, action));
      expect(resistance(creative, action), `${action} resistance`).toBe(resistance(BASE, action));
    }
  });

  it("keeps Playmaking out of pass retention and shot conversion", () => {
    const creative = { ...BASE, playmaking: 95 };
    const base = outcomeProbabilities(context(BASE, BASE), "PASS");
    const withPlaymaking = outcomeProbabilities(context(creative, BASE), "PASS");
    expect(withPlaymaking).toEqual(base);
    // Finishing, by contrast, is exactly the shot attribute.
    expect(quality({ ...BASE, fin: 90 }, "SHOT")).toBeGreaterThan(quality(BASE, "SHOT"));
    expect(quality({ ...BASE, playmaking: 90 }, "SHOT")).toBe(quality(BASE, "SHOT"));
  });

  it("declares no action row that reads playmaking at all", () => {
    // The config-level statement of the same invariant: Playmaking's only match
    // pathway is forward destination utility (matchSim.destinationUtility),
    // which is not an action-weight row.
    for (const row of Object.values(MS.actionQuality.attributeWeights)) {
      expect(row.playmaking).toBeUndefined();
    }
    for (const row of Object.values(MS.actionQuality.defensiveResistanceWeights)) {
      expect(row.playmaking).toBeUndefined();
    }
  });
});

describe("skill semantics: athleticism is Pace + Defending only", () => {
  it("never lets Playmaking enter the athleticism composite", () => {
    // The signature is the first line of defence: `athleticismOf` accepts only
    // `Pick<SkillSet, "pace" | "des">`, so passing playmaking is a type error,
    // not merely an ignored field. This asserts the runtime behaviour matches.
    const creative: SkillSet = { ...BASE, playmaking: 99 };
    expect(athleticismOf(creative)).toBe(athleticismOf(BASE));
    expect(athleticism(creative)).toBe(athleticism(BASE));
    expect(athleticismOf({ ...BASE, pace: 90 })).toBeGreaterThan(athleticismOf(BASE));
    expect(athleticismOf({ ...BASE, des: 90 })).toBeGreaterThan(athleticismOf(BASE));
    // Only pace and des are configured contributors, and they sum to one.
    const weights = MS_POSITIONS.athleticismWeights;
    expect(Object.keys(weights).sort()).toEqual(["des", "pace"]);
    expect(weights.pace + weights.des).toBeCloseTo(1, 12);
  });

  it("keeps Playmaking out of fatigue and recovery", () => {
    const creative = { ...BASE, playmaking: 99 };
    const load = { energy: 60, age: 25, position: "MID", pressing: 50, involvement: 0.5, minutes: 90 };
    expect(energyLoss({ ...load, physicalSkill: physicalSkill({ skills: creative }) }))
      .toBe(energyLoss({ ...load, physicalSkill: physicalSkill({ skills: BASE }) }));
    const player = { skills: BASE, energy: 60, age: 25, recentLoad: 1 } as never;
    const creativePlayer = { skills: creative, energy: 60, age: 25, recentLoad: 1 } as never;
    expect(recoverEnergy(creativePlayer, 1, 2)).toBe(recoverEnergy(player, 1, 2));
    // Pace genuinely does change fatigue, so the equality above is not vacuous.
    expect(energyLoss({ ...load, physicalSkill: physicalSkill({ skills: { ...BASE, pace: 95 } }) }))
      .not.toBe(energyLoss({ ...load, physicalSkill: physicalSkill({ skills: BASE }) }));
  });

  it("keeps Playmaking out of the lasting injury setback weights", () => {
    for (const weights of [MS_INJURY.outfieldWeights, MS_INJURY.goalkeeperWeights]) {
      expect(Object.keys(weights)).not.toContain("playmaking");
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
    }
  });
});

describe("skill semantics: Defending is controlled technique", () => {
  it("never raises the foul-specific term for an otherwise identical defence", () => {
    // The four outcomes are one softmax, so the raw FOUL *share* is not the
    // right measure: raising defending also raises defensive resistance, which
    // collapses CONTINUE and mechanically inflates every other share. That is
    // the defence ending more possessions, not defending causing fouls.
    //
    // FOUL and RETAINED_RESTART carry no contest term, so their odds ratio
    // isolates the discipline pathway exactly:
    //   FOUL/RETAINED = (baseFoul/baseRetained) * exp(foulShift)
    // and foulShift is the only place defending enters. That ratio is the
    // invariant §5.6 actually states.
    const foulOdds = (des: number) => {
      const p = outcomeProbabilities(context(BASE, { ...BASE, des }), "PASS");
      return p.FOUL / p.RETAINED_RESTART;
    };
    let previous = Infinity;
    for (const des of [10, 30, 50, 70, 90]) {
      const odds = foulOdds(des);
      expect(odds, `des=${des}`).toBeLessThanOrEqual(previous + 1e-12);
      previous = odds;
    }
    // Strictly decreasing across the range, so the check has real teeth.
    expect(foulOdds(90)).toBeLessThan(foulOdds(10));
  });

  it("makes a stronger defence win the ball more, not foul more", () => {
    // The companion fact that explains the share arithmetic above: defending
    // raises turnovers and lowers retained possession.
    const weak = outcomeProbabilities(context(BASE, { ...BASE, des: 10 }), "PASS");
    const strong = outcomeProbabilities(context(BASE, { ...BASE, des: 90 }), "PASS");
    expect(strong.TURNOVER).toBeGreaterThan(weak.TURNOVER);
    expect(strong.CONTINUE).toBeLessThan(weak.CONTINUE);
  });

  it("never raises yellow or red card probability for an otherwise identical fouler", () => {
    const at = (zDefending: number) =>
      cardProbabilities({ zDefending, readiness: 1, pressIntensity: 0.5, stateValue: 0.1, alreadyBooked: false });
    let prevYellow = Infinity;
    let prevRed = Infinity;
    for (const z of [-3, -1, 0, 1, 3]) {
      const { pYellow, pRed } = at(z);
      expect(pYellow, `zDefending=${z}`).toBeLessThanOrEqual(prevYellow + 1e-12);
      expect(pRed, `zDefending=${z}`).toBeLessThanOrEqual(prevRed + 1e-12);
      prevYellow = pYellow;
      prevRed = pRed;
    }
    expect(at(3).pYellow).toBeLessThan(at(-3).pYellow);
    expect(at(3).pRed).toBeLessThan(at(-3).pRed);
  });

  it("uses one shared, config-backed discipline normalization", () => {
    // §5.6 moved both hard-coded constants into config; the engine and the
    // evaluator must read the same block, not re-declare it.
    expect(MS.defendingControl.riskMidpoint).toBe(0.5);
    expect(MS.defendingControl.zRiskScale).toBe(0.08);
  });
});

describe("skill semantics: canonical attribute mapping", () => {
  it("maps each canonical attribute to exactly its own skill", () => {
    const pairs: [CanonicalAttr, keyof SkillSet][] = [
      ["goalkeeping", "gol"], ["pace", "pace"], ["technique", "tec"],
      ["passing", "pas"], ["defending", "des"], ["playmaking", "playmaking"], ["finishing", "fin"],
    ];
    for (const [attr, key] of pairs) {
      expect(canonicalFromSkills({ ...BASE, [key]: 77 }, attr)).toBe(77);
      // Changing any OTHER skill leaves this attribute alone.
      for (const [, otherKey] of pairs) {
        if (otherKey === key) continue;
        expect(canonicalFromSkills({ ...BASE, [otherKey]: 77 }, attr), `${attr} vs ${otherKey}`).toBe(BASE[key]);
      }
    }
    expect(canonicalFromSkills(BASE, "athleticism")).toBe(athleticismOf(BASE));
  });

  it("carries all eight canonical values through the frozen evaluator side", () => {
    const s = side(BASE);
    for (const attr of CANONICAL) {
      expect(Number.isFinite(weightedUsableZ(s, attr)), attr).toBe(true);
    }
    // `discipline` was removed as a canonical name (§5.3).
    expect(s.involved[0].usableZ.discipline).toBeUndefined();
  });
});

// Loaded lazily so the assertion above reads against the shipped data file.
import ENERGY_INJURY from "../src/game/data/energy-injury-model.json";
const MS_INJURY = ENERGY_INJURY.lastingSetback as unknown as {
  outfieldWeights: Record<string, number>;
  goalkeeperWeights: Record<string, number>;
};

describe("energy/injury model schema", () => {
  it("is at schemaVersion 2 with explicit per-skill setback weights", () => {
    expect(ENERGY_INJURY.schemaVersion).toBe(2);
    expect(MS_INJURY.outfieldWeights).toEqual({ pace: 0.675, defending: 0.225, technical: 0.10 });
    expect(MS_INJURY.goalkeeperWeights).toEqual({ pace: 0.45, defending: 0.25, goalkeeping: 0.30 });
    // The ambiguous aggregate `physical` key is gone.
    expect(MS_INJURY.outfieldWeights.physical).toBeUndefined();
    expect(MS_INJURY.goalkeeperWeights.physical).toBeUndefined();
  });
});
