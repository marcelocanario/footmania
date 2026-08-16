import type { Position } from "./types";

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
  "5-4-1",
  "5-3-2",
  "4-5-1",
  "4-4-2",
  "4-4-2",
  "4-4-2",
  "4-3-3",
  "4-3-3",
  "3-5-2",
  "3-4-3",
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

export const LEAGUE_PRIZES: number[][] = [
  [0, 0, 0, 0, 0, 0],
  [5000000, 3500000, 2000000, 1500000, 1000000, 500000],
  [2500000, 2000000, 1000000, 500000, 250000, 100000],
  [1500000, 1000000, 500000, 300000, 150000, 75000],
  [750000, 500000, 300000, 200000, 100000, 50000],
];

export const STATE_PRIZES = [700000, 500000, 300000, 100000];

export const CUP_PRIZES: number[][] = [
  [0, 0, 0, 0, 0, 0],
  [100000, 100000, 400000, 500000, 700000, 700000, 700000, 700000],
  [100000, 100000, 400000, 500000, 700000, 700000, 700000, 700000],
  [100000, 100000, 400000, 500000, 700000, 700000, 700000, 700000],
  [100000, 100000, 400000, 500000, 700000, 700000, 700000, 700000],
];

export const SPONSORSHIP: number[][] = [
  [3500000, 3500000],
  [6000000, 6000000],
  [4500000, 4500000],
  [2500000, 2500000],
  [2000000, 2000000],
];

export const STARTING_CASH: number[][] = [
  [3500000, 2000000],
  [15000000, 12000000],
  [12000000, 10000000],
  [10000000, 7000000],
  [3500000, 3000000],
];

export const LOAN_LIMITS = [1000000, 5000000, 3000000, 2000000, 1500000];

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
export const CARD_YELLOW_PRESSING = [30, 10, 30];
export const CARD_RED_FIRST = [1200, 900, 800];
export const CARD_RED_SECOND = [800, 700, 550];
export const INJURY_FIRST = [1500, 1000, 800];
export const INJURY_SECOND = [800, 600, 600];

export const SHOTTER_WEIGHTS: Record<number, number> = {
  3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1,
  2: 1, 9: 1,
  11: 8, 12: 8, 13: 8, 14: 8, 15: 8, 16: 8,
  10: 8, 17: 8,
  18: 22, 19: 22, 20: 22, 21: 22, 22: 22, 23: 22, 24: 22, 25: 22,
};

export const TACTIC_STYLE_POSSESSION = [0.0, 0.04, 0.08];

export const GOAL_DAMPING: Record<number, number[]> = {
  0: [5.5, 35.55, 15.0],
  1: [5.5, 35.55, 15.0],
  2: [5.5, 35.55, 15.0],
  3: [4.5, 40.55, 15.0],
  4: [4.5, 40.55, 15.0],
  5: [3.0, 40.55, 15.0],
  6: [0.5, 40.55, 15.0],
};

export const DAYS_PER_YEAR = 364;

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
