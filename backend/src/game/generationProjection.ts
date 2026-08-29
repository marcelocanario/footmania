import type { Position } from "./types";
import {
  drawSeniorGenerationBlueprint,
  conditionInitialSeniorBlueprints,
  divisionMean,
  seniorRosterTemplate,
  type GeneratePlayerContext,
} from "./playerGeneration";
import { gameConfig } from "../config";
import { tierBudget } from "./budget";

/**
 * Canonical projection of the quality the generator actually produces.
 *
 * The economy needs to know what a healthy top-division squad looks like in OVR
 * terms. Reading that from a hard-coded constant meant every generation retune
 * silently invalidated the budget curve. Everything here is derived from the
 * live generation configuration instead, using the same peak anchors, career
 * profile draws, age survivorship, best-XI shape, and — crucially — the same
 * squad-level quality pairing the real initial-roster path uses.
 *
 * Each projection sample constructs a complete set of initial-senior contexts
 * and runs them through the production batch/blueprint-pairing logic. Skill
 * generation is deliberately skipped: it targets the OVR computed here and
 * lands within one point of it, so the projection converges on the same
 * distribution far more cheaply. Blueprint draws, pairing and bounded-mean
 * conditioning are identical to production.
 */

/** Best-XI shape: the fixed 4-3-3 natural-position shape (§13.5): 1 GK, 1 LB,
 *  1 RB, 2 CB, 1 DM, 2 AM, 1 LW, 1 RW, 1 ST. */
const STARTING_XI_SHAPE: readonly import("./positions").NaturalPosition[] = ["GK", "LB", "RB", "CB", "CB", "DM", "AM", "AM", "LW", "RW", "ST"];

const PROJECTION_SAMPLES = 400;
const PROJECTION_SEED = 0x5eed_1234;

export interface DivisionQualityProjection {
  /** Mean OVR of the whole generated senior squad, across all ages. */
  fullSquadMean: number;
  /** Mean OVR of the automatic best XI. */
  startingXiMean: number;
  /** Mean OVR of the weakest and strongest automatic starters. */
  weakestStarterMean: number;
  strongestStarterMean: number;
  /** Selected OVR percentiles of the full generated senior population. */
  percentile: (p: number) => number;
}

/**
 * One assembled initial senior squad's OVR targets, without generating skills.
 * Uses the exact production pairing: draw every blueprint, counter-pair the
 * quality tickets with the career bundles at the initial-senior activity, then
 * reconstruct each player's current target from the assigned raw Z with the
 * same peak anchor, rounding and global OVR clamp as `buildSeniorPlayerFromBlueprint`.
 *
 * Each sample uses the fixed projection world seed and a distinct club id, just
 * like production: every slot in one squad shares the same world seed while
 * `playerRng` separates players by club and slot.
 */
function sampleSquadOveralls(
  division: number,
  totalDivisions: number,
  squadSize: number,
  sample: number,
): number[] {
  const template = seniorRosterTemplate(squadSize);
  const contexts: GeneratePlayerContext[] = template.map((position, slot) => ({
    id: slot + 1,
    clubId: sample + 1,
    country: "BRA",
    position,
    isYouth: false,
    currentDivision: division,
    highestDivisionReached: division,
    totalDivisions,
    seasonId: 1,
    generationType: "initial-senior",
    seed: PROJECTION_SEED,
    slot,
  }));
  const blueprints = contexts.map(drawSeniorGenerationBlueprint);
  return conditionInitialSeniorBlueprints(blueprints).map(({ targetCurrentOverall }) => Math.round(targetCurrentOverall));
}

function selectStartingXi(squad: { position: Position; overall: number }[]): number[] {
  const selected: number[] = [];
  const counts = new Map<string, number>();
  for (const position of STARTING_XI_SHAPE) {
    const used = counts.get(position) ?? 0;
    const pool = squad
      .filter((player) => player.position === position)
      .sort((a, b) => b.overall - a.overall)
      .slice(0, used + 1);
    const player = pool[used];
    if (player) selected.push(player.overall);
    counts.set(position, used + 1);
  }
  return selected.sort((a, b) => a - b);
}

const cache = new Map<string, DivisionQualityProjection>();

/**
 * Project the generated quality of a division. Deterministic for a given
 * configuration: every sample uses the fixed projection world seed and a
 * distinct club id, so two callers in the same process (and two runs of the
 * same build) always agree while each sample draws a distinct assembled squad.
 */
export function projectDivisionQuality(
  division: number,
  totalDivisions: number,
  squadSize = gameConfig.playerGenerationRules.initialSeniorSquadSize,
): DivisionQualityProjection {
  const key = `${division}|${totalDivisions}|${squadSize}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const template = seniorRosterTemplate(squadSize);
  const allOverall: number[] = [];
  const xiMeans: number[] = [];
  const weakest: number[] = [];
  const strongest: number[] = [];

  for (let sample = 0; sample < PROJECTION_SAMPLES; sample++) {
    const squadOveralls = sampleSquadOveralls(division, totalDivisions, squadSize, sample);
    const squad = template.map((position, slot) => ({ position, overall: squadOveralls[slot] }));
    for (const player of squad) allOverall.push(player.overall);
    const xi = selectStartingXi(squad);
    if (xi.length === 0) continue;
    xiMeans.push(xi.reduce((sum, value) => sum + value, 0) / xi.length);
    weakest.push(xi[0]);
    strongest.push(xi[xi.length - 1]);
  }

  allOverall.sort((a, b) => a - b);
  const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  const projection: DivisionQualityProjection = {
    fullSquadMean: mean(allOverall),
    startingXiMean: mean(xiMeans),
    weakestStarterMean: mean(weakest),
    strongestStarterMean: mean(strongest),
    percentile: (p: number) => {
      if (allOverall.length === 0) return 0;
      const index = Math.min(allOverall.length - 1, Math.max(0, Math.round((allOverall.length - 1) * Math.max(0, Math.min(1, p)))));
      return allOverall[index];
    },
  };
  cache.set(key, projection);
  return projection;
}

/** Representative percentiles of the generated top-division population. */
const MEANINGFUL_SIGNING_PERCENTILE = 0.9;
const ELITE_PLAYER_PERCENTILE = 0.99;

/**
 * Quality assumptions the economy is built on, all DERIVED from the live
 * generation configuration rather than hard-coded. Retuning generation now moves
 * the quality reference points with it instead of silently invalidating them.
 */
export function expectedFirstDivisionQuality(): {
  fullSquadOverall: number;
  startingXiOverall: number;
  meaningfulSigningOverall: number;
  eliteOverall: number;
} {
  const projection = projectDivisionQuality(1, 1);
  return {
    fullSquadOverall: projection.fullSquadMean,
    startingXiOverall: projection.startingXiMean,
    // A "meaningful signing" is a player who would walk into the XI: the upper
    // slice of the generated top-division population, not an arbitrary number.
    meaningfulSigningOverall: projection.percentile(MEANINGFUL_SIGNING_PERCENTILE),
    eliteOverall: projection.percentile(ELITE_PLAYER_PERCENTILE),
  };
}

/** Configured all-age mean of the top division, straight from the curve. */
export function configuredTopDivisionMean(): number {
  return divisionMean(1, 1);
}

/**
 * Initial seniors + academy player-value acceptance target. Division 1 is the
 * configured anchor; every lower division reuses the authoritative season-
 * budget decay ratio instead of defining a second economy curve.
 */
export function initialClubPlayerValueTarget(division: number): number {
  const topDivisionTarget = gameConfig.playerGeneration.initialClubPlayerValueTargetTopDivision;
  return Math.round(topDivisionTarget * tierBudget(division) / tierBudget(1));
}

/** Drop cached projections. Only needed by tests that mutate the configuration. */
export function resetProjectionCache(): void {
  cache.clear();
}
