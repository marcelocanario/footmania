import type { PrismaClient } from "@prisma/client";
import { MP_CONFIG, gameConfig, scaleReferenceSeasonFlow, seasonFlowScale } from "../config";
import { calculateBaseSalary, calculatePlayerValue } from "./economy";
import { remainingSeasons } from "./economy";
import { projectDivisionQuality } from "./generationProjection";

/**
 * Seasonal budget economy (plans/1. multiplayer.md §17A).
 *
 * The seasonal budget is an allocation ADDED to the club's existing finances
 * (never a balance reset). Each club-season pair may receive at most one
 * allocation per type (enforced by the MpAllocation unique constraint).
 */

export const FIRST_DIVISION_BUDGET_KEY = "FIRST_DIVISION_SEASON_BUDGET";
export const MINIMUM_TIER_BUDGET_RATIO_KEY = "MINIMUM_TIER_BUDGET_RATIO";
export const TIER_BUDGET_DECAY_RATE_KEY = "TIER_BUDGET_DECAY_RATE";

async function readSetting(prisma: PrismaClient, key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function writeSetting(prisma: PrismaClient, key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function readNumberSetting(prisma: PrismaClient, key: string, fallback: number): Promise<number> {
  const raw = await readSetting(prisma, key);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function writeNumberSetting(prisma: PrismaClient, key: string, value: number): Promise<void> {
  // Ratios and decay rates are fractional balancing parameters.  Rounding all
  // settings to integers silently turned 0.30 into 0 and 0.55 into 1, which
  // broke the lower-tier budget curve after an admin save.
  await writeSetting(prisma, key, String(value));
}

/** Current budget economy settings (plan §17A). */
export async function budgetSettings(prisma: PrismaClient) {
  const first = await ensureFirstDivisionBudget(prisma);
  const ratio = await readNumberSetting(prisma, MINIMUM_TIER_BUDGET_RATIO_KEY, MP_CONFIG.minimumTierBudgetRatio);
  const decay = await readNumberSetting(prisma, TIER_BUDGET_DECAY_RATE_KEY, MP_CONFIG.tierBudgetDecayRate);
  return { firstDivisionBudget: first, minimumTierBudgetRatio: ratio, tierBudgetDecayRate: decay };
}

/** Update budget economy settings, clamping to sane ranges (plan §17A). */
export async function setBudgetSettings(prisma: PrismaClient, opts: { firstDivisionBudget?: number; minimumTierBudgetRatio?: number; tierBudgetDecayRate?: number }) {
  if (opts.firstDivisionBudget !== undefined) {
    await writeNumberSetting(prisma, FIRST_DIVISION_BUDGET_KEY, Math.max(1000, Math.min(10_000_000_000, opts.firstDivisionBudget)));
  }
  if (opts.minimumTierBudgetRatio !== undefined) {
    await writeNumberSetting(prisma, MINIMUM_TIER_BUDGET_RATIO_KEY, Math.max(0.05, Math.min(1, opts.minimumTierBudgetRatio)));
  }
  if (opts.tierBudgetDecayRate !== undefined) {
    await writeNumberSetting(prisma, TIER_BUDGET_DECAY_RATE_KEY, Math.max(0.01, Math.min(5, opts.tierBudgetDecayRate)));
  }
  return budgetSettings(prisma);
}

/**
 * Quality assumptions the budget economy is built on, all DERIVED from the live
 * generation configuration rather than hard-coded. Retuning generation now moves
 * the budget curve with it instead of silently invalidating it.
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

/** Representative percentiles of the generated top-division population. */
const MEANINGFUL_SIGNING_PERCENTILE = 0.9;
const ELITE_PLAYER_PERCENTILE = 0.99;

/**
 * Initial value of FIRST_DIVISION_SEASON_BUDGET, derived from the existing
 * economy so a healthy top-division club can pay wages, keep a competitive
 * squad, and make ~1-2 meaningful acquisitions per season without buying
 * multiple elite players every month (plan §17A).
 */
export function calculateInitialFirstDivisionSeasonBudget(): number {
  const quality = expectedFirstDivisionQuality();
  const squadSize = MP_CONFIG.expectedSeniorSquadSize;

  // Expected per-season wage bill at Division 1 quality.
  const scale = seasonFlowScale();
  const expectedAveragePlayerSalary = calculateBaseSalary(quality.fullSquadOverall, 26) / scale; // 30-day reference salary
  const expectedSeasonWages = expectedAveragePlayerSalary * squadSize;

  // Expected first-team transfer spend: the configured number of meaningful
  // acquisitions at the derived meaningful-signing quality.
  const meaningfulSigningValue = calculatePlayerValue(quality.meaningfulSigningOverall, 27, 3);
  const expectedTransferSpend = MP_CONFIG.expectedMeaningfulSigningsPerSeason * meaningfulSigningValue;

  // Recurring operating costs are intentionally NOT funded directly by the
  // seasonal allocation beyond this estimate; there is no gate-revenue income
  // stream (the stadium/ticket mechanics were removed), so this budget is the
  // club's primary funding and must cover wages plus planned transfer spend.
  const rawTier1Budget = expectedSeasonWages + expectedTransferSpend;

  // Sanity band against derived representative values:
  //  - an average XI starter must be comfortably affordable;
  //  - a meaningful signing a real but reasonable purchase;
  //  - an elite player a major expenditure, not a routine buy.
  const averageStarterValue = calculatePlayerValue(quality.startingXiOverall, 25, 3);
  const eliteValue = calculatePlayerValue(quality.eliteOverall, 26, 3);
  const eliteCost = eliteValue + calculateBaseSalary(quality.eliteOverall, 26) / scale;
  // A club should be able to afford roughly one elite player per season as a
  // major decision, not several.
  const maxSensible = Math.round(eliteCost * 1.9);
  const minSensible = Math.round(averageStarterValue * 4);

  return scaleReferenceSeasonFlow(Math.max(minSensible, Math.min(rawTier1Budget, maxSensible)));
}

/** Ensure FIRST_DIVISION_SEASON_BUDGET is initialized exactly once. */
export async function ensureFirstDivisionBudget(prisma: PrismaClient): Promise<number> {
  const existing = await readNumberSetting(prisma, FIRST_DIVISION_BUDGET_KEY, Number.NaN);
  if (Number.isFinite(existing)) return existing;
  const value = calculateInitialFirstDivisionSeasonBudget();
  await writeSetting(prisma, FIRST_DIVISION_BUDGET_KEY, String(value));
  return value;
}

/** Tier budget with exponential decay toward a configurable floor (plan §17A). */
export async function tierBudget(prisma: PrismaClient, tier: number): Promise<number> {
  const first = await ensureFirstDivisionBudget(prisma);
  const ratio = Math.max(0.05, Math.min(1, await readNumberSetting(prisma, MINIMUM_TIER_BUDGET_RATIO_KEY, MP_CONFIG.minimumTierBudgetRatio)));
  const decay = Math.max(0.01, Math.min(5, await readNumberSetting(prisma, TIER_BUDGET_DECAY_RATE_KEY, MP_CONFIG.tierBudgetDecayRate)));
  return calculateTierBudget(first, ratio, decay, Math.max(1, tier));
}

/** Budget curve used for prize comparisons, including hypothetical tier 0. */
export async function prizeBudgetForTier(prisma: PrismaClient, tier: number): Promise<number> {
  const first = await ensureFirstDivisionBudget(prisma);
  const ratio = Math.max(0.05, Math.min(1, await readNumberSetting(prisma, MINIMUM_TIER_BUDGET_RATIO_KEY, MP_CONFIG.minimumTierBudgetRatio)));
  const decay = Math.max(0.01, Math.min(5, await readNumberSetting(prisma, TIER_BUDGET_DECAY_RATE_KEY, MP_CONFIG.tierBudgetDecayRate)));
  return calculateTierBudget(first, ratio, decay, tier);
}

/** Prorated budget for a club joining mid-season (plan §17). */
export function proratedBudget(fullBudget: number, remainingRounds: number, totalRounds: number): number {
  if (totalRounds <= 0) return fullBudget;
  return Math.round((fullBudget * Math.max(0, remainingRounds)) / totalRounds);
}

/** Calculate a configured tier budget, including hypothetical tier 0. */
export function calculateTierBudget(first: number, ratio: number, decay: number, tier: number): number {
  const minimum = Math.round(first * Math.max(0.05, Math.min(1, ratio)));
  const rate = Math.max(0.01, Math.min(5, decay));
  const budget = minimum + Math.round((first - minimum) * Math.exp(-rate * (tier - 1)));
  return Math.max(1, budget);
}

export { remainingSeasons };
