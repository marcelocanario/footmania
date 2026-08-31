import { describe, expect, it } from "vitest";
import { deepEqual } from "../src/services/deepEqual";
import { makeClub } from "./helpers";
import { goldenSquad } from "./matchGolden";

/** Tiny local seeded PRNG (mulberry32) so the randomized cross-check below is
 *  reproducible across runs without borrowing the game's own seeded RNG,
 *  which exists for a different purpose (deterministic simulation, not test
 *  fixture generation). */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("deepEqual", () => {
  it("treats identical primitives as equal and different ones as not", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(0, false)).toBe(false);
  });

  it("treats NaN as equal to itself and unequal to null (unlike JSON.stringify)", () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(NaN, null)).toBe(false);
    // The documented JSON.stringify quirk this deliberately does NOT replicate.
    expect(JSON.stringify(NaN)).toBe(JSON.stringify(null));
  });

  it("compares arrays by length and element order", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, [2, 3]], [1, [2, 4]])).toBe(false);
  });

  it("never confuses an array with a plain object of the same shape", () => {
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ 0: "a", length: 1 }, ["a"])).toBe(false);
  });

  it("compares nested plain objects field by field", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("ignores key order (unlike JSON.stringify) for otherwise-identical objects", () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, x: 1, y: 2 };
    expect(deepEqual(a, b)).toBe(true);
    // The documented JSON.stringify quirk this deliberately does NOT replicate.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("distinguishes an explicit undefined property from an absent one, unlike JSON.stringify", () => {
    const withUndefined = { x: undefined, y: 1 };
    const withoutKey = { y: 1 };
    expect(deepEqual(withUndefined, withoutKey)).toBe(false);
    // JSON.stringify drops undefined-valued keys, so it would call these equal
    // -- the one direction where this is intentionally MORE conservative than
    // stringify-equality (see deepEqual.ts for why that direction is safe).
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutKey));
  });

  it("short-circuits on reference equality without touching structure", () => {
    // A cyclic structure would blow the stack if deepEqual recursed into it;
    // the a === b fast path must catch this before any traversal.
    const cyclic: any = { self: null };
    cyclic.self = cyclic;
    expect(deepEqual(cyclic, cyclic)).toBe(true);
  });

  it("agrees with JSON.stringify comparison on a large randomized battery of realistic world-shaped mutations", () => {
    // Build a realistic base: real clubs + a real generated squad (skills,
    // careerProfile, skillAcc, recentMinutes -- the actual nested shapes
    // persistWorld diffs), then apply a large number of random single-field
    // mutations and cross-check every JSON.stringify verdict against
    // deepEqual. The direction that matters for correctness (see deepEqual.ts)
    // is: whenever stringify says "different", deepEqual must also say
    // "different" -- a missed real change would mean a skipped database
    // write. The reverse (deepEqual reports a difference stringify missed) is
    // the documented safe direction and is not asserted against.
    const rand = mulberry32(20260831);
    const baseClub = makeClub({ id: 1 });
    const baseSquad = goldenSquad(1, 1, 31111, 1000);

    function clone<T>(value: T): T {
      return structuredClone(value);
    }

    function mutate(value: any, rand: () => number): any {
      const target = clone(value);
      const kind = Math.floor(rand() * 6);
      switch (kind) {
        case 0: // flip a scalar on the club
          target.cash = target.cash + 1;
          return target;
        case 1: // flip a nested scalar (skills)
          target.players = target.players ?? [];
          if (target.skills) target.skills.tec = (target.skills.tec % 99) + 1;
          return target;
        case 2: // add an array element
          if (Array.isArray(target.recentMinutes)) target.recentMinutes = [...target.recentMinutes, 42];
          return target;
        case 3: // remove an array element
          if (Array.isArray(target.recentMinutes) && target.recentMinutes.length > 0) target.recentMinutes = target.recentMinutes.slice(1);
          return target;
        case 4: // introduce an explicit undefined vs absent-key case
          target.__probe = rand() > 0.5 ? undefined : rand();
          return target;
        case 5: // no-op: identical clone
          return target;
        default:
          return target;
      }
    }

    let trials = 0;
    for (const base of [baseClub, ...baseSquad]) {
      for (let i = 0; i < 40; i++) {
        const a = base;
        const b = mutate(base, rand);
        const stringifyDifferent = JSON.stringify(a) !== JSON.stringify(b);
        const deepEqualDifferent = !deepEqual(a, b);
        if (stringifyDifferent) {
          // The critical safety direction: never miss a real change.
          expect(deepEqualDifferent, `trial ${trials}: stringify saw a difference deepEqual missed`).toBe(true);
        }
        trials++;
      }
    }
    expect(trials).toBeGreaterThan(400);
  });

  it("agrees with JSON.stringify when nothing at all changed", () => {
    const squad = goldenSquad(1, 1, 31111, 1000);
    for (const player of squad) {
      const copy = structuredClone(player);
      expect(deepEqual(player, copy)).toBe(true);
      expect(JSON.stringify(player) === JSON.stringify(copy)).toBe(true);
    }
  });
});
