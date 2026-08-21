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

// Box–Muller transform. nextDouble yields [0, 1); the zero guard keeps log() finite.
export function normal(rng: RngState, mean: number, stdDev: number): number {
  let u = nextDouble(rng);
  if (u === 0) u = Number.EPSILON;
  const v = nextDouble(rng);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

const Sqrt2 = Math.SQRT2;

// Standard-normal CDF (Acklam's rational approximation, max abs error ~1e-9).
export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Sqrt2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

// Inverse standard-normal CDF (Acklam's rational approximation, ~1.15e-9).
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.6968302866538, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.5858368580409, -155.6989798598866, 66.8013118877197, -13.2806815528857];
  const c = [-0.0077848940024303, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.0077846957090415, 0.32246712907004, 2.445134137143, 3.754408661908];
  const plow = 0.02425;
  const q = p < plow ? Math.sqrt(-2 * Math.log(p)) : p > 1 - plow ? Math.sqrt(-2 * Math.log(1 - p)) : p - 0.5;
  if (p < plow) {
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * True truncated-normal sampling via inverse CDF: draws U ~ Uniform(0,1),
 * maps it through the truncated CDF, then applies the inverse normal CDF.
 * This does NOT clamp a plain normal draw, so no artificial probability pile
 * accumulates at the truncation bounds (player-generation spec §13).
 */
export function truncatedNormal(rng: RngState, mean: number, stdDev: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (stdDev <= 0) return Math.max(lo, Math.min(hi, mean));
  const a = (lo - mean) / stdDev;
  const b = (hi - mean) / stdDev;
  // Guard against pathological truncation windows.
  if (a >= b) return Math.max(lo, Math.min(hi, mean));
  const phiA = normalCdf(a);
  const phiB = normalCdf(b);
  const denom = phiB - phiA;
  if (!Number.isFinite(denom) || denom <= 0) return Math.max(lo, Math.min(hi, mean));
  let u = nextDouble(rng);
  if (u === 0) u = Number.EPSILON;
  if (u >= 1) u = 1 - Number.EPSILON;
  const uTruncated = phiA + u * denom;
  const z = inverseNormalCdf(uTruncated);
  return mean + z * stdDev;
}

// Marsaglia–Tsang gamma sampler (valid for shape >= 1).
function gammaSample(rng: RngState, shape: number): number {
  if (shape < 1) {
    // Boost trick: Gamma(k) = Gamma(1+k) * U^(1/k) for 0 < k < 1.
    const u = Math.max(Number.EPSILON, nextDouble(rng));
    return gammaSample(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
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

// Marsaglia–Tsang gamma sampler (valid for shape >= 1). Export the primitive so
// the match engine can sample Gamma(shape, scale) durations (plan §20).
export function gamma(rng: RngState, shape: number): number {
  return gammaSample(rng, shape);
}

// Beta via the gamma-ratio method (alpha, beta >= 1).
export function beta(rng: RngState, alpha: number, betaParam: number): number {
  const a = gammaSample(rng, alpha);
  const b = gammaSample(rng, betaParam);
  return a / (a + b);
}
