import { MP_CONFIG, gameConfig } from "../config";

/**
 * Seasonal budget economy (plans/1. multiplayer.md §17A).
 *
 * The Division 1 seasonal budget configured in `game.config.jsonc` is the
 * anchor of the entire money economy: seasonal allocations and player market
 * values both come off the one tier-decay curve below. `game.config.jsonc` is
 * the ONLY source of truth — there is no Setting row and no admin override, so
 * the same configuration always reproduces the same economy.
 *
 * The seasonal budget is an allocation ADDED to the club's existing finances
 * (never a balance reset). Each club-season pair may receive at most one
 * allocation per type (enforced by the MpAllocation unique constraint).
 */

/**
 * The single tier-decay implementation. Exponential decay from the Division 1
 * budget toward a configurable floor. `tier` may be fractional, and may sit
 * below 1 for a hypothetical stronger-than-D1 tier, which is what lets player
 * valuation price ability on the very same curve the pyramid pays out on.
 */
export function calculateTierBudget(first: number, ratio: number, decay: number, tier: number): number {
  const minimum = Math.round(first * Math.max(0.05, Math.min(1, ratio)));
  const rate = Math.max(0.01, Math.min(5, decay));
  const budget = minimum + Math.round((first - minimum) * Math.exp(-rate * (tier - 1)));
  return Math.max(1, budget);
}

/** The configured budget curve inputs. */
function budgetCurve(): { first: number; ratio: number; decay: number } {
  return {
    first: gameConfig.firstDivisionSeasonBudget,
    ratio: gameConfig.minimumTierBudgetRatio,
    decay: gameConfig.tierBudgetDecayRate,
  };
}

/** Current budget economy settings, straight from configuration. */
export function budgetSettings(): { firstDivisionBudget: number; minimumTierBudgetRatio: number; tierBudgetDecayRate: number } {
  const curve = budgetCurve();
  return { firstDivisionBudget: curve.first, minimumTierBudgetRatio: curve.ratio, tierBudgetDecayRate: curve.decay };
}

/**
 * Budget actually allocated to a real division. Real tiers start at 1, so the
 * curve is clamped there: an allocation must never be extrapolated above the
 * configured Division 1 budget.
 */
export function tierBudget(tier: number): number {
  const curve = budgetCurve();
  return calculateTierBudget(curve.first, curve.ratio, curve.decay, Math.max(1, tier));
}

/**
 * The same configured curve WITHOUT the real-tier clamp, so fractional tiers
 * and hypothetical tiers above Division 1 (tier < 1) are extrapolated. Used by
 * player quality pricing and by prize comparisons against a hypothetical
 * division 0.
 */
export function qualityTierBudget(tier: number): number {
  const curve = budgetCurve();
  return calculateTierBudget(curve.first, curve.ratio, curve.decay, tier);
}

/** Prorated budget for a club joining mid-season (plan §17). */
export function proratedBudget(fullBudget: number, remainingRounds: number, totalRounds: number): number {
  if (totalRounds <= 0) return fullBudget;
  return Math.round((fullBudget * Math.max(0, remainingRounds)) / totalRounds);
}

/**
 * Share of one season of tier budget that a single meaningful signing is worth.
 * Turns a seasonal club budget into a single player's price, which is what makes
 * market values commensurate with what a club can actually earn.
 */
export function meaningfulSigningShare(): number {
  return MP_CONFIG.expectedMeaningfulSigningsPerSeason / MP_CONFIG.expectedSeniorSquadSize;
}
