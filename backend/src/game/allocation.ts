/**
 * Cohort count allocation (§11.2). Leaf module: it imports only the RNG so both
 * `playerGeneration` and `generationModel` can use it without a cycle — the
 * previous circular-import workaround was a hand-copied second implementation
 * of the systematic-rounding allocator inside `generationModel`.
 */
import { createRng, nextDouble } from "./rng";

/**
 * Deterministic largest-remainder broad-group allocation (§11.2): floors,
 * then awards remaining seats by descending fractional remainder, breaking
 * equal remainders by declared key order. Initial senior, filler and initial
 * academy broad counts use this and stay identical to the pre-change counts.
 */
export function allocateBroadGroupCounts(
  total: number,
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const keys = Object.keys(weights);
  const weightSum = keys.reduce((sum, key) => sum + weights[key], 0);
  if (weightSum <= 0) throw new Error("allocateBroadGroupCounts requires positive weights");
  const exact = keys.map((key) => (weights[key] / weightSum) * total);
  const allocated = exact.map((x) => Math.floor(x));
  let remaining = total - allocated.reduce((a, b) => a + b, 0);
  const order = keys.map((_, i) => i).sort((a, b) => {
    const fa = exact[a] - allocated[a];
    const fb = exact[b] - allocated[b];
    if (Math.abs(fa - fb) > 1e-9) return fb - fa;
    return a - b; // declared group order breaks ties
  });
  for (let i = 0; i < remaining; i++) allocated[order[i % order.length]] += 1;
  return Object.fromEntries(keys.map((key, i) => [key, allocated[i]]));
}

/** FNV-1a 32-bit hash of a string (seeded allocator stream). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Systematic unbiased rounding (§11.2): floors, then awards the remaining
 * seats by drawing ONE offset uniformly in [0,1) from a local FNV-1a-seeded
 * RNG (never `world.rng`). Points `offset + j` fall into half-open cumulative
 * residual intervals in declared key order; the final interval absorbs only
 * floating-point endpoint error. Deterministic for equal inputs/seed keys.
 */
export function allocateSeededCounts<K extends string>(
  total: number,
  weights: Readonly<Record<K, number>>,
  seedKey: string,
): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const weightSum = keys.reduce((sum, key) => sum + weights[key], 0);
  if (weightSum <= 0) throw new Error("allocateSeededCounts requires positive weights");
  const exact = keys.map((key) => (weights[key] / weightSum) * total);
  const floors = exact.map((x) => Math.floor(x));
  const residuals = exact.map((x, i) => x - floors[i]);
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  if (remaining === 0) {
    return Object.fromEntries(keys.map((key, i) => [key, floors[i]])) as Record<K, number>;
  }
  const rng = createRng(fnv1a(seedKey));
  const offset = nextDouble(rng);
  const result = [...floors];
  // Build half-open cumulative residual intervals in declared key order.
  let cursor = 0;
  for (let j = 0; j < remaining; j++) {
    const point = offset + j;
    // Find the interval containing the point (allow the last interval to
    // absorb floating-point endpoint error).
    let found = -1;
    for (let i = 0; i < keys.length; i++) {
      const lo = cursor;
      const hi = cursor + residuals[i];
      if (point >= lo && (point < hi || (i === keys.length - 1 && point <= hi + 1e-9))) {
        found = i;
        break;
      }
      cursor = hi;
    }
    if (found === -1) {
      // Fall back to the interval with the largest residual (endpoint error).
      let best = 0;
      for (let i = 1; i < keys.length; i++) if (residuals[i] > residuals[best]) best = i;
      found = best;
    }
    result[found] += 1;
    cursor = 0;
  }
  const out = Object.fromEntries(keys.map((key, i) => [key, result[i]])) as Record<K, number>;
  const sum = (Object.values(out) as number[]).reduce((a: number, b: number) => a + b, 0);
  if (sum !== total) throw new Error(`allocateSeededCounts produced total ${sum} for target ${total}`);
  for (let i = 0; i < keys.length; i++) {
    if (result[i] < floors[i] || result[i] > Math.ceil(exact[i])) {
      throw new Error(`allocateSeededCounts produced out-of-bounds count for ${keys[i]}`);
    }
  }
  return out;
}
