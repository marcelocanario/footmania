import { MATCH_SIMULATOR_CONFIG as MS, INFLUENCE_SCALES } from "../matchSimulatorConfig";
import type { MatchZone, Lane } from "./matchSim";
import { tacticalExecutionContrast } from "./familiarity";

/** Zone progression rank (mirrors matchSim.ts LONG_RANK). */
export const LONG_RANK: Record<MatchZone, number> = { DEF_WIDE: 0, DEF_CENTRAL: 0, MID_WIDE: 1, MID_CENTRAL: 1, ATT_WIDE: 2, ATT_CENTRAL: 2, BOX: 3 };

/**
 * Pure probability evaluators (plan §6.3). These mirror the match engine's
 * exact arithmetic so the rating observer can compute counterfactual outcome
 * distributions with one player's contribution substituted — WITHOUT touching
 * engine state, consuming RNG, or changing match behavior.
 *
 * The engine itself does NOT call these functions (it keeps its inline code,
 * so the golden digests stay byte-identical). The observer re-implements the
 * same formulas here with explicit inputs.
 *
 * IMPORTANT: these must stay in lockstep with matchSim.ts. If the engine's
 * formulas change, this file must change with them (the determinism tests
 * compare observed probabilities against a re-simulation).
 */

export interface FrozenContext {
  phase: string;
  zone: MatchZone;
  lane: Lane;
  possessionSide: 0 | 1;
  homeNeutral: boolean;
  /** Per-side aggregates the engine computes at decision time. */
  sides: {
    home: FrozenSide;
    away: FrozenSide;
  };
  /** Current EPV/state value (read from the engine's table). */
  stateValue: number;
}

export interface FrozenSide {
  /** Zone-involved players with their usable-Z per attribute and weight. */
  involved: {
    playerId: number;
    weight: number;
    usableZ: Record<string, number>;
  }[];
  /** localDensity(side, zone) already computed. */
  localDensity: number;
  /** Tactics values the formulas consume. */
  tactics: {
    style: "CONTROL" | "PRESS" | "COUNTER";
    pressing: number;
    direction: "CENTRE" | "WIDE";
    familiarity: number;
  };
  /** Support/coverage ratios for shape/press signals (already ratio'd). */
  supportRatio: number;
  coverageRatio: number;
  /** Weighted-mean readiness of the zone-involved players. */
  readinessMean: number;
  organisation: number;
  /** Goalkeeper's zGk (for shot evaluation). */
  gkZ?: number;
  /** Shooter's zFinishing (for shot evaluation; side is the attacking side). */
  finishingZ?: number;
}

/** Weighted mean usable attribute over the frozen involved set. */
export function weightedUsableZ(side: FrozenSide, key: string): number {
  const local = side.involved;
  if (local.length === 0) return 0;
  let sum = 0;
  let wsum = 0;
  for (const l of local) {
    const z = l.usableZ[key] ?? 0;
    sum += z * l.weight;
    wsum += l.weight;
  }
  return wsum > 0 ? sum / wsum : 0;
}

/** Weighted usable attribute with exactly one player's term replaced. */
export function weightedUsableZWithOverride(
  side: FrozenSide,
  key: string,
  playerId: number,
  replacement: number,
): number {
  const local = side.involved;
  if (local.length === 0) return 0;
  let sum = 0;
  let wsum = 0;
  for (const l of local) {
    sum += (l.playerId === playerId ? replacement : (l.usableZ[key] ?? 0)) * l.weight;
    wsum += l.weight;
  }
  return wsum > 0 ? sum / wsum : 0;
}

/**
 * Re-implements actionQualityFor / defensiveResistanceFor as a pure weighted
 * mean over the frozen involved set, with ONE player's usable-Z replaced by
 * same-role benchmarks PER ATTRIBUTE (plan §6.2 `weightedQualityWithOverride`).
 * The local-density scaling is applied identically to the engine.
 */
export function actionQualityWithOverride(side: FrozenSide, zone: MatchZone, action: string, playerId: number, benchmarks: Record<string, number>): number {
  const weights = MS.actionQuality.attributeWeights[action];
  if (!weights) return 0;
  const local = side.involved;
  if (local.length === 0) return 0;
  let sum = 0;
  for (const [attrKey, w] of Object.entries(weights)) {
    const canonical = SKILL_MAP[attrKey as keyof typeof SKILL_MAP];
    if (!canonical) continue;
    const benchZ = benchmarks[canonical] ?? 0;
    let vsum = 0;
    let wsum = 0;
    for (const l of local) {
      const z = l.playerId === playerId ? benchZ : (l.usableZ[canonical] ?? 0);
      vsum += z * l.weight;
      wsum += l.weight;
    }
    const mean = wsum > 0 ? vsum / wsum : 0;
    sum += w * mean;
  }
  return sum * side.localDensity;
}

/** Defensive counterpart of the override (plan §8). */
export function defensiveResistanceWithOverride(side: FrozenSide, zone: MatchZone, action: string, playerId: number, benchmarks: Record<string, number>): number {
  const weights = MS.actionQuality.defensiveResistanceWeights[action];
  if (!weights) return 0;
  const local = side.involved;
  if (local.length === 0) return 0;
  let sum = 0;
  for (const [attrKey, w] of Object.entries(weights)) {
    const canonical = SKILL_MAP[attrKey as keyof typeof SKILL_MAP];
    if (!canonical) continue;
    const benchZ = benchmarks[canonical] ?? 0;
    let vsum = 0;
    let wsum = 0;
    for (const l of local) {
      const z = l.playerId === playerId ? benchZ : (l.usableZ[canonical] ?? 0);
      vsum += z * l.weight;
      wsum += l.weight;
    }
    const mean = wsum > 0 ? vsum / wsum : 0;
    sum += w * mean;
  }
  return sum * side.localDensity;
}

/** SKILL_MAP canonical keys (mirrors matchSim.ts). */
const SKILL_MAP = {
  tec: "tech",
  vel: "pace",
  physical: "physical",
  fin: "finishing",
  gol: "gk",
  des: "discipline",
  pas: "tech",
  arm: "tech",
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Re-implements pressSignalAtExecution over a frozen side. */
export function pressSignalFrozen(side: FrozenSide, zone: MatchZone, executionFactor: number): number {
  const intensity = side.tactics.pressing;
  if (intensity <= 0) return 0;
  const localSupport = side.supportRatio;
  const raw = intensity * localSupport * executionFactor * side.readinessMean;
  const z = (raw - 0.6) / 0.5;
  return clamp(z, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
}

/** Re-implements shapeSignal over a frozen side. */
export function shapeSignalFrozen(att: FrozenSide, def: FrozenSide, zone: MatchZone): number {
  const raw = att.supportRatio - def.coverageRatio;
  return clamp(raw / Math.SQRT2, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
}

function executionFactorFor(ctx: FrozenContext, sideKey: "home" | "away"): number {
  const side = ctx.sides[sideKey];
  const other = ctx.sides[sideKey === "home" ? "away" : "home"];
  return tacticalExecutionContrast(side.tactics.familiarity, other.tactics.familiarity);
}

/** Control-failure probability (plan §9). Returns the failure probability and
 *  the split between MISCONTROL/DISPOSSESSED. */
export function controlFailureProbabilities(ctx: FrozenContext): { pFail: number; pMiscontrol: number; pDispossessed: number } {
  const att = ctx.sides[ctx.possessionSide === 0 ? "home" : "away"];
  const def = ctx.sides[ctx.possessionSide === 0 ? "away" : "home"];
  const row = MS.probabilityModel.state[`${ctx.phase}.${ctx.zone}`];
  const cf = row?.controlFailureProbability ?? 0.01;
  const mis = row?.controlFailureTypeProbabilities?.MISCONTROL ?? 0.5;
  const zBallSecurity = weightedUsableZ(att, "tech");
  const zOppPress = pressSignalFrozen(def, ctx.zone, executionFactorFor(ctx, ctx.possessionSide === 0 ? "away" : "home"));
  const logitP = logit(cf) - INFLUENCE_SCALES.teamScale * zBallSecurity + INFLUENCE_SCALES.tacticsScale * zOppPress;
  const pFail = logistic(logitP);
  return { pFail, pMiscontrol: mis, pDispossessed: 1 - mis };
}

/** Outcome resolution probabilities (plan §12): continue/turnover/foul/retained. */
export function outcomeProbabilities(ctx: FrozenContext, action: string): Record<string, number> {
  const attKey = ctx.possessionSide === 0 ? "home" : "away";
  const defKey = ctx.possessionSide === 0 ? "away" : "home";
  const att = ctx.sides[attKey];
  const def = ctx.sides[defKey];
  const row = MS.probabilityModel.outcomeByStateAction[`${ctx.phase}.${ctx.zone}.${action}`];
  const base = row
    ? (() => {
        const mult = MS.probabilityModel.foulProbabilityCalibrationMultiplier;
        const foul = row.foul * mult;
        const rest = row.continue + row.turnover + foul + row.retainedRestart;
        return { continue: row.continue / rest, turnover: row.turnover / rest, foul: foul / rest, retainedRestart: row.retainedRestart / rest };
      })()
    : { continue: 0.9, turnover: 0.05, foul: 0.03, retainedRestart: 0.02 };
  const densityCoefficient = action === "PASS" ? MS.actionQuality.passLocalDensityCoefficient : MS.actionQuality.localDensityCoefficient;
  const zExec = clamp(
    (actionQualityWithOverride(att, ctx.zone, action, -1, {}) - defensiveResistanceWithOverride(def, ctx.zone, action, -1, {})) / Math.SQRT2 +
      densityCoefficient * (att.localDensity - def.localDensity),
    -MS.normalization.contestZClamp,
    MS.normalization.contestZClamp,
  );
  const zPress = pressSignalFrozen(def, ctx.zone, executionFactorFor(ctx, defKey));
  const { teamScale, tacticsScale } = INFLUENCE_SCALES;
  const u = (baseLogP: number, zTeam: number, zT: number, cu: number) => baseLogP + teamScale * zTeam + tacticsScale * zT + cu;
  const continueU = u(Math.log(base.continue), zExec, -zPress, 0);
  const turnoverU = u(Math.log(base.turnover), -zExec, zPress, 0);
  // foulContextShift
  const disciplineZ = weightedUsableZ(def, "discipline");
  const discipline = clamp(0.5 - disciplineZ * 0.08, 0, 1);
  const disciplineRisk = 1 - discipline;
  const fatigueRisk = 1 - def.readinessMean;
  const lowOrganisation = 1 - def.organisation;
  const foulShift =
    MS.fouls.disciplineRiskLogitCoefficient * disciplineRisk +
    MS.fouls.pressIntensityLogitCoefficient * def.tactics.pressing +
    MS.fouls.fatigueLogitCoefficient * fatigueRisk +
    MS.fouls.lowOrganisationLogitCoefficient * lowOrganisation;
  const foulU = u(Math.log(base.foul), 0, 0, foulShift);
  const retainedU = u(Math.log(base.retainedRestart), 0, 0, 0);
  const labels = ["CONTINUE", "TURNOVER", "FOUL", "RETAINED_RESTART"];
  const utilities = [continueU, turnoverU, foulU, retainedU];
  const weights = utilities.map((x) => Math.exp(clamp(x, -50, 50)));
  const total = weights.reduce((s, w) => s + w, 0);
  return Object.fromEntries(labels.map((l, i) => [l, total > 0 ? weights[i] / total : 1 / labels.length]));
}

/** Shot resolution probabilities (plan §26-31): goal/save/block/woodwork/miss.
 *  `baselineXg`, `zFinish`, `zGk`, `pressured`, `finalXgC` are captured from
 *  the engine at resolution time; only the probability part is re-derived. */
export function shotOutcomeProbabilities(input: {
  baselineXg: number;
  zFinish: number;
  zGk: number;
  pressured: boolean;
  localDensityAtt: number;
  localDensityDef: number;
  homeNeutral: boolean;
  sideIsHome: boolean;
}): {
  pGoal: number;
  pOnTargetGivenNonGoal: number;
  pSave: number;
  pBlock: number;
  pWoodwork: number;
  pMiss: number;
} {
  const shotSkillSignal = clamp((input.zFinish - input.zGk) / Math.SQRT2, -MS.normalization.contestZClamp, MS.normalization.contestZClamp);
  const densitySignal = input.localDensityAtt - input.localDensityDef;
  const finalXg = logistic(
    logit(input.baselineXg) +
      MS.shotModel.finisherVsGoalkeeperLogitCoefficient * shotSkillSignal +
      shotQualityLogitShift(input.homeNeutral, input.sideIsHome) +
      MS.shotModel.localDensityCoefficient * densitySignal,
  );
  const pGoal = clamp(finalXg, 0.002, 0.98);
  const pOnTarget = clamp(
    MS.shotModel.shotsOnTarget.baseRate +
      MS.shotModel.shotsOnTarget.finishingCoefficient * input.zFinish -
      MS.shotModel.shotsOnTarget.pressurePenalty * (input.pressured ? 1 : 0),
    MS.shotModel.shotsOnTarget.min,
    MS.shotModel.shotsOnTarget.max,
  );
  const onTargetShares = MS.shotModel.nonGoalOutcome.onTarget;
  const notOnTargetShares = MS.shotModel.nonGoalOutcome.notOnTarget;
  const blockP = input.pressured ? notOnTargetShares.blockUnderPressure : notOnTargetShares.blockNoPressure;
  // Outcome tree conditioned on "not goal".
  const pOnTargetGiven = (1 - pGoal) * pOnTarget;
  const pOffTarget = (1 - pGoal) * (1 - pOnTarget);
  return {
    pGoal,
    pOnTargetGivenNonGoal: pOnTargetGiven,
    pSave: pOnTargetGiven * (onTargetShares.saveControlled + onTargetShares.saveRebound),
    pBlock: pOffTarget * blockP,
    pWoodwork: pOnTargetGiven * onTargetShares.woodwork + pOffTarget * notOnTargetShares.woodwork,
    pMiss: pOffTarget * (1 - blockP - notOnTargetShares.woodwork),
  };
}

function shotQualityLogitShift(homeNeutral: boolean, sideIsHome: boolean): number {
  if (homeNeutral) return 0;
  const baseTeamXg = MS.validation.reference["TEAM_MATCH.xG"]?.mean ?? 1.28;
  const baseTeamShots = MS.validation.reference["TEAM_MATCH.shots"]?.mean ?? 12.5;
  const p0 = baseTeamXg / baseTeamShots;
  const signedAdvantage = sideIsHome ? MS.homeAdvantage.targetXg : -MS.homeAdvantage.targetXg;
  const p1 = clamp(p0 + (MS.homeAdvantage.shotQualityShare * signedAdvantage) / baseTeamShots, 0.002, 0.98);
  return logit(p1) - logit(p0);
}

/** Card probabilities for a foul (plan §36-38): yellow/red given the fouler's
 *  discipline/readiness and the state threat. */
export function cardProbabilities(input: {
  zDiscipline: number;
  readiness: number;
  pressIntensity: number;
  stateValue: number;
  alreadyBooked: boolean;
}): { pYellow: number; pRed: number } {
  const foulMean = MS.validation.reference["MATCH.totalFouls"]?.mean ?? 30;
  const pYellowBase = MS.cards.yellowTargetPerMatch / foulMean;
  const pRedBase = MS.cards.redTargetPerMatch / foulMean;
  const disciplineRisk = 1 - clamp(input.zDiscipline * 0.08 + 0.5, 0, 1);
  const fatigueRisk = 1 - input.readiness;
  const highThreat = clamp(input.stateValue / 0.3, 0, 1);
  const shift =
    MS.cards.disciplineRiskLogitCoefficient * disciplineRisk +
    MS.cards.fatigueLogitCoefficient * fatigueRisk +
    MS.cards.pressIntensityLogitCoefficient * input.pressIntensity +
    MS.cards.highThreatLogitCoefficient * highThreat;
  const redP = logistic(logit(pRedBase) + shift);
  const yellowP = logistic(logit(pYellowBase) + shift - (input.alreadyBooked ? MS.cards.secondYellowLogitPenalty : 0));
  return { pYellow: yellowP, pRed: redP };
}
