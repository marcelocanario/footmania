import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type TargetFile = {
  neutralPopulationBands: Record<string, [number, number]>;
  tacticalFamiliarity: {
    latentInfluenceContract: { team: number; tactics: number; luck: number };
    equalFamiliarityLevels: number[];
  };
  permanentPlayerLoss: {
    zeroLossControl: { pairedSeedExactNoOp: boolean };
    onePlayerOutcomeTargets: Array<{ minute: number; elevenPlayerWin: number; draw: number; tenPlayerWin: number }>;
    multiplePlayerHeuristic: { empiricalTargetAvailable: boolean };
    causalPathways: { winProbability: string };
  };
};

const targets = JSON.parse(
  readFileSync(join(process.cwd(), "config", "match-calibration-targets.json"), "utf8"),
) as TargetFile;

describe("match calibration target contract", () => {
  it("keeps every neutral population band ordered", () => {
    for (const [metric, [low, high]] of Object.entries(targets.neutralPopulationBands)) {
      expect(low, `${metric} lower bound`).toBeLessThan(high);
    }
  });

  it("preserves the 40/35/25 influence contract", () => {
    const influence = targets.tacticalFamiliarity.latentInfluenceContract;
    expect(influence).toMatchObject({ team: 0.4, tactics: 0.35, luck: 0.25 });
    expect(influence.team + influence.tactics + influence.luck).toBeCloseTo(1, 12);
    expect(targets.tacticalFamiliarity.equalFamiliarityLevels).toEqual([25, 50, 75, 90, 100]);
  });

  it("keeps published one-player outcomes valid and weaker for later dismissals", () => {
    const rows = targets.permanentPlayerLoss.onePlayerOutcomeTargets;
    for (const row of rows) {
      expect(row.elevenPlayerWin + row.draw + row.tenPlayerWin).toBeCloseTo(1, 12);
    }
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].minute).toBeGreaterThan(rows[index - 1].minute);
      expect(rows[index].elevenPlayerWin).toBeLessThan(rows[index - 1].elevenPlayerWin);
      expect(rows[index].tenPlayerWin).toBeGreaterThan(rows[index - 1].tenPlayerWin);
    }
  });

  it("requires a no-op control and labels multi-player targets as heuristic", () => {
    expect(targets.permanentPlayerLoss.zeroLossControl.pairedSeedExactNoOp).toBe(true);
    expect(targets.permanentPlayerLoss.multiplePlayerHeuristic.empiricalTargetAvailable).toBe(false);
    expect(targets.permanentPlayerLoss.causalPathways.winProbability).toMatch(/never modified directly/i);
  });
});
