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
