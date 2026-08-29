import type { SkillSet } from "./types";
import type { NaturalPosition, PositionGroup, DeployedRole } from "./positions";
import { naturalDefaultRole, positionGroup } from "./positions";
import { gameConfig } from "../config";

export type SkillKey = keyof SkillSet;
export type WeightedSkills = Partial<Record<SkillKey, number>>;

export interface OverallGroupRow {
  scale: number;
  weights: Readonly<WeightedSkills>;
}

/**
 * Broad-group OVR rows (§6.1) and deployed-role tactical rows (§6.2) are owned
 * exclusively by `game.config.jsonc` under `playerPositions`. The schema makes
 * both required and validates key sets, skill keys and row sums, so there is no
 * in-code fallback table to drift out of sync with the config.
 */
function overallByGroup(): Record<PositionGroup, OverallGroupRow> {
  return gameConfig.playerPositions.overallByGroup as Record<PositionGroup, OverallGroupRow>;
}

function tacticalByRole(): Record<DeployedRole, Readonly<WeightedSkills>> {
  return gameConfig.playerPositions.tacticalRatingByRole as Record<DeployedRole, Readonly<WeightedSkills>>;
}

/** Broad-group OVR weights, read live from config. */
export function overallWeightsFor(group: PositionGroup): Readonly<WeightedSkills> {
  return overallByGroup()[group].weights;
}

/** Broad-group OVR scale, read live from config. */
export function overallScaleFor(group: PositionGroup): number {
  return overallByGroup()[group].scale;
}

/** Deployed-role tactical weights, read live from config. */
export function tacticalWeightsFor(role: DeployedRole): Readonly<WeightedSkills> {
  return tacticalByRole()[role];
}

/** All five broad groups with their OVR rows, for iteration in tests/tools. */
export function allOverallGroups(): Record<PositionGroup, OverallGroupRow> {
  return overallByGroup();
}

export const SKILL_KEYS: SkillKey[] = ["gol", "pace", "tec", "pas", "des", "playmaking", "fin"];

export function weightTotal(weights: WeightedSkills): number {
  return Object.values(weights).reduce((sum, weight) => sum + (weight ?? 0), 0);
}

/** OVR from persisted visible skills through the natural position's broad group (§6.1). */
export function overallFromSkills(position: NaturalPosition, skills: SkillSet): number {
  const { weights, scale } = overallByGroup()[positionGroup(position)];
  const weighted = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + skills[key as SkillKey] * (weight ?? 0),
    0,
  );
  return Math.max(1, Math.min(100, Math.round(weighted * scale)));
}

/**
 * Deployed-role tactical rating (§6.2). Each weighted term is rounded before
 * summing — this is the historical arithmetic and must not be changed to one
 * final rounded weighted mean.
 */
export function tacticalSkillRating(skills: SkillSet, role: DeployedRole): number {
  const weights = tacticalByRole()[role];
  if (!weights) return 0;
  return Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + Math.round(skills[key as SkillKey] * (weight ?? 0)),
    0,
  );
}

/**
 * Natural-position training profile (§6.3): the natural position maps to its
 * matching deployed-role tactical weights as the base distribution. Primary /
 * secondary add the configured focus bonus to the largest / second-largest
 * base weight; assistant adds it to the weakest currently-valued skill among
 * skills with a positive base weight. Normalize after the focus addition and
 * redistribute bounded skills exactly as before.
 */
export function trainingWeights(
  position: NaturalPosition,
  focus: "assistant" | "primary" | "secondary",
  skills?: SkillSet,
): Record<SkillKey, number> {
  const base = { ...tacticalByRole()[naturalDefaultRole(position)] } as Record<SkillKey, number>;
  const relevant = SKILL_KEYS.filter((key) => (base[key] ?? 0) > 0);
  let target: SkillKey | undefined;
  if (focus === "primary") target = relevant.sort((a, b) => base[b] - base[a])[0];
  if (focus === "secondary") target = relevant.sort((a, b) => base[b] - base[a])[1] ?? relevant[0];
  if (focus === "assistant") {
    target = relevant.sort(
      (a, b) => (skills ? skills[a] - skills[b] : base[a] - base[b]) || base[a] - base[b] || a.localeCompare(b),
    )[0];
  }
  if (target) base[target] = (base[target] ?? 0) + gameConfig.playerPositions.trainingFocusBonus;
  const total = weightTotal(base);
  return Object.fromEntries(SKILL_KEYS.map((key) => [key, (base[key] ?? 0) / total])) as Record<SkillKey, number>;
}
