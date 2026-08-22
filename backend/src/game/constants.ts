import { gameConfig } from "../config";

/** One season = one in-game year. */
export const DAYS_PER_YEAR = gameConfig.seasonDays;

/**
 * Single senior-squad cap enforced on EVERY acquisition path (youth promotion,
 * transfer auction, free-agent signing, loan claim). Loaned-in players occupy
 * squad slots and count toward the cap; loaned-out players do not.
 */
export const SENIOR_SQUAD_LIMIT = 35;

export const POSITION_NAMES = ["GK", "FB", "CB", "MF", "FW"];

export const FORMATION_POSITIONS: number[][] = [
  [1, 20, 11, 13, 14, 16, 2, 9, 6, 4, 8],
  [1, 20, 11, 13, 14, 16, 2, 9, 6, 4, 8],
  [1, 22, 24, 12, 14, 16, 2, 9, 6, 4, 8],
  [1, 23, 11, 13, 15, 2, 9, 6, 8, 10, 17],
  [1, 22, 24, 11, 13, 14, 16, 2, 9, 3, 5],
  [1, 19, 21, 11, 12, 13, 15, 2, 9, 6, 8],
  [1, 22, 24, 12, 14, 15, 16, 2, 9, 6, 8],
  [1, 22, 23, 24, 12, 14, 16, 2, 9, 6, 8],
  [1, 19, 20, 21, 11, 13, 15, 2, 9, 6, 8],
  [1, 22, 24, 11, 13, 15, 4, 6, 8, 10, 17],
  [1, 18, 25, 23, 11, 13, 4, 6, 8, 10, 17],
  [1, 23, 14, 16, 15, 13, 11, 2, 9, 6, 8],
  [1, 20, 10, 17, 15, 13, 11, 2, 9, 6, 8],
];

export const FORMATION_NAMES = [
  "5-4-1",
  "5-4-1 Wide",
  "5-3-2",
  "4-5-1",
  "4-4-2",
  "4-4-2 Diamond",
  "4-4-2 Attacking",
  "4-3-3",
  "4-3-3 Holding",
  "3-5-2",
  "3-4-3",
  "4-2-3-1",
  "4-2-3-1 Wide",
];

export const STYLE_NAMES = ["Balanced", "Total Attack", "Counter-attack"];
export const PRESSING_NAMES = ["Light", "Heavy", "Very Heavy"];
export const DIRECTION_NAMES = ["Through the middle", "Down the wings"];

export const TACTICAL_POSITION_NAMES: Record<number, string> = {
  1: "GK",
  2: "LB",
  3: "CB",
  4: "CB",
  5: "CB",
  6: "RB",
  7: "CB",
  8: "CB",
  9: "RB",
  10: "LM",
  11: "CDM",
  12: "CM",
  13: "CM",
  14: "CM",
  15: "CAM",
  16: "CM",
  17: "RM",
  18: "ST",
  19: "LW",
  20: "LB",
  21: "CB",
  22: "CB",
  23: "CB",
  24: "CB",
  25: "ST",
};

export const BENCH_ORDER = [1, 22, 24, 11, 13, 14, 16, 2, 9, 3, 5];

export const EVENT_CODES = {
  GOAL: 1,
  YELLOW: 2,
  RED: 3,
  YELLOW_RED: 4,
  INJURY: 5,
  SUB: 6,
  MISSED_PENALTY: 7,
  ASSIST: 8,
  COIN_TOSS: 9,
};

export const GOAL_SUBTYPES = {
  NORMAL: 1,
  OWN_GOAL: 2,
  PENALTY: 3,
  FREE_KICK: 4,
  OLYMPIC: 5,
  CORNER: 6,
};

// Player development & decay system (spec: player-evelopment.md §31/§55).
export const DEVELOPMENT = {
  declineAge: { mean: 30.0, stdDev: 2.0, min: 24.0, max: 38.0 },
  developmentRate: { alpha: 5.0, beta: 5.0, min: 0.6, max: 1.4 },
  volatility: { alpha: 2.0, beta: 5.0, min: 0.03, max: 0.2 },
  growthCurve: { referenceAge: 18.0, maxSeasonalGrowth: 3.0, exponent: 1.35 },
  declineCurve: { initialDecline: 0.3, coefficient: 0.37, exponent: 1.5 },
  activity: {
    weights: [1.0, 0.75, 0.55, 0.4, 0.3],
    regulationMinutes: 90,
    defaultActivity: 0.7,
    transferActivity: 0.7,
    inactiveGrowthMultiplier: 0.65,
    inactiveDeclineMultiplier: 1.4,
  },
  randomFactor: { mean: 1.0, min: 0.8, max: 1.2 },
  developmentEpsilon: 0.000001,
  tickFraction: 1 / DAYS_PER_YEAR,
  recentMatchWindow: 5,
  backfillVersion: "development-profile-v1",
} as const;
