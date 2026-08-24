import { describe, expect, it } from "vitest";
import { remainingPlayerWorkloadMultiplier } from "../src/game/numericalDisadvantage";
import { MATCH_SIMULATOR_CONFIG as MS } from "../src/matchSimulatorConfig";

describe("numerical disadvantage workload", () => {
  it("is an exact no-op with a full side", () => {
    expect(remainingPlayerWorkloadMultiplier(11)).toBe(1);
    expect(remainingPlayerWorkloadMultiplier(12)).toBe(1);
  });

  it("increases monotonically as players are lost and remains capped", () => {
    const ten = remainingPlayerWorkloadMultiplier(10);
    const nine = remainingPlayerWorkloadMultiplier(9);
    const eight = remainingPlayerWorkloadMultiplier(8);

    expect(ten).toBeGreaterThan(1);
    expect(nine).toBeGreaterThan(ten);
    expect(eight).toBeGreaterThan(nine);
    expect(remainingPlayerWorkloadMultiplier(1)).toBe(remainingPlayerWorkloadMultiplier(0));
    expect(remainingPlayerWorkloadMultiplier(1)).toBeLessThanOrEqual(MS.numericalDisadvantage.maxRemainingPlayerWorkloadMultiplier);
  });
});
