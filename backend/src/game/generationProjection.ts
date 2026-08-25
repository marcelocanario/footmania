import type { Position } from "./types";
import { createRng } from "./rng";
import {
  drawRawZ,
  divisionMean,
  seniorPeakMean,
  qualitySigma,
  seniorRosterTemplate,
  OVR_MAX,
  OVR_MIN,
} from "./playerGeneration";
import {
  drawStandingSeniorAge,
  generateCareerProfile,
  generationActivityModifiers,
  reconstructCurrentTarget,
} from "./careerCurves";
import { gameConfig } from "../config";

/**
 * Canonical projection of the quality the generator actually produces.
 *
 * The economy needs to know what a healthy top-division squad looks like in OVR
 * terms. Reading that from a hard-coded constant meant every generation retune
 * silently invalidated the budget curve. Everything here is derived from the
 * live generation configuration instead, using the same peak anchors, career
 * profile draws, age survivorship, and best-XI shape the real world uses.
 *
 * Skill generation is deliberately skipped: it targets the OVR computed here and
 * lands within one point of it, so the projection converges on the same
 * distribution far more cheaply.
 */

/** Best-XI shape: one GK, two full-backs, two centre-backs, four midfielders, two forwards. */
const STARTING_XI_SHAPE: readonly number[] = [1, 2, 2, 4, 2];

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

function clampOverall(value: number): number {
  return Math.max(OVR_MIN, Math.min(OVR_MAX, Math.round(value)));
}

/** One generated senior's current OVR target, without generating his skills. */
function sampleSeniorOverall(rng: ReturnType<typeof createRng>, position: Position, division: number, totalDivisions: number): number {
  const rawZ = drawRawZ(rng);
  const age = drawStandingSeniorAge(rng, position);
  const profile = generateCareerProfile(rng);
  const activity = generationActivityModifiers();
  const peakTarget = seniorPeakMean(division, totalDivisions) + qualitySigma() * rawZ;
  return clampOverall(reconstructCurrentTarget(profile, peakTarget, age, activity.growth, activity.decline).current);
}

function selectStartingXi(squad: { position: Position; overall: number }[]): number[] {
  const selected: number[] = [];
  for (let position = 0; position < STARTING_XI_SHAPE.length; position++) {
    const pool = squad
      .filter((player) => player.position === position)
      .sort((a, b) => b.overall - a.overall)
      .slice(0, STARTING_XI_SHAPE[position]);
    for (const player of pool) selected.push(player.overall);
  }
  return selected.sort((a, b) => a - b);
}

const cache = new Map<string, DivisionQualityProjection>();

/**
 * Project the generated quality of a division. Deterministic for a given
 * configuration: the sampling seed is fixed, so two callers in the same process
 * (and two runs of the same build) always agree.
 */
export function projectDivisionQuality(
  division: number,
  totalDivisions: number,
  squadSize = gameConfig.playerGenerationRules.initialSeniorSquadSize,
): DivisionQualityProjection {
  const key = `${division}|${totalDivisions}|${squadSize}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const rng = createRng(PROJECTION_SEED);
  const template = seniorRosterTemplate(squadSize);
  const allOverall: number[] = [];
  const xiMeans: number[] = [];
  const weakest: number[] = [];
  const strongest: number[] = [];

  for (let sample = 0; sample < PROJECTION_SAMPLES; sample++) {
    const squad = template.map((position) => ({ position, overall: sampleSeniorOverall(rng, position, division, totalDivisions) }));
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

/** Configured all-age mean of the top division, straight from the curve. */
export function configuredTopDivisionMean(): number {
  return divisionMean(1, 1);
}

/** Drop cached projections. Only needed by tests that mutate the configuration. */
export function resetProjectionCache(): void {
  cache.clear();
}
