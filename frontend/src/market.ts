/**
 * Client-side mirror of the backend's market math (game/market.ts).
 * The backend is authoritative for all market rules; these helpers exist only
 * to render accurate informational values (opening-price range) in the UI.
 * Keep in sync with backend/src/game/market.ts `roundToSensibleIncrement` and
 * `auctionOpeningRange`.
 */

/** Round a value to the same "sensible" monetary increment as the engine. */
function roundToSensibleIncrement(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return Math.round(value / 500_000) * 500_000;
  if (abs >= 1_000_000) return Math.round(value / 50_000) * 50_000;
  if (abs >= 100_000) return Math.round(value / 5_000) * 5_000;
  if (abs >= 10_000) return Math.round(value / 500) * 500;
  return Math.round(value / 50) * 50;
}

/** Seller-defined opening-price range ratios (§64.1). */
export const AUCTION_OPENING_MIN_RATIO = 0.6;
export const AUCTION_OPENING_MAX_RATIO = 1.0;

/** Allowed opening-price range for a player with base value `baseValue` (§64.1). */
export function auctionOpeningRange(baseValue: number): { min: number; max: number } {
  return {
    min: Math.max(1, roundToSensibleIncrement(baseValue * AUCTION_OPENING_MIN_RATIO)),
    max: Math.max(1, roundToSensibleIncrement(baseValue * AUCTION_OPENING_MAX_RATIO)),
  };
}
