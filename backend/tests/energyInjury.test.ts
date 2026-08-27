import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { calendarValues } from "../src/services/seasonCalendar";
import {
  ageFactor,
  acuteFactor,
  energyLoss,
  injuryGameDays,
  lastingSetbackProbability,
  loadFactor,
  loadIncrement,
  recoverEnergy,
  readiness,
} from "../src/game/energyInjury";

describe("energy and injury model", () => {
  it("matches the neutral 90-minute reference loss", () => {
    // Position 3 is the MID role (roleForPosition), which the reference loss
    // and roleLoad are calibrated on.
    expect(energyLoss({ energy: 100, age: 26, physicalSkill: 50, position: 3, pressing: 50, involvement: 0.5, minutes: 90 })).toBeCloseTo(18, 10);
  });

  it("preserves role and pressing ordering", () => {
    const base = { energy: 100, age: 26, physicalSkill: 50, pressing: 50, involvement: 0.5, minutes: 90 } as const;
    const gk = energyLoss({ ...base, position: 0 });
    const def = energyLoss({ ...base, position: 1 });
    const cb = energyLoss({ ...base, position: 2 });
    const mid = energyLoss({ ...base, position: 3 });
    const att = energyLoss({ ...base, position: 4 });
    expect(gk).toBeLessThan(def);
    expect(cb).toBeCloseTo(def, 10);
    expect(def).toBeLessThan(att);
    expect(att).toBeLessThan(mid);
    expect(energyLoss({ ...base, position: 2, pressing: 0 })).toBeLessThan(energyLoss({ ...base, position: 2, pressing: 50 }));
    expect(energyLoss({ ...base, position: 2, pressing: 50 })).toBeLessThan(energyLoss({ ...base, position: 2, pressing: 100 }));
  });

  it("uses continuous readiness and monotonic risk multipliers", () => {
    expect(readiness(90)).toBeLessThan(1);
    expect(readiness(90)).toBeGreaterThan(readiness(50));
    expect(acuteFactor(75)).toBeGreaterThan(acuteFactor(92));
    expect(loadFactor(1.5)).toBeGreaterThan(loadFactor(0.75));
    expect(ageFactor(35)).toBeGreaterThan(ageFactor(26));
    expect(ageFactor(26)).toBeGreaterThan(ageFactor(21));
  });

  it("uses derived calendar scaling and bounded lasting setbacks", () => {
    expect(injuryGameDays(5, 14, 2)).toBe(1);
    expect(lastingSetbackProbability(14)).toBe(0);
    expect(lastingSetbackProbability(60)).toBeGreaterThan(lastingSetbackProbability(21));
    expect(lastingSetbackProbability(10_000)).toBeLessThanOrEqual(0.2);
  });

  it("produces the intended natural rotation curve", () => {
    // Plan 9 §11 canonical scenario, driven from the derived calendar.
    const { starts } = rotation(26, 6);
    expect(starts).toEqual([100, 100, 96, 90, 84, 78]);
  });

  it("keeps the prime rotation sequence within the plan tolerance", () => {
    const planTargets = [100, 99, 95, 90, 83, 77];
    const { starts } = rotation(26, 6);
    starts.forEach((start, index) => expect(Math.abs(start - planTargets[index])).toBeLessThanOrEqual(3));
  });

  it("shows earlier rotation pressure for a 35-year-old (plan §11)", () => {
    const planTargets = [100, 96, 90, 82, 73];
    const { starts } = rotation(35, 5);
    starts.forEach((start, index) => expect(Math.abs(start - planTargets[index])).toBeLessThanOrEqual(4));
  });

  it("restores a rotated prime player to at least 97 Energy after one rest (plan §30.6)", () => {
    const { starts } = rotation(26, 6, 5);
    expect(starts.length).toBe(5); // five played slots, one rested
    expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(97);
  });

  it("recovers fully across the inter-season gap without a reset (plan §30.7)", () => {
    const calendar = calendarValues();
    const player: any = { age: 26, skills: { vel: 50, des: 50, arm: 50 } };
    let energy = 62;
    let load = 3;
    for (let day = 0; day < calendar.interseasonDays; day++) {
      load *= Math.pow(2, -1 / (calendar.matchSpacingDays * 1.0));
      energy = recoverEnergy({ ...player, energy, recentLoad: load }, load, calendar.matchSpacingDays);
    }
    expect(Math.round(energy)).toBe(100);
    expect(load).toBeLessThanOrEqual(0.2 * 3);
  });

  it("keeps severity draws deterministic for the same seed", async () => {
    const { drawInjurySeverity } = await import("../src/game/energyInjury");
    const a = drawInjurySeverity(createRng(44), 26);
    const b = drawInjurySeverity(createRng(44), 26);
    expect(b).toEqual(a);
  });
});

/** Neutral player (plan 9 §11): age/physical/MID/pressing/involvement fixed,
 * two game-days between matches taken from the derived calendar. Simulates the
 * exact production order per game-day advance (plan §25): recentLoad decays and
 * Energy recovers EVERY game-day morning, then the scheduled league match kicks
 * off later that day. `restSlot` skips that slot's fixture entirely. Position 3
 * is the MID role (roleForPosition), which the reference loss is calibrated on. */
function rotation(age: number, slots: number, restSlot?: number): { starts: number[] } {
  const spacing = calendarValues().matchSpacingDays;
  const player: any = { age, skills: { vel: 50, des: 50, arm: 50 } };
  let energy = 100;
  let load = 0;
  const starts: number[] = [];
  for (let day = 1; day <= slots * spacing; day++) {
    load *= Math.pow(2, -1 / spacing);
    energy = recoverEnergy({ ...player, energy, recentLoad: load }, load, spacing);
    const slot = Math.floor((day - 1) / spacing) + 1;
    const isMatchDay = (day - 1) % spacing === spacing - 1;
    if (isMatchDay && slot !== restSlot) {
      starts.push(Math.round(energy));
      energy = Math.max(0, energy - energyLoss({ energy, age, physicalSkill: 50, position: 3, pressing: 50, involvement: 0.5, minutes: 90 }));
      load = Math.min(6, load + loadIncrement({ position: 3, pressing: 50, involvement: 0.5, minutes: 90 }));
    }
  }
  return { starts };
}
