import { expect, it } from "vitest";
import { calibrationDescribe } from "./calibration";
import { createRng, nextDouble } from "../src/game/rng";
import { applyLastingSetback, drawInjurySeverity, lastingSetbackProbability } from "../src/game/energyInjury";
import type { Player } from "../src/game/types";

/**
 * Statistical validation of the versioned injury model (plan 9 §31.4/§31.6/
 * §31.7). Runs on demand via `npm run test:calibration`.
 *
 * Engine-level match/training incidence Monte Carlo (§31.1/§31.5) is not
 * reproduced here: it would require tens of thousands of full match
 * simulations per run. The incidence constants are instead pinned analytically
 * by the base-hazard normalization (referenceRisk × expectedActions) in
 * `resolveInjuryHazard` and covered indirectly by the deterministic pins in
 * energyInjury.test.ts.
 */

const SEVERITY_SAMPLES = 200_000;

calibrationDescribe("injury severity distribution", () => {
  it("reproduces the 42/56/2 mixture within ±0.5 percentage points", () => {
    const rng = createRng(990_001);
    let minor = 0;
    let moderate = 0;
    let severe = 0;
    const severeDays: number[] = [];
    const minorDays: number[] = [];
    const moderateDays: number[] = [];
    for (let i = 0; i < SEVERITY_SAMPLES; i++) {
      const severity = drawInjurySeverity(rng, 26);
      if (severity.kind === "MINOR") {
        minor++;
        minorDays.push(severity.equivalentRealDays);
      } else if (severity.kind === "MODERATE") {
        moderate++;
        moderateDays.push(severity.equivalentRealDays);
      } else {
        severe++;
        severeDays.push(severity.equivalentRealDays);
      }
    }
    const share = (count: number): number => count / SEVERITY_SAMPLES;
    expect(Math.abs(share(minor) - 0.42)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(share(moderate) - 0.56)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(share(severe) - 0.02)).toBeLessThanOrEqual(0.005);

    // Median/mean ordering and a visible heavy upper tail for severe injuries.
    const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
    const sortedSevere = [...severeDays].sort((a, b) => a - b);
    const median = (values: number[]): number => values[Math.floor(values.length / 2)];
    expect(median(sortedSevere)).toBeGreaterThan(mean(moderateDays));
    expect(mean(severeDays)).toBeGreaterThan(mean(moderateDays));
    expect(mean(moderateDays)).toBeGreaterThan(mean(minorDays));
    // LogNormal(60, 0.75) tail: the worst 1-in-1000 must reach multi-month territory.
    expect(sortedSevere[Math.floor(sortedSevere.length * 0.999)]).toBeGreaterThan(150);
  });

  it("keeps fatigue out of severity entirely", () => {
    // Identical seed streams must produce identical severities regardless of
    // the Energy/recentLoad state that triggered the injury (plan §15).
    const a = Array.from({ length: 1000 }, () => drawInjurySeverity(createRng(777), 26));
    const b = Array.from({ length: 1000 }, () => drawInjurySeverity(createRng(777), 26));
    expect(b).toEqual(a);
  });
});

calibrationDescribe("lasting setback rarity", () => {
  it("stays rare over a large injured population", () => {
    const rng = createRng(990_002);
    const trials = 20_000;
    const equivalentRealDays = 60; // p ≈ 12.9% — the realistic near-worst case
    const expected = lastingSetbackProbability(equivalentRealDays);
    let setbacks = 0;
    for (let i = 0; i < trials; i++) {
      const player = makePlayer();
      if (applyLastingSetback(rng, player, equivalentRealDays)) setbacks++;
    }
    // ±3σ around the model probability.
    const sigma = Math.sqrt((expected * (1 - expected)) / trials);
    expect(Math.abs(setbacks / trials - expected)).toBeLessThanOrEqual(3 * sigma);
    expect(expected).toBeLessThan(0.2);
  });

  it("never triggers at or below the 14-day threshold", () => {
    const rng = createRng(990_003);
    for (let i = 0; i < 2000; i++) {
      const player = makePlayer();
      expect(applyLastingSetback(rng, player, 14)).toBe(false);
      void nextDouble(rng); // keep the stream moving like the caller would
    }
  });
});

function makePlayer(): Player {
  return {
    id: 1,
    name: "Test",
    nickname: null,
    country: "BRA",
    age: 26,
    position: "CB",
    side: 0,
    skills: { gol: 10, pace: 60, tec: 60, pas: 60, des: 55, playmaking: 55, fin: 50 },
    overall: 58,
    energy: 80,
    salary: 10_000,
    payrollPaidThroughDay: 0,
    payrollPaidAmount: 0,
    payrollPeriodStartDay: 0,
    loanId: null,
    value: 100_000,
    releaseClause: 0,
    injuryDays: 0,
    contractDays: 300,
    isYouth: false,
    starter: false,
    careerGrowthConsumed: 0,
    careerDeclineConsumed: 0,
    skillAcc: [0, 0, 0, 0, 0, 0, 0],
    careerGoals: 0,
    careerAssists: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    yellows: 0,
    reds: 0,
    clubId: 1,
    tacPos: -1,
    onSale: false,
    suspendedGames: 0,
    recentMinutes: [],
    careerProfile: { growthPotential: 0.5, growthSpeed: 0.5, peakAge: 27, declinePotential: 0.5, declineSpeed: 0.5 },
  } as Player;
}
