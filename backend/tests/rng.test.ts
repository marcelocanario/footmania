import { describe, expect, it } from "vitest";
import { beta, createRng, normal, nextDouble, truncatedNormal } from "../src/game/rng";
import { calibrationDescribe } from "./calibration";

calibrationDescribe("rng distribution helpers", () => {
  it("normal respects bounds statistically and is deterministic per seed", () => {
    const rng1 = createRng(123);
    const rng2 = createRng(123);
    for (let i = 0; i < 100; i++) {
      const a = normal(rng1, 0, 1);
      const b = normal(rng2, 0, 1);
      expect(a).toBe(b);
    }
    let sum = 0;
    const n = 50000;
    const rng = createRng(7);
    for (let i = 0; i < n; i++) sum += normal(rng, 0, 1);
    expect(sum / n).toBeCloseTo(0, 0.05);
  });

  it("truncatedNormal always stays inside bounds and shifts the mean under asymmetric truncation", () => {
    const rng = createRng(42);
    for (let i = 0; i < 20000; i++) {
      const x = truncatedNormal(rng, 0, 1, -0.5, 2);
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(2);
    }
    const rng2 = createRng(42);
    let sum = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) sum += truncatedNormal(rng2, 0, 1, -0.5, 2);
    const mean = sum / n;
    // Truncating the left tail pushes the mean right of 0.
    expect(mean).toBeGreaterThan(0.2);
  });

  it("truncatedNormal is a TRUE truncated normal: symmetric for ±3, no clamping pile-up", () => {
    const n = 200000;
    const rng = createRng(2024);
    const values: number[] = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = truncatedNormal(rng, 0, 1, -3, 3);
      values.push(x);
      sum += x;
    }
    // Truncation at ±3 barely reduces the stdDev below 1 (0.9890).
    const mean = sum / n;
    const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    expect(mean).toBeCloseTo(0, 0.01);
    expect(Math.sqrt(variance)).toBeCloseTo(0.989, 0.01);
    // No value sits exactly at the bounds (inverse-CDF sampling never clamps).
    expect(values.some((x) => x === 3)).toBe(false);
    expect(values.some((x) => x === -3)).toBe(false);
    // Center substantially denser than tails + symmetry.
    const center = values.filter((x) => Math.abs(x) < 1).length / n;
    const tailHigh = values.filter((x) => x > 2).length / n;
    const tailLow = values.filter((x) => x < -2).length / n;
    expect(center).toBeGreaterThan(0.65);
    expect(center).toBeLessThan(0.72);
    expect(Math.abs(tailHigh - tailLow) / n).toBeLessThan(0.005);
  });

  it("beta stays within [0,1], is deterministic, and concentrates around its mean", () => {
    const rng1 = createRng(99);
    const rng2 = createRng(99);
    for (let i = 0; i < 50; i++) {
      const a = beta(rng1, 5, 5);
      const b = beta(rng2, 5, 5);
      expect(a).toBe(b);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(1);
    }
    const rng = createRng(5);
    let sum = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) sum += beta(rng, 5, 5);
    expect(sum / n).toBeCloseTo(0.5, 0.03);
  });

});

describe("rng edge cases", () => {
  it("never consumes the stream for stdDev 0 or degenerate truncation", () => {
    const rng = createRng(1);
    const before = rng.state;
    const x = truncatedNormal(rng, 5, 0, 2, 8);
    expect(x).toBe(5);
    expect(rng.state).toBe(before);
  });
});
