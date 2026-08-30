import { MATCH_SIMULATOR_CONFIG as MS, INFLUENCE_SCALES } from "../matchSimulatorConfig";
import type { Player, Match } from "./types";
import type { LivePlayerState, MatchZone } from "./matchSim";
import { computeAttributeCenters, robustZ, athleticismOf, adjustedSkillsForRole, type AttributeCenters, type CanonicalAttr } from "./matchSim";
import { DEPLOYED_ROLES, naturalDefaultRole } from "./positions";
import { bandUpperBound, rolePenalty } from "./outOfPosition";
import { actionQualityWithOverride, defensiveResistanceWithOverride, shotOutcomeProbabilities, weightedUsableZ, weightedUsableZWithOverride, type FrozenSide, type FrozenContext } from "./probabilityEval";
import { tacticalExecutionContrast } from "./familiarity";
import type { PlayerRatingAccum, RatingDecisionInput, EngineSideView } from "./ratingObserver";

/**
 * Player performance rating (plan). Pure math module: builds same-role median
 * benchmarks, computes per-decision counterfactual excess contribution (c) and
 * variance (v), aggregates to Z_raw, applies season-frozen positional
 * calibration, and converts to the fixed 3.0–10.0 scale.
 *
 * No RNG, no engine mutation, no config tunables (the numeric constants below
 * are the fixed product semantics from the plan).
 */

/** Fixed scale anchors (plan §3, §11). */
export const RATING_MIN = 3.0;
export const RATING_MAX = 10.0;
export const RATING_NEUTRAL = 6.5;
export const RATING_ONE_IN_3000_Z = 3.402932835041318;
export const RATING_SCALE = (RATING_MAX - RATING_NEUTRAL) / RATING_ONE_IN_3000_Z; // ≈1.0285
export const MIN_RATED_MINUTES = 10;

/** Role taxonomy for benchmarks/calibration (plan §6 coarse grouping). */
export type CoarseRole = "GK" | "FB" | "CB" | "MID" | "FWD";

/** Fine deployed role -> coarse role (plan §6 mapping). */
export function coarseRole(fineRole: string): CoarseRole {
  switch (fineRole) {
    case "GK": return "GK";
    case "LB": case "RB": return "FB";
    case "CB": return "CB";
    case "DM": case "AM": return "MID";
    case "LW": case "RW": case "ST": return "FWD";
    default: return "MID";
  }
}

/**
 * Benchmark set: per (DEPLOYED role, attributeKey) median usable-Z (§17).
 *
 * Keyed by the twelve fine deployed roles, not the five coarse groups: the
 * rating observer must be able to tell a DM from an AM, which a shared MID
 * benchmark makes impossible. Coarse roles remain the calibration taxonomy
 * (see `coarseRole`), so persisted calibration rows are untouched.
 */
export type RoleBenchmarks = Record<string, Record<string, number>>;

const BENCHMARK_ATTRS: CanonicalAttr[] = [
  "technique", "pace", "athleticism", "finishing", "goalkeeping", "defending", "passing", "playmaking",
];

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Build the same-role median usable-Z benchmarks (§17).
 *
 * For EACH deployed role independently:
 *   1. pool every active senior player whose compatibility penalty for THAT
 *      role is non-null and no greater than the configured Makeshift bound;
 *   2. take his full-energy effective canonical Z after that role's penalty;
 *   3. median per canonical attribute;
 *   4. empty fine pool -> every player in the role's coarse group with non-null
 *      compatibility for the role;
 *   5. still empty -> zero Z.
 *
 * Note the pool is defined by *eligibility for the role*, not by who happens to
 * be deployed there — otherwise a role nobody currently plays has no benchmark.
 */
export function buildRoleBenchmarks(players: Player[], deployedRoleOf: (p: Player) => string): RoleBenchmarks {
  void deployedRoleOf; // benchmarks are role-intrinsic, not lineup-dependent
  const centers = computeAttributeCenters(players);
  const makeshiftBound = bandUpperBound("Makeshift");
  const seniors = players.filter((p) => !p.isYouth);
  const out: RoleBenchmarks = {};
  for (const role of DEPLOYED_ROLES) {
    const eligibleForRole = seniors.filter((p) => rolePenalty(p.position, role) !== null);
    const primary = eligibleForRole.filter((p) => (rolePenalty(p.position, role) as number) <= makeshiftBound);
    // Step 4 fallback: same coarse group, compatibility non-null.
    const pool = primary.length > 0
      ? primary
      : eligibleForRole.filter((p) => coarseRole(naturalDefaultRole(p.position)) === coarseRole(role));
    out[role] = {};
    for (const key of BENCHMARK_ATTRS) {
      out[role][key] = medianOf(pool.map((p) => usableZOf(p, key, centers, role)));
    }
  }
  return out;
}

/** Usable-Z for a player attribute in the engine's space (robustZ(effectiveRaw)
 *  at full readiness; no fit factor — §7.1). Mirrors matchSim.buildPlayerState.
 *  The centers use the canonical attribute keys. */
function usableZOf(p: Player, key: CanonicalAttr, centers: AttributeCenters, deployedRole: string): number {
  const effective = adjustedSkillsForRole(p, deployedRole as import("./positions").DeployedRole);
  const value = canonicalValueOf(effective, key);
  const z = robustZ(value, centers.median[key], centers.sigma[key]);
  // Benchmarks assume a fully ready (energy 100) player; readiness ~ 1.
  return z;
}

const CANONICAL_OF: Record<CanonicalAttr, (s: Player["skills"]) => number> = {
  goalkeeping: (s) => s.gol,
  pace: (s) => s.pace,
  technique: (s) => s.tec,
  passing: (s) => s.pas,
  defending: (s) => s.des,
  playmaking: (s) => s.playmaking,
  athleticism: (s) => athleticismOf(s),
  finishing: (s) => s.fin,
};

function canonicalValueOf(skills: Player["skills"], key: CanonicalAttr): number {
  return CANONICAL_OF[key](skills);
}

/**
 * Season-frozen calibration snapshot (plan §10): per coarse role, the sorted
 * historical Z_raw values used for the empirical-percentile Gaussianization.
 */
export interface RoleCalibration {
  role: CoarseRole;
  zRaws: number[];
  /** When fewer than 2 observations, calibration is bypassed. */
  usable: boolean;
}

export function buildRoleCalibration(history: { role: CoarseRole; rawZ: number }[]): Record<CoarseRole, RoleCalibration> {
  const out = {} as Record<CoarseRole, RoleCalibration>;
  for (const role of Object.keys(groups) as CoarseRole[]) {
    const values = history.filter((h) => h.role === role).map((h) => h.rawZ).sort((a, b) => a - b);
    out[role] = { role, zRaws: values, usable: values.length >= 2 };
  }
  return out;
}

const groups: Record<CoarseRole, true> = { GK: true, FB: true, CB: true, MID: true, FWD: true };

/** Empirical-percentile Gaussianization (plan §10.2). */
export function balancedZ(rawZ: number, cal: RoleCalibration | undefined): number {
  if (!cal || !cal.usable) return rawZ;
  const { zRaws } = cal;
  const n = zRaws.length;
  let nLess = 0;
  let nEqual = 0;
  for (const z of zRaws) {
    if (z < rawZ) nLess++;
    else if (z === rawZ) nEqual++;
  }
  const u = (nLess + 0.5 * nEqual + 0.5) / (n + 1);
  return inverseNormalCdf(clamp(u, 1e-9, 1 - 1e-9));
}

/** Acklam's inverse normal CDF approximation (deterministic). */
export function inverseNormalCdf(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416, 1];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Convert a balanced Z to the 3.0–10.0 grade (plan §11). */
export function ratingFromBalancedZ(z: number): number {
  return clamp(RATING_NEUTRAL + RATING_SCALE * z, RATING_MIN, RATING_MAX);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Process one engine decision into per-player contribution updates.
 * `probabilities` is the engine's ACTUAL normalized vector; `resolved` is the
 * drawn outcome label. For each involved player whose attribute the decision
 * consumed, compute the counterfactual distribution by substituting the
 * same-role benchmark and update the player's accumulator.
 */
export function observeDecision(
  accum: Map<number, PlayerRatingAccum>,
  ctx: RatingDecisionInput,
  benchmarks: RoleBenchmarks,
  fineRoleOf: (playerId: number) => string,
  kind: "control-failure" | "intent" | "outcome" | "next-zone" | "shot" | "cards",
  probabilities: Record<string, number | string>,
  resolved: string,
  participants: number[],
  utilityOf: (outcome: string, isAttacker: boolean) => number,
): void {
  const attKey = ctx.possessionSide === 0 ? "home" : "away";
  const defKey = ctx.possessionSide === 0 ? "away" : "home";
  const att = ctx.sides[attKey];
  const def = ctx.sides[defKey];
  const attInvolved = att.involved;
  const defInvolved = def.involved;

  for (const pid of participants) {
    const onAtt = attInvolved.some((l) => l.ps.id === pid);
    const onDef = !onAtt && defInvolved.some((l) => l.ps.id === pid);
    if (!onAtt && !onDef) continue;
    const isAttacker = onAtt;
    const side = onAtt ? att : def;
    // §17: the observer uses the player's EXACT deployed-role benchmark.
    const bench = benchmarks[fineRoleOf(pid)] ?? {};
    const q = recomputeWithOverride(ctx, kind, isAttacker, pid, bench, probabilities, typeof probabilities.action === "string" ? probabilities.action : "PASS");
    const numQ = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
    // Next-zone decisions carry no direct rating contribution: the destination
    // distribution is a routine progression step (a completed pass/carry into
    // a zone), not a decisive event. Attempting a threat-delta credit here
    // proved to compound into large systematic negatives (a low-rank resolved
    // destination minus the averaged counterfactual). Chance creation is
    // instead credited through the shot and outcome paths. Control-failure is
    // also a pre-action check whose utility is intentionally zero.
    if (kind === "next-zone" || kind === "control-failure") continue;
    // Perspective-aware utilities: the outcome utility already values the
    // resolution from the participant's own team (see ratingObserver.utilityFor).
    const util = (outcome: string) => utilityOf(outcome, isAttacker);
    // Keep routine CONTINUE outcomes in the centered c/v calculation. Their
    // realized utility is zero, but c = 0 - mu is the negative counterpart to
    // a favorable turnover (or a positive retained/restart outcome). Dropping
    // all routine resolutions leaves only favorable events in the sample and
    // systematically drives the most involved defenders toward 10. KEEP is a
    // control-failure label and was excluded above.
    const mu = Object.entries(numQ).reduce((s, [k, p]) => s + p * util(k), 0);
    const v = Object.entries(numQ).reduce((s, [k, p]) => s + p * (util(k) - mu) ** 2, 0);
    const c = util(resolved) - mu;
    // A team-level outcome is shared by every zone-involved participant on the
    // side: dividing by the involved count keeps total impact bounded instead
    // of exploding with team size (a 7-man involvement would otherwise credit
    // each player the full decisive-outcome value ~2500 times a match).
    const share = Math.max(1, (isAttacker ? attInvolved : defInvolved).length);
    const cShared = c / share;
    const vShared = v / share;
    // Guard against NaN/degenerate counterfactuals: they carry no information.
    if (!Number.isFinite(mu) || !Number.isFinite(v) || !Number.isFinite(c) || v <= 0) continue;
    const clubId = ctx.sides.home.involved.some((l) => l.ps.id === pid) ? ctx.homeClubId : ctx.awayClubId;
    const a = accum.get(pid) ?? emptyAccum(pid, clubId);
    a.clubId = clubId;
    a.rawImpact += cShared;
    a.rawVariance += vShared;
    const cat = categoryFor(kind);
    a.categoryImpacts[cat] = (a.categoryImpacts[cat] ?? 0) + cShared;
    accum.set(pid, a);
    void side;
  }
}

function emptyAccum(playerId: number, clubId: number): PlayerRatingAccum {
  return { playerId, clubId, roleSeconds: {}, rawImpact: 0, rawVariance: 0, categoryImpacts: {}, roleSecondsTotal: 0 };
}

function categoryFor(kind: string): string {
  switch (kind) {
    case "shot": return "shooting";
    case "intent": case "next-zone": return "passing";
    case "outcome": return "defending";
    case "cards": return "defending";
    default: return "other";
  }
}

/** Convert an engine-side side view to the frozen evaluator shape. */
function toFrozenSide(side: EngineSideView, zone: MatchZone): FrozenSide {
  return {
    involved: side.involved.map((l) => ({
      playerId: l.ps.id,
      weight: l.weight,
      usableZ: {
        technique: l.ps.zTech,
        pace: l.ps.zPace,
        athleticism: l.ps.zPhysical,
        finishing: l.ps.zFinishing,
        goalkeeping: l.ps.zGk,
        defending: l.ps.zDefending,
        passing: (l.ps as unknown as { zPassing?: number }).zPassing ?? 0,
        playmaking: (l.ps as unknown as { zPlaymaking?: number }).zPlaymaking ?? 0,
      },
    })),
    localDensity: side.localDensity,
    tactics: { style: side.tactics.style as "CONTROL" | "PRESS" | "COUNTER", pressing: side.tactics.pressing, direction: side.tactics.direction as "CENTRE" | "WIDE", familiarity: side.tactics.familiarity },
    supportRatio: side.supportRatio,
    coverageRatio: side.coverageRatio,
    readinessMean: side.readinessMean,
    organisation: side.organisation,
  };
}

/** Recompute a decision's probability vector with one player substituted. */
function recomputeWithOverride(
  ctx: RatingDecisionInput,
  kind: string,
  isAttacker: boolean,
  playerId: number,
  bench: Record<string, number>,
  actual: Record<string, number | string>,
  action: string,
): Record<string, number | string> {
  const attKey = ctx.possessionSide === 0 ? "home" : "away";
  const defKey = ctx.possessionSide === 0 ? "away" : "home";
  const attFrozen = toFrozenSide(ctx.sides[attKey], ctx.zone);
  const defFrozen = toFrozenSide(ctx.sides[defKey], ctx.zone);

  if (kind === "control-failure") {
    // Ball security consumes the attacking involved players' technical usable-Z
    // only. Anchor on the engine's actual probability, then apply the exact
    // logit change from substituting this one player.
    const pFailActual = typeof actual.FAIL === "number" ? actual.FAIL : 0;
    const zActual = weightedUsableZ(attFrozen, "technique");
    const zSub = weightedUsableZWithOverride(attFrozen, "technique", playerId, bench.technique ?? 0);
    const pFailSub = logisticOf(
      logitOf(clamp(pFailActual, 1e-6, 1 - 1e-6))
      - INFLUENCE_SCALES.teamScale * (zSub - zActual),
    );
    return { FAIL: clamp(pFailSub, 1e-6, 1 - 1e-6), KEEP: 1 - clamp(pFailSub, 1e-6, 1 - 1e-6) };
  }

  if (kind === "outcome") {
    const att = ctx.sides[attKey];
    const def = ctx.sides[defKey];
    // Outcome resolution is evaluated from the participant's own team
    // perspective. The engine's actual vector is already the attacker's
    // distribution; the observer must value it against the side-appropriate
    // EPV threat, and the counterfactual must keep that same anchor.
    const v = ctx.possessionThreat;
    const attackerOwns = ctx.possessionSide === (att === ctx.sides.home ? 0 : 1);
    const densityCoefficient = action === "PASS" ? MS.actionQuality.passLocalDensityCoefficient : MS.actionQuality.localDensityCoefficient;
    // Actual zExec from the engine-captured aggregates (both sides' actual).
    const attAggActual = att.actionQuality ?? 0;
    const defAggActual = def.defensiveResistance ?? 0;
    const zExecActual = clamp(
      (attAggActual - defAggActual) / Math.SQRT2 + densityCoefficient * (att.localDensity - def.localDensity),
      -MS.normalization.contestZClamp,
      MS.normalization.contestZClamp,
    );
    // Substituted zExec: replace the target player's term with his same-role
    // benchmark PER ATTRIBUTE (each attribute the action consumes gets its own
    // benchmark value).
    const attAggSub = isAttacker
      ? actionQualityWithOverride(toFrozenSide(att, ctx.zone), ctx.zone, action, playerId, bench)
      : attAggActual;
    const defAggSub = isAttacker
      ? defAggActual
      : defensiveResistanceWithOverride(toFrozenSide(def, ctx.zone), ctx.zone, action, playerId, bench);
    const zExecSub = clamp(
      (attAggSub - defAggSub) / Math.SQRT2 + densityCoefficient * (att.localDensity - def.localDensity),
      -MS.normalization.contestZClamp,
      MS.normalization.contestZClamp,
    );
    // The counterfactual distribution is always the attacker's; the utility
    // applied by the observer already flips the perspective for defenders.
    // Keep the distribution a pure probability vector (no threat injection
    // into the softmax — that would be renormalized away).
    return outcomeCounterfactual(actual, zExecActual, zExecSub);
  }
  if (kind === "shot") {
    const pGoalActual = typeof actual.GOAL === "number" ? (actual.GOAL as number) : 0.3;
    const pSaveActual = typeof actual.SAVE === "number" ? (actual.SAVE as number) : 0;
    const pBlockActual = typeof actual.BLOCK === "number" ? (actual.BLOCK as number) : 0;
    const pWoodActual = typeof actual.WOODWORK === "number" ? (actual.WOODWORK as number) : 0;
    const pMissActual = typeof actual.MISS === "number" ? (actual.MISS as number) : 0;
    // Actual shooter/GK terms (captured in the shot metadata) and substituted.
    const zFinishActual = typeof actual.zFinish === "number" ? actual.zFinish : 0;
    const zGkActual = typeof actual.zGk === "number" ? actual.zGk : 0;
    const benchZ = bench[isAttacker ? "finishing" : "goalkeeping"] ?? 0;
    const zFinishSub = isAttacker ? benchZ : zFinishActual;
    const zGkSub = isAttacker ? zGkActual : benchZ;
    // Anchor on the engine's actual pGoal: invert to logit, apply the exact
    // delta the engine's formula produces for the substitution, re-logistic.
    const logitActual = logitOf(clamp(pGoalActual, 1e-6, 1 - 1e-6));
    const logitDelta = MS.shotModel.finisherVsGoalkeeperLogitCoefficient * (((zFinishSub - zGkSub) - (zFinishActual - zGkActual)) / Math.SQRT2);
    const pGoalSub = clamp(logisticOf(logitActual + logitDelta), 0.002, 0.98);
    // The non-goal tree re-derives from pGoal_sub, keeping the ACTUAL split
    // shares (pOnTarget given non-goal, block/woodwork shares) exactly as the
    // engine computes them — only the goal probability changes.
    const pNonGoalActual = 1 - pGoalActual;
    const pOnTargetGiven = pNonGoalActual > 1e-9 ? (pSaveActual + pWoodActual) / pNonGoalActual : 0;
    const blockShare = pNonGoalActual > 1e-9 && pBlockActual > 0 ? pBlockActual / (1 - pOnTargetGiven) : 0;
    const woodShare = pNonGoalActual > 1e-9 ? pWoodActual / (1 - pOnTargetGiven) : 0;
    void pMissActual;
    const pNonGoalSub = 1 - pGoalSub;
    const pSaveSub = pNonGoalSub * pOnTargetGiven;
    const pBlockSub = pNonGoalSub * (1 - pOnTargetGiven) * blockShare;
    const pWoodSub = pNonGoalSub * (1 - pOnTargetGiven) * woodShare;
    const pMissSub = Math.max(0, 1 - pGoalSub - pSaveSub - pBlockSub - pWoodSub);
    // The distribution stays the attacker's; the observer's side-aware utility
    // values it from each participant's own perspective.
    return { GOAL: pGoalSub, SAVE: pSaveSub, BLOCK: pBlockSub, WOODWORK: pWoodSub, MISS: pMissSub };
  }

/** EPV threat of the side that currently possesses the ball (read from the
 *  engine's state-value model). */
function possessionThreatFor(ctx: RatingDecisionInput): number {
  return typeof ctx.possessionThreat === "number" ? ctx.possessionThreat : ctx.stateValue;
}
  if (kind === "next-zone") {
    // Completed pass/cross/carry: next-zone decisions carry no direct rating
    // contribution (see observeDecision — they are skipped as routine
    // progression steps). This branch exists only to keep recomputeWithOverride
    // total; it returns the actual vector unchanged.
    return actual;
  }
  return actual;
}

function logitOf(p: number): number {
  return Math.log(p / (1 - p));
}
function logisticOf(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Counterfactual outcome distribution anchored to the engine's ACTUAL
 * probabilities (plan §7): the actual vector is `softmax(actual utilities)`,
 * so we recover the actual logit-utilities up to a constant (the softmax is
 * shift-invariant), then apply the substitution's effect on the zExec term
 * exactly as the engine's formula does. This keeps the counterfactual in
 * lockstep with the engine — no re-derivation drift.
 *
 * zExec enters each outcome utility with coefficient: +1 CONTINUE, −1
 * TURNOVER, 0 FOUL / RETAINED_RESTART (mirrors resolveOutcome).
 */
function outcomeCounterfactual(
  actual: Record<string, number | string>,
  zExecActual: number,
  zExecSub: number,
): Record<string, number | string> {
  const labels = ["CONTINUE", "TURNOVER", "FOUL", "RETAINED_RESTART"];
  const actualP = labels.map((l) => (typeof actual[l] === "number" ? (actual[l] as number) : 0));
  const totalActual = actualP.reduce((s, p) => s + p, 0) || 1;
  const normalized = actualP.map((p) => p / totalActual);
  // log-utilities up to a constant C: u_k = log(p_k) + C. The softmax is
  // shift-invariant, so we can pick C=0.
  const uActual = normalized.map((p) => Math.log(Math.max(1e-12, p)));
  const { teamScale } = INFLUENCE_SCALES;
  const zCoeff = [1, -1, 0, 0];
  const delta = teamScale * (zExecSub - zExecActual);
  const uSub = uActual.map((u, i) => u + zCoeff[i] * delta);
  const weights = uSub.map((u) => Math.exp(Math.max(-50, Math.min(50, u))));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const out: Record<string, number | string> = {};
  labels.forEach((l, i) => { out[l] = total > 0 ? weights[i] / total : 1 / labels.length; });
  return out;
}

export type { Match, MatchZone, FrozenSide, FrozenContext };