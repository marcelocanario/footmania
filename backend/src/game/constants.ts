import { gameConfig } from "../config";

/** One season = one in-game year. */
export const DAYS_PER_YEAR = gameConfig.seasonDays;

/**
 * Single senior-squad cap enforced on EVERY acquisition path (youth promotion,
 * transfer auction, free-agent signing, loan claim). Loaned-in players occupy
 * squad slots and count toward the cap; loaned-out players do not.
 */
export const SENIOR_SQUAD_LIMIT = 35;

/**
 * Minimum senior squad size a persistent club is left with at rollover. Falling
 * below it triggers system replacement generation, which is non-academy
 * persistent creation and therefore reduces the next intake correction.
 */
export const SENIOR_SQUAD_FLOOR = 20;

/**
 * News kind reserved for admin "messages of the day". Multiple durable items
 * may exist, and the snapshot pins them ahead of the chronological feed.
 */
export const MOTD_NEWS_KIND = "motd";

// Formation names/geometry live in game/formations.ts (the single catalog).

export const STYLE_NAMES = ["Balanced", "Offensive", "Counter-attack"];
export const PRESSING_NAMES = ["Light", "Balanced", "Heavy"];
export const DIRECTION_NAMES = ["Through the middle", "Down the wings"];

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
  // Boundary/curated timeline events (§match-timeline). Structural codes, not
  // balance tunables. They must be pushed without consuming RNG draws so match
  // outcomes stay byte-identical to the pre-timeline engine.
  HALF_TIME: 10,
  SECOND_HALF_START: 11,
  FULL_TIME: 12,
  SHOOTOUT: 13,
  CORNER: 14,
  SAVE: 15,
  WOODWORK: 16,
  SHOT_MISS: 17,
  SHOT_BLOCKED: 18,
  // Post-final-whistle award: best performer on the winning team. Appended to
  // the event feed at finalization (no RNG, no simulation feedback).
  MVP: 19,
};

export const GOAL_SUBTYPES = {
  NORMAL: 1,
  OWN_GOAL: 2,
  PENALTY: 3,
  FREE_KICK: 4,
  OLYMPIC: 5,
  CORNER: 6,
};

// Player development & decay system. The career shape itself (growth/decline
// budgets, peak age, slow/fast curves) lives in gameConfig.playerCareer and is
// interpreted by careerCurves.ts; only the per-tick mechanics remain here.
export const DEVELOPMENT = {
  // Free-agent contract-length sliding scale still references the historical
  // decline-age distribution.
  declineAge: { mean: 30.0, stdDev: 2.0 },
  activity: {
    weights: [1.0, 0.75, 0.55, 0.4, 0.3],
    regulationMinutes: 90,
    defaultActivity: 0.7,
    inactiveGrowthMultiplier: 0.65,
    inactiveDeclineMultiplier: 1.4,
  },
  developmentEpsilon: 0.000001,
  tickFraction: 1 / DAYS_PER_YEAR,
  recentMatchWindow: 5,
} as const;
