/**
 * The single authority for out-of-position deployment (plan §7).
 *
 * INVARIANT 42: the compatibility penalty is applied EXACTLY ONCE, as a raw
 * skill subtraction, and is monotonic — it can never improve a player. There is
 * no fit multiplier, no readiness change and no OVR effect.
 *
 * Everything that needs a penalty, a suitability label, adjusted skills or an
 * adjusted tactical rating must come through this module. Do not re-derive any
 * of it from `MATCH_SIMULATOR_CONFIG` at a call site: the previous duplicated
 * copies silently disagreed about what a `null` (ineligible) pairing means.
 */
import type { SkillSet } from "./types";
import type { DeployedRole, NaturalPosition } from "./positions";
import { DEPLOYED_ROLES, NATURAL_POSITIONS } from "./positions";
import { tacticalSkillRating } from "./rating";
import { MATCH_SIMULATOR_CONFIG } from "../matchSimulatorConfig";

export type SuitabilityLabel = "Natural" | "Comfortable" | "Makeshift" | "Poor" | "Emergency" | "Ineligible";

/** Structural-ineligibility label; never a numeric band (§7.3). */
export const INELIGIBLE: SuitabilityLabel = "Ineligible";

function matrix(): Record<string, Record<string, number | null>> {
  // `outOfPosition` is a required, fully validated config section
  // (matchSimulatorConfig.ts). No fallback: a missing matrix used to silently
  // return 0 for every pairing, which disabled GK exclusivity outright.
  return MATCH_SIMULATOR_CONFIG.outOfPosition.skillPenaltyByNaturalAndRole;
}

/**
 * Raw skill points subtracted from every skill the player consumes while
 * occupying `role`. `null` means structurally ineligible (§7.1/§7.2).
 * Throws on an unknown natural position or deployed role rather than guessing.
 */
export function rolePenalty(natural: NaturalPosition, role: DeployedRole): number | null {
  const row = matrix()[natural];
  if (!row) throw new Error(`Unknown natural position ${natural}`);
  const value = row[role];
  if (value === undefined) throw new Error(`Unknown deployed role ${role}`);
  return value;
}

/** True when the pairing is structurally allowed (non-null penalty). */
export function isEligible(natural: NaturalPosition, role: DeployedRole): boolean {
  return rolePenalty(natural, role) !== null;
}

/**
 * Public suitability label from the configured ordered bands (§7.3). The bands
 * are validated to cover every non-null matrix value, so the loop always hits.
 */
export function suitabilityLabel(penalty: number | null): SuitabilityLabel {
  if (penalty === null) return INELIGIBLE;
  for (const band of MATCH_SIMULATOR_CONFIG.outOfPosition.suitabilityBands) {
    if (penalty <= band.maxPenalty) return band.label as SuitabilityLabel;
  }
  throw new Error(`Penalty ${penalty} is outside the configured suitability bands`);
}

/** Suitability label for a natural/deployed pairing. */
export function suitabilityFor(natural: NaturalPosition, role: DeployedRole): SuitabilityLabel {
  return suitabilityLabel(rolePenalty(natural, role));
}

/**
 * Effective raw skills after the role penalty: `clamp(raw - penalty, 1, 100)`
 * for every skill (§7.1). Returns `null` for a structurally ineligible pairing
 * — callers decide what an impossible deployment means for them; this module
 * refuses to invent a number.
 */
export function adjustedSkills(skills: SkillSet, natural: NaturalPosition, role: DeployedRole): SkillSet | null {
  const penalty = rolePenalty(natural, role);
  if (penalty === null) return null;
  if (penalty === 0) return { ...skills };
  // Written out field by field: this runs for every (player, role) pair the
  // lineup DP scores and for every engine rebuild, and the `Object.keys` walk
  // it replaces allocated a key array on each of those calls.
  const clampSkill = (value: number): number => Math.max(1, Math.min(100, value - penalty));
  return {
    gol: clampSkill(skills.gol),
    pace: clampSkill(skills.pace),
    tec: clampSkill(skills.tec),
    pas: clampSkill(skills.pas),
    des: clampSkill(skills.des),
    playmaking: clampSkill(skills.playmaking),
    fin: clampSkill(skills.fin),
  };
}

/** Every skill floored to 1: the engine's clamp for corrupt/impossible state. */
export const FLOORED_SKILLS: Readonly<SkillSet> = Object.freeze({
  gol: 1, pace: 1, tec: 1, pas: 1, des: 1, playmaking: 1, fin: 1,
});

/**
 * Engine-side variant of {@link adjustedSkills}: an ineligible pairing yields
 * skills floored to 1 instead of `null`, so a corrupt live slot map degrades
 * loudly in the simulation rather than playing at full strength. Only the match
 * engine and rating mirror may use this; selection code must use
 * {@link adjustedSkills} and respect `null`.
 */
export function effectiveSkillsOrFloor(skills: SkillSet, natural: NaturalPosition, role: DeployedRole): SkillSet {
  return adjustedSkills(skills, natural, role) ?? { ...FLOORED_SKILLS };
}

/**
 * Adjusted deployed-role tactical rating (§7.1): monotonic, never above the
 * unpenalized rating. Computed by re-running `tacticalSkillRating` on the
 * adjusted skill set — NOT as `rawRating - penalty`, because per-term rounding
 * and the raw-skill floor make that shortcut inexact.
 */
export function adjustedTacticalRating(skills: SkillSet, natural: NaturalPosition, role: DeployedRole): number | null {
  const adjusted = adjustedSkills(skills, natural, role);
  if (adjusted === null) return null;
  return tacticalSkillRating(adjusted, role);
}

/** Upper penalty bound of a named band, e.g. `Makeshift` for §17 benchmarks. */
export function bandUpperBound(label: SuitabilityLabel): number {
  const band = MATCH_SIMULATOR_CONFIG.outOfPosition.suitabilityBands.find((b) => b.label === label);
  if (!band) throw new Error(`No configured suitability band labelled ${label}`);
  return band.maxPenalty;
}

/** Every deployed role a natural position may legally occupy, in catalog order. */
export function eligibleRolesFor(natural: NaturalPosition): DeployedRole[] {
  return DEPLOYED_ROLES.filter((role) => isEligible(natural, role));
}

/** Every natural position eligible for a deployed role, in display order. */
export function eligibleNaturalsFor(role: DeployedRole): NaturalPosition[] {
  return NATURAL_POSITIONS.filter((natural) => isEligible(natural, role));
}
