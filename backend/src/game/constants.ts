import type { Position } from "./types";
import { gameConfig } from "../config";

/** One season = one in-game year. */
export const DAYS_PER_YEAR = gameConfig.seasonDays;

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

export const POSITION_GROUP = (tacPos: number): Position => {
  if (tacPos === 1) return 0;
  if (tacPos >= 2 && tacPos <= 9) return 1;
  if (tacPos >= 10 && tacPos <= 17) return 3;
  return 4;
};

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

export const BENCH_POSITIONS = [1, 1, 2, 4, 4, 12, 15, 15, 20, 20, 23];

export const BENCH_ORDER = [1, 22, 24, 11, 13, 14, 16, 2, 9, 3, 5];

export const SUB_POSITION_WEIGHTS = [18, 25, 10, 22, 17, 23, 4, 15, 5, 8, 1, 13, 11, 9, 19, 14, 24, 0, 16, 12, 2, 6, 7, 26, 20, 3, 21];

export const POSITION_ROLL = [10, 20, 20, 30, 20] as const;

export const COUNTRY_GROUPS: Record<string, number> = {
  BRA: 0,
  ARG: 1,
  URU: 1,
  POR: 0,
  ESP: 0,
  ITA: 0,
  FRA: 0,
  ING: 0,
  ALE: 0,
  COL: 1,
};

export const STARTING_CASH: number[] = [3500000, 6000000, 9000000, 15000000, 25000000];

export const TICKET_PRICES: number[][] = [
  [200, 500, 50, 0],
  [1000, 5000, 1200, 20],
  [2000, 10000, 1500, 50],
  [4000, 20000, 2500, 300],
  [4500, 30000, 3500, 400],
  [5000, 40000, 5500, 500],
];

export const TICKET_PRICE_NOISE: number[][] = [
  [10, 20, 5, 0],
  [100, 500, 200, 10],
  [300, 1000, 400, 20],
  [400, 1200, 500, 30],
  [500, 1500, 1000, 50],
];

export const TICKET_SPLIT = [0.15, 0.75, 0.09, 0.009];

export const REPUTATION_ATTENDANCE: number[][] = [
  [10, 25, 35, 50],
  [10, 25, 35, 50],
  [20, 40, 55, 80],
  [30, 55, 75, 100],
];

export const EVENT_CODES = {
  GOAL: 1,
  YELLOW: 2,
  RED: 3,
  YELLOW_RED: 4,
  INJURY: 5,
  SUB: 6,
  MISSED_PENALTY: 7,
  ASSIST: 8,
};

export const GOAL_SUBTYPES = {
  NORMAL: 1,
  OWN_GOAL: 2,
  PENALTY: 3,
  FREE_KICK: 4,
  OLYMPIC: 5,
  CORNER: 6,
};

export const FORMATION_SUB_BONUS = [1, 22, 24, 12, 14, 16, 2, 9, 3, 5];

export const CARD_YELLOW = [70, 40, 30];
export const CARD_YELLOW_SECOND = [45, 40, 30];
export const CARD_YELLOW_PRESSING = [30, 10, 0];
export const CARD_RED_FIRST = [1200, 900, 800];
export const CARD_RED_SECOND = [800, 700, 550];
export const INJURY_FIRST = [1500, 1000, 800];
export const INJURY_SECOND = [800, 600, 600];

// Brasfoot c/b.java Tx — shooter weights by tacPos (index 0 unused).
export const SHOTTER_WEIGHTS: Record<number, number> = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1,
  9: 8, 10: 4, 11: 4, 12: 4, 13: 8, 14: 8, 15: 8, 16: 8, 17: 8,
  18: 22, 19: 22, 20: 22, 21: 22, 22: 22, 23: 22, 24: 22, 25: 22,
};

// Brasfoot c/b.java Ty — assister weights by tacPos.
export const ASSISTER_WEIGHTS: Record<number, number> = {
  1: 1, 2: 10, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 10,
  10: 10, 11: 4, 12: 4, 13: 4, 14: 20, 15: 20, 16: 20, 17: 10,
  18: 10, 19: 10, 20: 10, 21: 10, 22: 10, 23: 10, 24: 10, 25: 10,
};

// Brasfoot c/b.java Tz — own-goal weights by tacPos.
export const OWN_GOAL_WEIGHTS: Record<number, number> = {
  1: 1, 2: 5, 3: 18, 4: 18, 5: 18, 6: 18, 7: 18, 8: 18, 9: 5,
  10: 1, 11: 5, 12: 5, 13: 5, 14: 1, 15: 1, 16: 1, 17: 1,
  18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 23: 1, 24: 1, 25: 1,
};

// Brasfoot c/b.java ez() — possession bonus indexed by pressing level.
export const PRESSING_POSSESSION = [0.0, 0.04, 0.08];

export const GOAL_DAMPING: Record<number, number[]> = {
  0: [5.5, 35.55, 15.0],
  1: [5.5, 35.55, 15.0],
  2: [5.5, 35.55, 15.0],
  3: [4.5, 40.55, 15.0],
  4: [4.5, 40.55, 15.0],
  5: [3.0, 40.55, 15.0],
  6: [0.5, 40.55, 15.0],
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
