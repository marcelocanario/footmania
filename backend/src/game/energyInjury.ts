import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Player, Position, RngState, SkillSet } from "./types";
import { beta, nextDouble, normal } from "./rng";
import { overallFromSkills } from "./rating";
import { calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "./economy";
import { gameConfig } from "../config";
import { calendarValues } from "../services/seasonCalendar";
import { bumpSkillsVersion } from "./skillsVersion";

const modelSchema = z.object({
  schemaVersion: z.literal(2),
  energy: z.object({
    referenceFullMatchLoss: z.number(), roleLoad: z.record(z.string(), z.number()), pressLogRange: z.number(), physicalFatigueLogRange: z.number(),
    ageFatigueStartAge: z.number(), ageFatigueCoefficient: z.number(), ageFatigueExponent: z.number(), lowEnergyAccelerationCoefficient: z.number(), lowEnergyAccelerationExponent: z.number(),
    involvementBase: z.number(), involvementRange: z.number(), readinessMaxPenalty: z.number(), readinessExponent: z.number(), workloadHalfLifeMatchSpacingMultiplier: z.number(), workloadPersistenceMax: z.number(),
    dailyRecoveryBase: z.number(), dailyRecoveryDeficitCoefficient: z.number(), physicalRecoveryLogRange: z.number(), ageRecoveryStartAge: z.number(), ageRecoveryCoefficient: z.number(), ageRecoveryExponent: z.number(), workloadRecoveryCoefficient: z.number(), workloadRecoveryExponent: z.number(),
  }),
  injuryRisk: z.object({
    acuteRiskAtEnergy50: z.number(), acuteRiskExponent: z.number(), acuteRiskScoreCap: z.number(), recentLoadRiskAtOneUnit: z.number(), recentLoadRiskInputCap: z.number(), ageReference: z.number(), ageObservedReferenceYoung: z.number(), ageObservedPeak: z.number(), ageObservedHazardRatio: z.number(), ageResidualShare: z.number(), ageRiskMin: z.number(), ageRiskMax: z.number(), referenceEnergy: z.number(), referenceRecentLoad: z.number(), actionRiskRaw: z.record(z.string(), z.number()),
  }),
  trainingInjuries: z.object({ referenceRecentLoad: z.number(), includeAcademyPlayers: z.boolean() }),
  severity: z.object({ minorProbability: z.number(), moderateProbability: z.number(), severeProbability: z.number(), minorMinRealDays: z.number(), minorMaxRealDays: z.number(), minorBetaAlpha: z.number(), minorBetaBeta: z.number(), moderateMinRealDays: z.number(), moderateMaxRealDays: z.number(), moderateBetaAlpha: z.number(), moderateBetaBeta: z.number(), severeMedianRealDays: z.number(), severeLogSigma: z.number(), severeMinRealDays: z.number(), severeMaxRealDays: z.number(), ageSeverityReference: z.number(), ageSeverityLogPerYear: z.number(), ageSeverityMin: z.number(), ageSeverityMax: z.number(), referenceProMatchesPerSeason: z.number(), referenceProMatchSpacingDays: z.number() }),
  returnToFitness: z.object({ freshReturnEnergy: z.number(), maxReturnEnergyPenalty: z.number(), severityScaleMatchIntervals: z.number() }),
  lastingSetback: z.object({ minimumEquivalentRealDays: z.number(), probabilityMaximum: z.number(), probabilityScaleDays: z.number(), probabilityExponent: z.number(), magnitudeBase: z.number(), magnitudeScale: z.number(), magnitudeBetaAlpha: z.number(), magnitudeBetaBeta: z.number(), magnitudeSeverityScaleDays: z.number(), outfieldWeights: z.record(z.string(), z.number()), goalkeeperWeights: z.record(z.string(), z.number()), careerGrowthLossShare: z.number() }),
});

function loadModel(): z.infer<typeof modelSchema> {
  const fileName = "energy-injury-model.json";
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // Primary location sits next to this module (src/ under tsx/vitest, the
  // build-copied dist/src/game/data after `npm run build`). The cwd fallback
  // covers exotic runs where only the repository checkout is reachable.
  const candidates = [join(moduleDir, "data", fileName), join(process.cwd(), "src", "game", "data", fileName)];
  const file = candidates.find((candidate) => readFileSyncExists(candidate));
  if (!file) throw new Error(`energy-injury model data not found; tried: ${candidates.join(", ")}`);
  const parsed = modelSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid energy-injury-model.json: ${parsed.error.message}`);
  return parsed.data;
}

function readFileSyncExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

export const ENERGY_INJURY_MODEL = loadModel();

export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

export function athleticism(skills: Pick<SkillSet, "pace" | "des">): number {
  // §5.2: single helper, weights are the only configurable athleticism
  // authority (game.config.jsonc playerPositions.athleticismWeights).
  const w = (gameConfig as unknown as { playerPositions?: { athleticismWeights?: { pace?: number; des?: number } } })?.playerPositions?.athleticismWeights;
  const paceW = Number.isFinite(w?.pace) ? (w!.pace as number) : 0.5;
  const desW = Number.isFinite(w?.des) ? (w!.des as number) : 0.5;
  return clamp(skills.pace * paceW + skills.des * desW, 0, 100);
}

export function physicalSkill(player: Pick<Player, "skills">): number {
  return athleticism(player.skills);
}

export function roleForPosition(position: string): "GK" | "DEF" | "MID" | "ATT" {
  if (position === "GK") return "GK";
  if (position === "LB" || position === "RB" || position === "CB" || position === "SW") return "DEF";
  if (position === "DM" || position === "AM" || position === "LM" || position === "RM") return "MID";
  return "ATT";
}

export function pressingFactor(pressing: number): number {
  return Math.exp(ENERGY_INJURY_MODEL.energy.pressLogRange * (clamp(pressing, 0, 100) - 50) / 50);
}

export function physicalFatigueFactor(skill: number): number {
  return Math.exp(-ENERGY_INJURY_MODEL.energy.physicalFatigueLogRange * (clamp(skill, 0, 100) - 50) / 50);
}

export function ageFatigueFactor(age: number): number {
  const years = Math.max(0, age - ENERGY_INJURY_MODEL.energy.ageFatigueStartAge);
  return Math.exp(ENERGY_INJURY_MODEL.energy.ageFatigueCoefficient * Math.pow(years, ENERGY_INJURY_MODEL.energy.ageFatigueExponent));
}

export function lowEnergyFactor(energy: number): number {
  return 1 + ENERGY_INJURY_MODEL.energy.lowEnergyAccelerationCoefficient * Math.pow(1 - clamp(energy, 0, 100) / 100, ENERGY_INJURY_MODEL.energy.lowEnergyAccelerationExponent);
}

export function involvementFactor(weight: number): number {
  return ENERGY_INJURY_MODEL.energy.involvementBase + ENERGY_INJURY_MODEL.energy.involvementRange * clamp(weight, 0, 1);
}

export function readiness(energy: number): number {
  return 1 - ENERGY_INJURY_MODEL.energy.readinessMaxPenalty * Math.pow(1 - clamp(energy, 0, 100) / 100, ENERGY_INJURY_MODEL.energy.readinessExponent);
}

export interface EnergyMatchInput { energy: number; age: number; physicalSkill: number; position: string; pressing: number; involvement: number; minutes: number; }

export function energyLoss(input: EnergyMatchInput): number {
  const e = clamp(input.energy, 0, 100);
  const rate = ENERGY_INJURY_MODEL.energy.referenceFullMatchLoss / 90
    * ENERGY_INJURY_MODEL.energy.roleLoad[roleForPosition(input.position)]
    * pressingFactor(input.pressing)
    * physicalFatigueFactor(input.physicalSkill)
    * ageFatigueFactor(input.age)
    * lowEnergyFactor(e)
    * involvementFactor(input.involvement)
    * gameConfig.energy.matchLossScale;
  return Math.max(0, rate * Math.max(0, input.minutes));
}

export function loadIncrement(input: Pick<EnergyMatchInput, "position" | "pressing" | "involvement" | "minutes">): number {
  return input.minutes / 90 * ENERGY_INJURY_MODEL.energy.roleLoad[roleForPosition(input.position)] * pressingFactor(input.pressing) * involvementFactor(input.involvement);
}

export function recoveryCeiling(initialGameDays: number | null, matchSpacingDays: number): number {
  if (!initialGameDays || initialGameDays <= 0) return 100;
  const severity = 1 - Math.exp(-initialGameDays / (ENERGY_INJURY_MODEL.returnToFitness.severityScaleMatchIntervals * matchSpacingDays));
  return ENERGY_INJURY_MODEL.returnToFitness.freshReturnEnergy - ENERGY_INJURY_MODEL.returnToFitness.maxReturnEnergyPenalty * severity;
}

export function recoverEnergy(player: Player, recentLoad: number, matchSpacingDays: number, ceiling = 100): number {
  const skill = physicalSkill(player);
  const ageYears = Math.max(0, player.age - ENERGY_INJURY_MODEL.energy.ageRecoveryStartAge);
  const physical = Math.exp(ENERGY_INJURY_MODEL.energy.physicalRecoveryLogRange * (skill - 50) / 50);
  const age = Math.exp(-ENERGY_INJURY_MODEL.energy.ageRecoveryCoefficient * Math.pow(ageYears, ENERGY_INJURY_MODEL.energy.ageRecoveryExponent));
  const workload = 1 / (1 + ENERGY_INJURY_MODEL.energy.workloadRecoveryCoefficient * Math.pow(Math.max(0, recentLoad), ENERGY_INJURY_MODEL.energy.workloadRecoveryExponent));
  const amount = gameConfig.energy.recoveryScale * (ENERGY_INJURY_MODEL.energy.dailyRecoveryBase * physical * age * workload + ENERGY_INJURY_MODEL.energy.dailyRecoveryDeficitCoefficient * (100 - player.energy));
  return Math.min(ceiling, player.energy + amount);
}

export function acuteFactor(energy: number): number {
  const score = clamp(Math.pow((100 - clamp(energy, 0, 100)) / 50, ENERGY_INJURY_MODEL.injuryRisk.acuteRiskExponent), 0, ENERGY_INJURY_MODEL.injuryRisk.acuteRiskScoreCap);
  return Math.exp(Math.log(ENERGY_INJURY_MODEL.injuryRisk.acuteRiskAtEnergy50) * score);
}

export function loadFactor(recentLoad: number): number {
  return Math.exp(Math.log(ENERGY_INJURY_MODEL.injuryRisk.recentLoadRiskAtOneUnit) * clamp(recentLoad, 0, ENERGY_INJURY_MODEL.injuryRisk.recentLoadRiskInputCap));
}

export function ageFactor(age: number): number {
  const m = ENERGY_INJURY_MODEL.injuryRisk;
  const betaAge = Math.log(m.ageObservedHazardRatio) / (m.ageObservedPeak - m.ageObservedReferenceYoung) * m.ageResidualShare;
  return clamp(Math.exp(betaAge * (age - m.ageReference)), m.ageRiskMin, m.ageRiskMax);
}

export function injuryRiskMultiplier(energy: number, recentLoad: number, age: number): number { return acuteFactor(energy) * loadFactor(recentLoad) * ageFactor(age); }

export type InjurySeverityClass = "MINOR" | "MODERATE" | "SEVERE";
export interface InjurySeverity { kind: InjurySeverityClass; equivalentRealDays: number; }

export function drawInjurySeverity(rng: RngState, age: number): InjurySeverity {
  const s = ENERGY_INJURY_MODEL.severity;
  const u = nextDouble(rng);
  let kind: InjurySeverityClass;
  let base: number;
  if (u < s.minorProbability) { kind = "MINOR"; base = s.minorMinRealDays + (s.minorMaxRealDays - s.minorMinRealDays) * beta(rng, s.minorBetaAlpha, s.minorBetaBeta); }
  else if (u < s.minorProbability + s.moderateProbability) { kind = "MODERATE"; base = s.moderateMinRealDays + (s.moderateMaxRealDays - s.moderateMinRealDays) * beta(rng, s.moderateBetaAlpha, s.moderateBetaBeta); }
  else { kind = "SEVERE"; base = clamp(Math.exp(Math.log(s.severeMedianRealDays) + normal(rng, 0, s.severeLogSigma)), s.severeMinRealDays, s.severeMaxRealDays); }
  const ageFactorValue = clamp(Math.exp(s.ageSeverityLogPerYear * (age - s.ageSeverityReference)), s.ageSeverityMin, s.ageSeverityMax);
  return { kind, equivalentRealDays: base * ageFactorValue * gameConfig.injuries.severityScale };
}

export function injuryGameDays(equivalentRealDays: number, roundsPerSeason = calendarValues().roundsPerSeason, matchSpacingDays = calendarValues().matchSpacingDays): number {
  return Math.max(1, Math.ceil(equivalentRealDays / ENERGY_INJURY_MODEL.severity.referenceProMatchSpacingDays * roundsPerSeason / ENERGY_INJURY_MODEL.severity.referenceProMatchesPerSeason * matchSpacingDays));
}

export function recordInjury(
  rng: RngState,
  player: Player,
  cause: "MATCH" | "TRAINING",
  absoluteGameDay: number,
  roundsPerSeason = calendarValues().roundsPerSeason,
  matchSpacingDays = calendarValues().matchSpacingDays,
): { days: number; equivalentRealDays: number; lastingSetback: boolean } {
  const severity = drawInjurySeverity(rng, player.age);
  const days = injuryGameDays(severity.equivalentRealDays, roundsPerSeason, matchSpacingDays);
  player.injuryUntilAbsoluteGameDay = absoluteGameDay + days;
  player.injuryInitialGameDays = days;
  player.injuryEquivalentRealDays = severity.equivalentRealDays;
  player.injuryCause = cause;
  // Compatibility fields are derived from absolute state and are not decremented.
  player.injuryDays = days;
  const lastingSetback = applyLastingSetback(rng, player, severity.equivalentRealDays);
  return { days, equivalentRealDays: severity.equivalentRealDays, lastingSetback };
}

export function syncLegacyInjuryDays(player: Player, absoluteGameDay: number): number {
  const remaining = injuryDaysRemaining(player, absoluteGameDay);
  player.injuryDays = remaining;
  return remaining;
}

export function lastingSetbackProbability(equivalentRealDays: number): number {
  const s = ENERGY_INJURY_MODEL.lastingSetback;
  const excess = Math.max(0, equivalentRealDays - s.minimumEquivalentRealDays);
  if (excess <= 0) return 0;
  return s.probabilityMaximum * (1 - Math.exp(-Math.pow(excess / s.probabilityScaleDays, s.probabilityExponent)));
}

function stochasticRound(rng: RngState, value: number): number { const floor = Math.floor(value); return floor + (nextDouble(rng) < value - floor ? 1 : 0); }

export function applyLastingSetback(rng: RngState, player: Player, equivalentRealDays: number): boolean {
  if (nextDouble(rng) >= lastingSetbackProbability(equivalentRealDays)) return false;
  const s = ENERGY_INJURY_MODEL.lastingSetback;
  const budget = s.magnitudeBase + s.magnitudeScale * (1 - Math.exp(-equivalentRealDays / s.magnitudeSeverityScaleDays)) * beta(rng, s.magnitudeBetaAlpha, s.magnitudeBetaBeta);
  const isGk = player.position === "GK";
  const weights = isGk ? s.goalkeeperWeights : s.outfieldWeights;
  const before = player.overall;
  const skillLoss: Partial<Record<string, number>> = {
    pace: stochasticRound(rng, budget * (weights.pace ?? 0)),
    des: stochasticRound(rng, budget * (weights.defending ?? 0)),
    tec: stochasticRound(rng, budget * (weights.technical ?? 0)),
    gol: stochasticRound(rng, budget * (weights.goalkeeping ?? 0)),
  };
  for (const [key, loss] of Object.entries(skillLoss)) {
    if (loss && key in player.skills) player.skills[key as keyof typeof player.skills] = Math.max(1, player.skills[key as keyof typeof player.skills] - loss);
  }
  // A lasting setback permanently changes skills that computeAttributeCenters
  // draws on; invalidate any cached centers so the next tick recomputes them.
  bumpSkillsVersion();
  const after = overallFromSkills(player.position, player.skills);
  player.overall = after;
  // Part of the lost ground is gone for good: it is burned out of the player's
  // remaining career growth budget rather than reduced from a separate ceiling.
  // Without this the curve would simply regrow the whole loss.
  player.careerGrowthConsumed += s.careerGrowthLossShare * Math.max(0, before - after);
  // Derived economics must track the reduced overall. The daily development
  // refresh skips prime-age players entirely, so without this the market value
  // and release clause would stay stale for seasons after a lasting setback.
  player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  return true;
}

export function injuryDaysRemaining(player: Pick<Player, "injuryUntilAbsoluteGameDay" | "injuryDays">, absoluteGameDay: number): number {
  if (player.injuryUntilAbsoluteGameDay !== null && player.injuryUntilAbsoluteGameDay !== undefined) return Math.max(0, player.injuryUntilAbsoluteGameDay - absoluteGameDay + 1);
  return Math.max(0, player.injuryDays ?? 0);
}

export function isInjured(player: Pick<Player, "injuryUntilAbsoluteGameDay" | "injuryDays">, absoluteGameDay: number): boolean { return injuryDaysRemaining(player, absoluteGameDay) > 0; }

export function conditionLabel(player: Pick<Player, "energy" | "recentLoad" | "injuryUntilAbsoluteGameDay" | "injuryDays">, absoluteGameDay: number): string {
  if (isInjured(player, absoluteGameDay)) return "Injured";
  if (player.energy < 60) return "Needs rest";
  if (player.energy < 75) return "Tired";
  if ((player.recentLoad ?? 0) >= 1.5) return "Heavy recent workload";
  if ((player.recentLoad ?? 0) <= 0.5 && player.energy >= 90) return "Fresh";
  return "Normal workload";
}