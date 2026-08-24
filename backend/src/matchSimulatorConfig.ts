import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { gameConfig, stripJsoncComments } from "./config";

// ---------------------------------------------------------------------------
// Match simulator configuration (plans/6. match-simulator-overhaul.md §0).
//
// All match-simulator coefficients live under `matchSimulator` across two files:
//   - game.config.jsonc        -> matchSimulator.influence  (primary balance tunables)
//   - match-simulator.jsonc    -> every other group (MODEL COEFFICIENTS)
//
// This module loads and validates the separate file, merges it with the
// `influence` block from the game config, and exports the single typed
// `MATCH_SIMULATOR_CONFIG` consumed by the match engine.
// ---------------------------------------------------------------------------

const nonNegativeNumber = z.number().min(0);
const positiveNumber = z.number().positive();
/** A probability is a number in [0,1]. */
const prob = z.number().min(0).max(1);
/** Gamma distribution parameters; both shape and scale must be positive. */
const gammaParamsSchema = z.object({ shape: positiveNumber, scale: positiveNumber });

const phaseWindowSchema = z.object({
  setPieceMaxAgeSeconds: positiveNumber,
  transitionMaxAgeSeconds: positiveNumber,
  shotSetPieceMaxAgeSeconds: positiveNumber,
});

const stoppageSchema = z.object({
  firstHalfBaseSeconds: nonNegativeNumber,
  secondHalfBaseSeconds: nonNegativeNumber,
  secondsPerGoal: nonNegativeNumber,
  secondsPerSubstitution: nonNegativeNumber,
  secondsPerInjury: nonNegativeNumber,
  secondsPerCard: nonNegativeNumber,
  minMinutesPerHalf: z.number().int().min(0),
  maxMinutesPerHalf: z.number().int().min(0),
});

const timingSchema = z.object({
  tempoScale: positiveNumber,
  regulationSeconds: positiveNumber,
  firstHalfEndSeconds: positiveNumber,
  deadBallSecondsPerRestart: positiveNumber,
  instantActionSeconds: positiveNumber,
  stoppage: stoppageSchema.optional().default({
    firstHalfBaseSeconds: 30,
    secondHalfBaseSeconds: 75,
    secondsPerGoal: 45,
    secondsPerSubstitution: 30,
    secondsPerInjury: 40,
    secondsPerCard: 20,
    minMinutesPerHalf: 1,
    maxMinutesPerHalf: 12,
  }),
  durationGamma: z.object({
    ACTION: z.record(z.string(), gammaParamsSchema),
    ACTION_PHASE: z.record(z.string(), gammaParamsSchema),
    ACTION_PHASE_ZONE: z.record(z.string(), gammaParamsSchema),
  }),
});

const stateRowSchema = z.object({
  controlFailureProbability: prob,
  controlFailureTypeProbabilities: z.object({
    MISCONTROL: prob,
    DISPOSSESSED: prob,
  }),
  intentProbabilities: z.record(z.string(), prob),
});

const outcomeRowSchema = z.object({
  continue: prob,
  turnover: prob,
  foul: prob,
  retainedRestart: prob,
});

const nextZoneRowSchema = z.record(z.string(), prob);
const restartRowSchema = z.record(z.string(), prob);

const possessionStartRowSchema = z.object({
  startType: z.string(),
  startZone: z.string(),
  firstAction: z.string(),
  probability: prob,
});

const probabilityModelSchema = z.object({
  state: z.record(z.string(), stateRowSchema),
  outcomeByStateAction: z.record(z.string(), outcomeRowSchema),
  nextZoneByStateAction: z.record(z.string(), nextZoneRowSchema),
  restartTypeByZone: z.record(z.string(), restartRowSchema),
  possessionStartDistribution: z.array(possessionStartRowSchema),
  foulProbabilityCalibrationMultiplier: positiveNumber,
});

const shotModelSchema = z.object({
  xgLookup: z.object({
    EXACT: z.record(z.string(), prob),
    NO_PRESSURE: z.record(z.string(), prob),
    SITUATION: z.record(z.string(), prob),
    GEOMETRY: z.record(z.string(), prob),
    DISTANCE: z.record(z.string(), prob),
    GLOBAL: z.object({ GLOBAL: prob }),
  }),
  finisherVsGoalkeeperLogitCoefficient: z.number(),
  localDensityCoefficient: nonNegativeNumber,
  shooterRoleWeights: z.record(z.string(), z.number().min(0)),
  shotsOnTarget: z.object({
    baseRate: prob,
    finishingCoefficient: z.number(),
    pressurePenalty: z.number(),
    min: prob,
    max: prob,
  }),
  nonGoalOutcome: z.object({
    onTarget: z.object({ saveControlled: prob, saveRebound: prob, woodwork: prob }),
    notOnTarget: z.object({ blockUnderPressure: prob, blockNoPressure: prob, woodwork: prob }),
  }),
  setPieceReference: z.record(
    z.string(),
    z.object({
      shotPossessionRate: prob,
      shotsPerPossession: positiveNumber,
      goalsPerPossession: prob,
      meanXgPerShot: prob,
    })
  ),
  geometry: z.object({
    pitchLengthMeters: positiveNumber,
    pitchWidthMeters: positiveNumber,
    goalWidthMeters: positiveNumber,
    distanceBinsMeters: z.array(z.number()),
    angleBinsDegrees: z.array(z.number()),
  }),
  shooterMinimumWeight: z.number().min(0),
  shooterFinishingOffset: z.number(),
  shooterFinishingFloor: z.number().min(0),
});

const homeAdvantageSchema = z.object({
  targetXg: positiveNumber,
  creationShare: z.number().min(0).max(1),
  shotQualityShare: z.number().min(0).max(1),
});

const normalizationSchema = z.object({
  madToSigma: positiveNumber,
  minRobustSigma: positiveNumber,
  rawZClamp: positiveNumber,
  contestZClamp: positiveNumber,
  minTacticalSigma: positiveNumber,
});

const actionQualitySchema = z.object({
  localDensityCoefficient: nonNegativeNumber,
  attributeWeights: z.record(z.string(), z.record(z.string(), nonNegativeNumber)),
  defensiveResistanceWeights: z.record(z.string(), z.record(z.string(), nonNegativeNumber)),
});

const numericalDisadvantageSchema = z.object({
  referencePlayers: z.number().int().positive(),
  remainingPlayerWorkloadExponent: nonNegativeNumber,
  maxRemainingPlayerWorkloadMultiplier: z.number().min(1),
});

const formationSupportSchema = z.record(z.string(), z.record(z.string(), nonNegativeNumber));

const tacticalFamiliaritySchema = z.object({
  seasonTargetExponent: positiveNumber,
  dailyUnusedDecay: nonNegativeNumber,
  switchTransferCoefficient: nonNegativeNumber,
  executionFloor: z.number().min(0).max(1),
  executionCeiling: z.number().min(0).max(1),
  // Starting point for a setup that has never been drilled; switching into a
  // previously-drilled setup uses max(floor, its decayed stored value).
  switchStartFloor: z.number().min(0).max(100),
  // Relative contribution of each tactic dimension to switch similarity.
  switchSimilarityWeights: z.object({
    formation: nonNegativeNumber,
    style: nonNegativeNumber,
    pressing: nonNegativeNumber,
    direction: nonNegativeNumber,
  }),
});

const tacticalActionMixSchema = z.object({
  /** Scales explicit action-mix corrections outside the neutral CONTROL/CONTROL matchup. */
  nonNeutralCorrectionScale: z.number().min(0).max(1),
  /** Direct logit shifts; the configured default scale is zero to preserve the baseline. */
  asymmetricActionUtility: z.record(z.string(), z.number()),
});

const pressingSchema = z.object({ intensityDivisor: positiveNumber });

const defensiveOrganisationSchema = z.object({
  baselineIntercept: z.number(),
  formationCoverageWeight: nonNegativeNumber,
  readinessWeight: nonNegativeNumber,
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
  disruptionAdvancedRecoveryWeight: nonNegativeNumber,
  disruptionCommitmentWeight: nonNegativeNumber,
  disruptionPressExposureWeight: nonNegativeNumber,
  playersCommittedForwardNormalizer: positiveNumber,
  recoveryPaceWeight: nonNegativeNumber,
  recoveryReadinessWeight: nonNegativeNumber,
  minRecoveryQuality: z.number().min(0).max(1),
  recoveryBaseSeconds: positiveNumber,
});

const counterattackSchema = z.object({
  familiarityFloorWeight: nonNegativeNumber,
  familiarityExecutionWeight: nonNegativeNumber,
  activationLogisticSlope: positiveNumber,
  activationThreshold: z.number(),
  endOrganisationFraction: z.number().min(0).max(1),
});

const foulsSchema = z.object({
  disciplineRiskLogitCoefficient: z.number(),
  pressIntensityLogitCoefficient: z.number(),
  fatigueLogitCoefficient: z.number(),
  lowOrganisationLogitCoefficient: z.number(),
});

const cardsSchema = z.object({
  yellowTargetPerMatch: positiveNumber,
  redTargetPerMatch: positiveNumber,
  secondYellowLogitPenalty: z.number().min(0),
  disciplineRiskLogitCoefficient: z.number(),
  fatigueLogitCoefficient: z.number(),
  pressIntensityLogitCoefficient: z.number(),
  highThreatLogitCoefficient: z.number(),
});

const substitutionAiSchema = z.object({
  needWeights: z.object({
    fatigue: nonNegativeNumber,
    zoneDeficit: nonNegativeNumber,
    scoreUrgency: nonNegativeNumber,
    cardOrInjuryRisk: nonNegativeNumber,
  }),
  replacementWeights: z.object({
    effectiveSkill: nonNegativeNumber,
    energy: nonNegativeNumber,
    fit: nonNegativeNumber,
  }),
  /** AI substitution gating (plan 6 §40). Evaluated once per match minute. */
  earliestMatchMinute: nonNegativeNumber,
  latestMatchMinute: positiveNumber,
  /** Hard cap for AI tactical subs; also bounded by liveMatch.maxSubsPerSide. */
  maxPerSide: z.number().int().min(0),
  /** A player must have spent this many match-minutes on the pitch to be subbed off. */
  minOnPitchMinutes: nonNegativeNumber,
  /** Energy below this counts as fatigued; normalizes the fatigue term. */
  fatigueNeedEnergyThreshold: z.number().min(0).max(100),
  /** Minimum blended substitution-need score before the AI makes a change. */
  minNeedToSub: nonNegativeNumber,
});

/** Pre-match AI tactic selection from the club's own squad profile (no opponent scouting). */
const aiPregameTacticsSchema = z.object({
  /** Top contributors (by overall) whose attributes define the squad profile. */
  profileSize: z.number().int().min(1),
  controlTechnicalWeight: nonNegativeNumber,
  controlPassingWeight: nonNegativeNumber,
  pressDefendingWeight: nonNegativeNumber,
  pressPhysicalWeight: nonNegativeNumber,
  counterPaceWeight: nonNegativeNumber,
  counterFinishingWeight: nonNegativeNumber,
  pressingVeryHeavyPhysicalMin: z.number().min(0).max(100),
  pressingHeavyPhysicalMin: z.number().min(0).max(100),
  /** Very Heavy pressing additionally requires this mean squad energy. */
  pressingEnergyReserveMin: z.number().min(0).max(100),
  /** Wide slots must beat central slots by this many tactical-rating points to play down the wings. */
  wideDirectionAdvantageMin: nonNegativeNumber,
});

const aiTacticsSchema = z.object({
  evaluationIntervalSeconds: positiveNumber,
  evaluationHorizonSeconds: positiveNumber,
  urgencyMidpointSeconds: z.number(),
  urgencyScaleSeconds: positiveNumber,
  maxAttackUrgencyWeight: nonNegativeNumber,
  maxLeadProtectionWeight: nonNegativeNumber,
  fatiguePenaltyWeight: nonNegativeNumber,
  nearTieFraction: nonNegativeNumber,
});

const epvSchema = z.object({
  convergenceTolerance: positiveNumber,
  maxIterations: z.number().int().positive(),
});

const commentarySchema = z.object({
  alwaysShowShotXgAtLeast: prob,
  deltaVPercentileThreshold: z.number().min(0).max(1),
  sustainedPressureMinAdvancedStates: z.number().int().min(1),
  sustainedPressureWindowSeconds: positiveNumber,
  opponentControlBreakSeconds: positiveNumber,
});

const referenceDistributionSchema = z.object({
  mean: z.number(),
  std: positiveNumber,
  p05: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p95: z.number(),
});

const meanToleranceSchema = z.record(z.string(), positiveNumber);

const validationSchema = z.object({
  reference: z.record(z.string(), referenceDistributionSchema),
  meanTolerance: meanToleranceSchema,
  neutralStateTotalVariationMax: positiveNumber,
  influenceAcceptance: z.object({
    teamMin: z.number(),
    teamMax: z.number(),
    tacticsMin: z.number(),
    tacticsMax: z.number(),
    luckMin: z.number(),
    luckMax: z.number(),
  }),
});

const matchSimulatorSchema = z
  .object({
    probabilityModel: probabilityModelSchema,
    phaseWindows: phaseWindowSchema,
    timing: timingSchema,
    shotModel: shotModelSchema,
    homeAdvantage: homeAdvantageSchema,
    normalization: normalizationSchema,
    actionQuality: actionQualitySchema,
    numericalDisadvantage: numericalDisadvantageSchema,
    formationSupport: formationSupportSchema,
    tacticalFamiliarity: tacticalFamiliaritySchema,
    tacticalActionMix: tacticalActionMixSchema,
    pressing: pressingSchema,
    defensiveOrganisation: defensiveOrganisationSchema,
    counterattack: counterattackSchema,
    fouls: foulsSchema,
    cards: cardsSchema,
    substitutionAi: substitutionAiSchema,
    aiTactics: aiTacticsSchema,
    aiPregameTactics: aiPregameTacticsSchema,
    epv: epvSchema,
    commentary: commentarySchema,
    validation: validationSchema,
  })
  .superRefine((cfg, ctx) => {
    const problems: string[] = [];

    // Every probability vector in the empirical model must sum to 1 ± 1e-6.
    for (const [stateKey, row] of Object.entries(cfg.probabilityModel.state)) {
      const intentSum = Object.values(row.intentProbabilities).reduce((s, v) => s + v, 0);
      if (Math.abs(intentSum - 1) > 1e-6) {
        problems.push(`probabilityModel.state.${stateKey}.intentProbabilities sums to ${intentSum}`);
      }
      const failureSum = Object.values(row.controlFailureTypeProbabilities).reduce((s, v) => s + v, 0);
      if (Math.abs(failureSum - 1) > 1e-6) {
        problems.push(`probabilityModel.state.${stateKey}.controlFailureTypeProbabilities sums to ${failureSum}`);
      }
    }
    for (const [key, row] of Object.entries(cfg.probabilityModel.outcomeByStateAction)) {
      const sum = row.continue + row.turnover + row.foul + row.retainedRestart;
      if (Math.abs(sum - 1) > 1e-6) problems.push(`probabilityModel.outcomeByStateAction.${key} sums to ${sum}`);
    }
    for (const [key, row] of Object.entries(cfg.probabilityModel.nextZoneByStateAction)) {
      const sum = Object.values(row).reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1) > 1e-6) problems.push(`probabilityModel.nextZoneByStateAction.${key} sums to ${sum}`);
    }
    for (const [zone, row] of Object.entries(cfg.probabilityModel.restartTypeByZone)) {
      const sum = Object.values(row).reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1) > 1e-6) problems.push(`probabilityModel.restartTypeByZone.${zone} sums to ${sum}`);
    }
    const psdSum = cfg.probabilityModel.possessionStartDistribution.reduce((s, r) => s + r.probability, 0);
    if (Math.abs(psdSum - 1) > 1e-6) problems.push(`probabilityModel.possessionStartDistribution sums to ${psdSum}`);

    // Non-goal shot outcome shares sum to 1 within each bucket.
    const onTargetSum =
      cfg.shotModel.nonGoalOutcome.onTarget.saveControlled +
      cfg.shotModel.nonGoalOutcome.onTarget.saveRebound +
      cfg.shotModel.nonGoalOutcome.onTarget.woodwork;
    if (Math.abs(onTargetSum - 1) > 1e-6) problems.push(`shotModel.nonGoalOutcome.onTarget sums to ${onTargetSum}`);
    // blockUnderPressure/woodwork are configured shares of the off-target
    // remainder; each is validated as a probability by the field schema.

    // Action-quality weight vectors must sum to 1 for every action.
    for (const [action, weights] of Object.entries(cfg.actionQuality.attributeWeights)) {
      const sum = Object.values(weights).reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1) > 1e-6) problems.push(`actionQuality.attributeWeights.${action} sums to ${sum}`);
    }
    for (const [action, weights] of Object.entries(cfg.actionQuality.defensiveResistanceWeights)) {
      const sum = Object.values(weights).reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1) > 1e-6) problems.push(`actionQuality.defensiveResistanceWeights.${action} sums to ${sum}`);
    }

    if (problems.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `match-simulator.jsonc validation: ${problems.join("; ")}` });
    }
  });

export type MatchSimulatorConfig = z.infer<typeof matchSimulatorSchema>;

function loadMatchSimulatorConfig(): MatchSimulatorConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "config", "match-simulator.jsonc");
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsoncComments(readFileSync(file, "utf8")));
  } catch (err) {
    throw new Error(`Unable to read/parse config/match-simulator.jsonc: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The file wraps the groups under `matchSimulator` (the same key the game
  // config uses for `influence`); unwrap so the schema matches the engine shape.
  const unwrapped = (raw as Record<string, unknown> | null)?.matchSimulator ?? raw;
  const parsed = matchSimulatorSchema.safeParse(unwrapped);
  if (!parsed.success) {
    throw new Error(`Invalid match-simulator.jsonc: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * The single typed match-simulator configuration. `influence` (the primary
 * balance tunables) comes from the game config; every other group comes from
 * match-simulator.jsonc. Rejected at startup on any schema or probability-vector
 * violation.
 */
export const MATCH_SIMULATOR_CONFIG: MatchSimulatorConfig = loadMatchSimulatorConfig();

/** Normalized latent-decision weights (plan §6): teamScale/tacticsScale/luckScale. */
export const INFLUENCE_SCALES = (() => {
  const influence = gameConfig.matchSimulator?.influence ?? { team: 0.4, tactics: 0.35, luck: 0.25 };
  const sum = influence.team + influence.tactics + influence.luck;
  const wTeam = influence.team / sum;
  const wTactics = influence.tactics / sum;
  const wLuck = influence.luck / sum;
  return {
    teamScale: Math.sqrt(wTeam),
    tacticsScale: Math.sqrt(wTactics),
    luckScale: Math.sqrt(3 * wLuck) / Math.PI,
  };
})();
