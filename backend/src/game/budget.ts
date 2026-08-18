import type { PrismaClient } from "@prisma/client";
import { MP_CONFIG, gameConfig } from "../config";
import { calculateBaseSalary, calculatePlayerValue } from "./economy";
import { remainingSeasons } from "./economy";

/**
 * Seasonal budget economy (plans/multiplayer.md §17A).
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
 * Estimate of the senior-squad average overall for a healthy Division 1 club.
 * Derived from the club-generation curve: top clubs (level 19-25) generate
 * players around overall ~72-80. We pick a representative middle value.
 */
export function expectedFirstTeamOverall(): number {
  return 72;
}

/**
 * Initial value of FIRST_DIVISION_SEASON_BUDGET, derived from the existing
 * economy so a healthy top-division club can pay wages, keep a competitive
 * squad, and make ~1-2 meaningful acquisitions per season without buying
 * multiple elite players every month (plan §17A).
 */
export function calculateInitialFirstDivisionSeasonBudget(): number {
  const overall = expectedFirstTeamOverall();
  const squadSize = MP_CONFIG.expectedSeniorSquadSize;

  // Expected per-season wage bill at Division 1 quality.
  const expectedAveragePlayerSalary = calculateBaseSalary(overall, 26); // peak-age salary
  const expectedSeasonWages = expectedAveragePlayerSalary * squadSize;

  // Expected first-team transfer spend: 2 meaningful acquisitions of a strong
  // starter (~overall 78).
  const starOverall = 78;
  const starValue = calculatePlayerValue(starOverall, 27, 3);
  const expectedTransferSpend = MP_CONFIG.expectedMeaningfulSigningsPerSeason * starValue;

  // Recurring operating costs are intentionally NOT funded directly by the
  // seasonal allocation: clubs have gate revenue, TV deals, and prizes as
  // separate income streams. Counting them again here would double-fund wages.
  const rawTier1Budget = expectedSeasonWages + expectedTransferSpend;

  // Sanity check against representative values:
  //  - an average starter (~overall 68) must be comfortably affordable;
  //  - a star (~78) a meaningful-but-reasonable purchase;
  //  - an elite (~86) a major expenditure, not a routine buy.
  const avgStarter = calculatePlayerValue(68, 25, 3);
  const elite = calculatePlayerValue(86, 26, 3);
  const eliteCost = elite + calculateBaseSalary(86, 26);
  // A club should be able to afford roughly 1 elite player per season as a
  // major decision, not several. Cap the budget so 2+ elite purchases aren't
  // routine.
  const maxSensible = Math.round(eliteCost * 1.9);
  const minSensible = Math.round(avgStarter * 4);

  return Math.round(Math.max(minSensible, Math.min(rawTier1Budget, maxSensible)));
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
  const minimum = Math.round(first * ratio);
  const budget = minimum + Math.round((first - minimum) * Math.exp(-decay * Math.max(0, tier - 1)));
  return Math.max(1, budget);
}

/** Prorated budget for a club joining mid-season (plan §17). */
export function proratedBudget(fullBudget: number, remainingRounds: number, totalRounds: number): number {
  if (totalRounds <= 0) return fullBudget;
  return Math.round((fullBudget * Math.max(0, remainingRounds)) / totalRounds);
}

/** Small performance modifier based on previous-season finish (plan §17A). */
export function performanceModifier(finishPosition: number, divisionSize: number): number {
  // Small range around 1.0: leaders get a small bump, relegation zone a small cut.
  const mid = (divisionSize + 1) / 2;
  const delta = (mid - finishPosition) / (Math.max(1, divisionSize - 1));
  return Math.max(0.85, Math.min(1.15, 1 + delta * 0.06));
}

export { remainingSeasons };
