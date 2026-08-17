export interface RngState {
  seed: number;
  state: number;
}

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0, state: (seed >>> 0) || 0x9e3779b9 };
}

export function nextUint(rng: RngState): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export function nextInt(rng: RngState, n: number): number {
  if (n <= 0) return 0;
  return nextUint(rng) % n;
}

export function nextDouble(rng: RngState): number {
  return nextUint(rng) / 4294967296;
}

export function nextBoolean(rng: RngState): boolean {
  return nextUint(rng) % 2 === 0;
}

export function chance(rng: RngState, percent: number): boolean {
  return nextUint(rng) % 100 < percent;
}

export function pick<T>(rng: RngState, arr: T[]): T {
  return arr[nextInt(rng, arr.length)];
}

export function shuffle<T>(rng: RngState, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

export function chanceDenom(rng: RngState, denominator: number): boolean {
  return nextUint(rng) % denominator === 0;
}

// Box–Muller transform. nextDouble yields [0, 1); the zero guard keeps log() finite.
export function normal(rng: RngState, mean: number, stdDev: number): number {
  let u = nextDouble(rng);
  if (u === 0) u = Number.EPSILON;
  const v = nextDouble(rng);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

// Rejection sampling with a hard iteration cap; falls back to clamping the mean.
export function truncatedNormal(rng: RngState, mean: number, stdDev: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (stdDev <= 0) return Math.max(lo, Math.min(hi, mean));
  for (let i = 0; i < 1000; i++) {
    const x = normal(rng, mean, stdDev);
    if (x >= lo && x <= hi) return x;
  }
  return Math.max(lo, Math.min(hi, mean));
}

// Marsaglia–Tsang gamma sampler (valid for shape >= 1).
function gammaSample(rng: RngState, shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng, 0, 1);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = nextDouble(rng);
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

// Beta via the gamma-ratio method (alpha, beta >= 1).
export function beta(rng: RngState, alpha: number, betaParam: number): number {
  const a = gammaSample(rng, alpha);
  const b = gammaSample(rng, betaParam);
  return a / (a + b);
}
