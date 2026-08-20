import { gameConfig, scaleReferenceSeasonFlow, seasonFlowScale } from "../config";

export { scaleReferenceSeasonFlow, seasonFlowScale } from "../config";

export interface EconomyConfig {
  playerValue: {
    base: number;
    overallReference: number;
    overallExponent: number;
    multiplier: number;
    ageCurve: Record<number, number>;
    contractNeutralSeasons: number;
    contractWeight: number;
    contractMinMultiplier: number;
    contractMaxMultiplier: number;
  };
  salary: {
    base: number;
    overallReference: number;
    overallExponent: number;
    multiplier: number;
    ageCurve: Record<number, number>;
    floor: number;
    academyMultiplier: number;
  };
  contracts: {
    maxContractSeasons: number;
    renewalMinRaise: number;
    renewalSkillRaiseWeight: number;
    renewalSkillExponent: number;
    renewalMaxRaise: number;
    renewalAgeCurve: Record<number, number>;
    releaseClauseRemainingValuePct: number;
  };
}

export const economyConfig = (): EconomyConfig => ({
  playerValue: {
    base: gameConfig.playerValueBase,
    overallReference: gameConfig.playerValueOverallReference,
    overallExponent: gameConfig.playerValueOverallExponent,
    multiplier: gameConfig.playerValueMultiplier,
    ageCurve: gameConfig.playerValueAgeCurve,
    contractNeutralSeasons: gameConfig.playerValueContractNeutralSeasons,
    contractWeight: gameConfig.playerValueContractWeight,
    contractMinMultiplier: gameConfig.playerValueContractMinMultiplier,
    contractMaxMultiplier: gameConfig.playerValueContractMaxMultiplier,
  },
  salary: {
    base: scaleReferenceSeasonFlow(gameConfig.salaryBase),
    overallReference: gameConfig.salaryOverallReference,
    overallExponent: gameConfig.salaryOverallExponent,
    multiplier: gameConfig.salaryMultiplier,
    ageCurve: gameConfig.salaryAgeCurve,
    floor: scaleReferenceSeasonFlow(gameConfig.salaryFloor),
    academyMultiplier: gameConfig.academySalaryMultiplier,
  },
  contracts: {
    maxContractSeasons: gameConfig.maxContractSeasons,
    renewalMinRaise: gameConfig.renewalMinRaise,
    renewalSkillRaiseWeight: gameConfig.renewalSkillRaiseWeight,
    renewalSkillExponent: gameConfig.renewalSkillExponent,
    renewalMaxRaise: gameConfig.renewalMaxRaise,
    renewalAgeCurve: gameConfig.renewalAgeCurve,
    releaseClauseRemainingValuePct: gameConfig.releaseClauseRemainingValuePct,
  },
});

export function curveMultiplier(curve: Record<number, number>, age: number): number {
  if (curve[age] !== undefined) return curve[age];
  const keys = Object.keys(curve)
    .map(Number)
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  if (keys.length === 0) return 1;
  if (age <= keys[0]) return curve[keys[0]];
  const last = keys[keys.length - 1];
  if (age >= last) return curve[last];
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i];
    const hi = keys[i + 1];
    if (age >= lo && age <= hi) {
      const vLo = curve[lo];
      const vHi = curve[hi];
      const t = hi === lo ? 0 : (age - lo) / (hi - lo);
      return vLo + (vHi - vLo) * t;
    }
  }
  return curve[last];
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Remaining contract in whole seasons, derived from the configured season length. */
export function remainingSeasons(contractDays: number): number {
  if (contractDays <= 0) return 0;
  return contractDays / gameConfig.seasonDays;
}

/**
 * Market value of a player. Deterministic: only overall, age, and remaining
 * contract are used. No hidden development, form, position, or club context.
 */
export function calculatePlayerValue(overall: number, age: number, remainingContractSeasons: number): number {
  const cfg = economyConfig().playerValue;
  const overallClamped = clamp(overall, 1, 100);
  const baseValue = cfg.base * Math.pow(overallClamped / cfg.overallReference, cfg.overallExponent);
  const ageMult = curveMultiplier(cfg.ageCurve, age);
  const contractMult = clamp(
    1 + (remainingContractSeasons - cfg.contractNeutralSeasons) * cfg.contractWeight,
    cfg.contractMinMultiplier,
    cfg.contractMaxMultiplier
  );
  return Math.max(1, Math.round(baseValue * ageMult * contractMult * cfg.multiplier));
}

/**
 * Suggested per-season salary for a player about to sign a contract. Used for
 * generation and first contracts; persisted salaries are contractual and fixed.
 */
export function calculateBaseSalary(overall: number, age: number): number {
  const cfg = economyConfig().salary;
  const overallClamped = clamp(overall, 1, 100);
  const baseSalary = cfg.base * Math.pow(overallClamped / cfg.overallReference, cfg.overallExponent);
  const ageMult = curveMultiplier(cfg.ageCurve, age);
  return Math.max(cfg.floor, Math.round(baseSalary * ageMult * cfg.multiplier));
}

/** Salary paid while a player remains in the academy. */
export function calculateAcademySalary(overall: number, age: number): number {
  const cfg = economyConfig().salary;
  return Math.max(cfg.floor, Math.round(calculateBaseSalary(overall, age) * cfg.academyMultiplier));
}

/**
 * Fractional salary raise a player expects per season of a new contract.
 * Uses current salary, overall, age, and requested duration.
 */
export function calculateRenewalRaise(currentSalary: number, overall: number, age: number, requestedSeasons: number): number {
  const cfg = economyConfig().contracts;
  if (requestedSeasons <= 0 || currentSalary <= 0) return 0;
  const skillNormalized = (clamp(overall, 1, 100) - 1) / 98;
  const ageMult = curveMultiplier(cfg.renewalAgeCurve, age);
  const raw = cfg.renewalMinRaise + cfg.renewalSkillRaiseWeight * Math.pow(skillNormalized, cfg.renewalSkillExponent) * ageMult;
  return clamp(raw, cfg.renewalMinRaise, cfg.renewalMaxRaise);
}

/**
 * Equivalent fixed per-season salary the player requests for a contract of
 * `requestedSeasons` seasons, converting the compounded raises he expects into
 * one constant figure. See spec §18.
 */
export function calculateRenewalDemand(currentSalary: number, raise: number, requestedSeasons: number): number {
  if (requestedSeasons <= 0) return Math.round(currentSalary);
  if (raise <= 0) return Math.round(currentSalary);
  const r = clamp(raise, 0, 1);
  const n = requestedSeasons;
  const sum = Math.pow(1 + r, n + 1) - (1 + r);
  const requested = currentSalary * (sum / (n * r));
  return Math.round(requested);
}

/** Canonical demand used by both human renewals and AI clubs. */
export function calculateContractDemand(currentSalary: number, overall: number, age: number, requestedSeasons: number): number {
  const raise = calculateRenewalRaise(currentSalary, overall, age, requestedSeasons);
  return calculateRenewalDemand(currentSalary, raise, requestedSeasons);
}

/**
 * Release clause = remaining contract value x configured percentage.
 * Always derived from the current salary and remaining contract length so it
 * stays in sync automatically.
 */
export function calculateReleaseClause(salaryPerSeason: number, remainingSeasons: number): number {
  const pct = economyConfig().contracts.releaseClauseRemainingValuePct;
  return Math.round(salaryPerSeason * remainingSeasons * pct);
}
