import type { Position, SkillSet } from "./types";

export type SkillKey = keyof SkillSet;
export type WeightedSkills = Partial<Record<SkillKey, number>>;

export const OVERALL_WEIGHTS: Record<Position, Readonly<WeightedSkills>> = {
  0: { gol: 0.80, vel: 0.08, tec: 0.06, pas: 0.04, des: 0.01, arm: 0.01 },
  1: { des: 0.45, vel: 0.16, pas: 0.16, tec: 0.12, arm: 0.07, fin: 0.03, gol: 0.01 },
  2: { des: 0.56, arm: 0.12, pas: 0.12, vel: 0.08, tec: 0.07, fin: 0.04, gol: 0.01 },
  3: { pas: 0.25, arm: 0.25, tec: 0.20, vel: 0.12, des: 0.10, fin: 0.07, gol: 0.01 },
  4: { fin: 0.46, vel: 0.20, tec: 0.15, arm: 0.08, pas: 0.07, des: 0.03, gol: 0.01 },
};

export const TACTICAL_RATING_WEIGHTS: Record<number, Readonly<WeightedSkills>> = {
  1: { gol: 0.6, tec: 0.15, vel: 0.15, pas: 0.1 },
  2: { des: 0.4, vel: 0.1, tec: 0.1, pas: 0.3, arm: 0.05, fin: 0.05 },
  3: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  4: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  5: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  6: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  7: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  8: { des: 0.5, tec: 0.1, vel: 0.25, pas: 0.1, arm: 0.05 },
  9: { des: 0.4, vel: 0.1, tec: 0.1, pas: 0.3, arm: 0.05, fin: 0.05 },
  10: { des: 0.05, vel: 0.25, tec: 0.15, pas: 0.25, arm: 0.2, fin: 0.1 },
  11: { des: 0.4, vel: 0.15, tec: 0.1, pas: 0.2, arm: 0.1, fin: 0.05 },
  12: { des: 0.4, vel: 0.15, tec: 0.1, pas: 0.2, arm: 0.1, fin: 0.05 },
  13: { des: 0.4, vel: 0.15, tec: 0.1, pas: 0.2, arm: 0.1, fin: 0.05 },
  14: { des: 0.05, vel: 0.1, tec: 0.1, pas: 0.25, arm: 0.4, fin: 0.1 },
  15: { des: 0.05, vel: 0.1, tec: 0.1, pas: 0.25, arm: 0.4, fin: 0.1 },
  16: { des: 0.05, vel: 0.1, tec: 0.1, pas: 0.25, arm: 0.4, fin: 0.1 },
  17: { des: 0.05, vel: 0.25, tec: 0.15, pas: 0.25, arm: 0.2, fin: 0.1 },
  18: { vel: 0.25, tec: 0.15, pas: 0.15, arm: 0.05, fin: 0.4 },
  19: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  20: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  21: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  22: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  23: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  24: { vel: 0.25, tec: 0.25, pas: 0.05, arm: 0.05, fin: 0.4 },
  25: { vel: 0.25, tec: 0.15, pas: 0.15, arm: 0.05, fin: 0.4 },
};

export const SKILL_KEYS: SkillKey[] = ["gol", "vel", "tec", "pas", "des", "arm", "fin"];

// Calibration: the position's key attributes are generated near the seed
// overall, but supporting attributes are generated from club level/reputation
// and sit well below it, which compresses a plain weighted mean. These factors
// lift the aggregate back onto the same 1-100 scale the rest of the game
// (economy, transfers, thresholds) was tuned for. Sampled over full worlds.
export const OVERALL_SCALE: Record<Position, number> = { 0: 1.15, 1: 1.25, 2: 1.17, 3: 1.3, 4: 1.2 };

export function weightTotal(weights: WeightedSkills): number {
  return Object.values(weights).reduce((sum, weight) => sum + (weight ?? 0), 0);
}

export function overallFromSkills(position: Position, skills: SkillSet): number {
  const weighted = Object.entries(OVERALL_WEIGHTS[position]).reduce(
    (sum, [key, weight]) => sum + skills[key as SkillKey] * (weight ?? 0),
    0,
  );
  return Math.max(1, Math.min(100, Math.round(weighted * OVERALL_SCALE[position])));
}

export function tacticalSkillRating(skills: SkillSet, tacPos: number): number {
  const weights = TACTICAL_RATING_WEIGHTS[tacPos];
  if (!weights) return 0;
  return Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + Math.round(skills[key as SkillKey] * (weight ?? 0)),
    0,
  );
}

export function trainingWeights(position: Position, focus: "assistant" | "primary" | "secondary", skills?: SkillSet): Record<SkillKey, number> {
  const base = { ...OVERALL_WEIGHTS[position] } as Record<SkillKey, number>;
  const relevant = SKILL_KEYS.filter((key) => (base[key] ?? 0) > 0);
  let target: SkillKey | undefined;
  if (focus === "primary") target = relevant.sort((a, b) => base[b] - base[a])[0];
  if (focus === "secondary") target = relevant.sort((a, b) => base[b] - base[a])[1] ?? relevant[0];
  if (focus === "assistant") {
    target = relevant.sort((a, b) => (skills ? skills[a] - skills[b] : base[a] - base[b]) || base[a] - base[b] || a.localeCompare(b))[0];
  }
  if (target) base[target] += 0.20;
  const total = weightTotal(base);
  return Object.fromEntries(SKILL_KEYS.map((key) => [key, (base[key] ?? 0) / total])) as Record<SkillKey, number>;
}
