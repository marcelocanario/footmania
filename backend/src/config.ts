import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

export const PORT = Number(process.env.PORT ?? 3001);
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
export const COOKIE_NAME = "fm_session";

const nonNegativeNumber = z.number().min(0);

const ageCurveSchema = z.record(z.string(), z.number()).refine(
  (obj) => {
    const keys = Object.keys(obj);
    return keys.every((k) => Number.isFinite(Number(k)));
  },
  { message: "age curve keys must be numeric ages" }
);

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM in UTC");

const gameConfigSchema = z
  .object({
    league: z.object({
      teams: z.number().int().min(4),
      turns: z.number().int().min(1),
      startDay: z.number().int().min(0),
      restDaysBetweenMatches: z.number().int().min(0),
    }),
    interseasonDays: z.number().int().min(1),
    interseasonAfterMatchDays: z.number().int().min(0).default(2),
    interseasonBeforeNextSeasonDays: z.number().int().min(0).default(5),
    scheduler: z.object({
      gameDayRolloverUtc: timeSchema,
      leagueMatchStartUtc: timeSchema,
      leaseSeconds: z.number().int().min(5).default(30),
    }),
    economy: z.object({
      referenceSeasonDays: z.number().int().min(1),
    }),
    payrollIntervalDays: z.number().int().min(1),
    weeklyIntervalDays: z.number().int().min(1),
    freeAgentRetentionDays: z.number().int().min(1).default(30),
    contractWarningSeasons: z.number().int().min(1),
    playerValueBase: nonNegativeNumber,
    playerValueOverallReference: z.number().min(1),
    playerValueOverallExponent: nonNegativeNumber,
    playerValueMultiplier: nonNegativeNumber,
    playerValueAgeCurve: ageCurveSchema,
    playerValueContractNeutralSeasons: nonNegativeNumber,
    playerValueContractWeight: z.number(),
    playerValueContractMinMultiplier: nonNegativeNumber,
    playerValueContractMaxMultiplier: nonNegativeNumber,
    salaryBase: nonNegativeNumber,
    salaryOverallReference: z.number().min(1),
    salaryOverallExponent: nonNegativeNumber,
    salaryMultiplier: nonNegativeNumber,
    salaryAgeCurve: ageCurveSchema,
  salaryFloor: nonNegativeNumber,
  academySalaryMultiplier: nonNegativeNumber,
  maxContractSeasons: z.number().int().min(1),
  renewalMinRaise: nonNegativeNumber,
  renewalSkillRaiseWeight: nonNegativeNumber,
  renewalSkillExponent: nonNegativeNumber,
  renewalMaxRaise: nonNegativeNumber,
  renewalAgeCurve: ageCurveSchema,
    releaseClauseRemainingValuePct: nonNegativeNumber,
    playerGeneration: z.object({
      playerQualitySpreadFraction: nonNegativeNumber,
      divisionSpanSigmas: nonNegativeNumber,
      academyPedigreeSigmas: nonNegativeNumber,
    }),
    playerGenerationRules: z.object({
      initialSeniorSquadSize: z.number().int().min(1),
      initialAcademySize: z.number().int().min(1),
      academyRosterLimit: z.number().int().min(1),
      seasonalAcademyIntake: z.number().int().min(0),
      academyMinAge: z.number().int().min(1),
      academyMaxAge: z.number().int().min(1),
      academyPromotionAge: z.number().int().min(1),
      academyContractSeasons: z.number().int().min(1),
    }),
    // Primary balance tunables of the match simulator (plans/6. §0/§6). The
    // full matchSimulator model lives in config/match-simulator.jsonc; only the
    // normalized 40/35/25 latent-decision weights are promoted into the game
    // config so competitive balance is tuned in one place. Optional with a
    // default so older/custom config objects (tests) without the block parse.
    matchSimulator: z
      .object({
        influence: z
          .object({
            team: nonNegativeNumber,
            tactics: nonNegativeNumber,
            luck: nonNegativeNumber,
          })
          .superRefine((influence, ctx) => {
            const sum = influence.team + influence.tactics + influence.luck;
            if (sum <= 0) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: `matchSimulator.influence must have a positive sum (got ${sum})`, path: ["influence"] });
            }
          }),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.playerGenerationRules.academyMinAge > cfg.playerGenerationRules.academyMaxAge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `academyMinAge (${cfg.playerGenerationRules.academyMinAge}) must be <= academyMaxAge (${cfg.playerGenerationRules.academyMaxAge})`,
        path: ["playerGenerationRules"],
      });
    }
    if (cfg.playerGenerationRules.academyRosterLimit < cfg.playerGenerationRules.initialAcademySize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `academyRosterLimit (${cfg.playerGenerationRules.academyRosterLimit}) must be >= initialAcademySize (${cfg.playerGenerationRules.initialAcademySize})`,
        path: ["playerGenerationRules"],
      });
    }
    if (cfg.league.teams % 2 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `league.teams (${cfg.league.teams}) must be even`,
        path: ["league", "teams"],
      });
    }
    const roundsPerSeason = cfg.league.turns * (cfg.league.teams - 1);
    const matchSpacingDays = cfg.league.restDaysBetweenMatches + 1;
    const lastLeagueMatchDayIndex = cfg.league.startDay + (roundsPerSeason - 1) * matchSpacingDays;
    const seasonDays = lastLeagueMatchDayIndex + 1 + cfg.interseasonDays;
    if (roundsPerSeason <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "roundsPerSeason must be positive", path: ["league"] });
    }
    if (lastLeagueMatchDayIndex >= seasonDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lastLeagueMatchDayIndex (${lastLeagueMatchDayIndex}) must be < seasonDays (${seasonDays})`,
        path: ["league"],
      });
    }
    if (seasonDays - (lastLeagueMatchDayIndex + 1) !== cfg.interseasonDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "interseasonDays must equal the derived season remainder", path: ["interseasonDays"] });
    }
    if (cfg.interseasonAfterMatchDays + cfg.interseasonBeforeNextSeasonDays !== cfg.interseasonDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "interseasonAfterMatchDays + interseasonBeforeNextSeasonDays must equal interseasonDays",
        path: ["interseasonAfterMatchDays"],
      });
    }
  });

  // Central market configuration (transfer-market-overhaul §85). Every market
  // multiplier/balance knob lives here so business logic never hard-codes a
  // tunable value. Structural rules (privacy, youth ineligibility, shared
  // financial validation) remain domain invariants in the market services.
  export const MARKET_CONFIG = {
    transferAuction: {
      // Real-time 24-hour listings (replaces legacy auctionDurationDays).
      durationHours: 24,
      cap: {
        // Bidder-specific club-to-club cap (§10/§102.13.3). The cap is
        // asymmetric based on the division GAP between buyer and seller:
        //   favorableGap = max(0, Dseller - Dbuyer)
        //   normalizedGap = favorableGap / max(1, Dmax - 1)
        //   curve = (1 - exp(-K * normalizedGap)) / (1 - exp(-K))
        //   capMultiplier = base + bonus * curve
        // Same/weaker-division buyer => exactly BASE (150%); strongest buying
        // from weakest => BASE + BONUS (300%). Independent of the budget curve.
        baseMultiplier: 1.5,
        maxBonusMultiplier: 1.5,
        curveK: 2.0,
      },
      bidIncrementRate: 0.01,
      transferLockupDays: 15,
      // Anti-sniping soft close (§18): any competitive bid (leader or price
      // change) resets the remaining time to this window whenever less than
      // the window remains. There is no extension cap or accumulator.
      softCloseWindowMinutes: 30,
      allowAcrossSeasonRollover: true,
    },

    freeAgents: {
      durationHours: 24,
      relistMultipliers: [0.1, 0.075, 0.05, 0.025],
      // Null => no player-value cap; only the immediate-cash rule applies.
      valueBasedMaximumMultiplier: null,
      contractMinSeasons: 1,
      contractMaxSeasons: 4,
      contractAgeMidpointOffset: 1.0,
      contractAgeScaleSigmaMultiplier: 0.625,
      allowAcrossSeasonRollover: true,
    },

    // Match-engine balance values. When the attacking side leads by 2+ goals
    // and the defending club's strength bucket exceeds the attacker's by at
    // least comebackRepGap buckets, comeback probability is suppressed.
    match: {
      comebackRepGap: 2,
      homeAdvantageStrength: 0.6,
    },

    aiSelling: {
      // Phase 5 AI selling (§36/§39/§40). Weights are starting points tuned in
      // Phase 11; exact ranges come from the plan's suggested values.
      sellScore: {
        surplusAtPosition: 30,
        backupRarelyNeeded: 25,
        olderWithReplacement: 15,
        contractNearingExpiry: 10,
        poorWageEfficiency: 10,
        squadAboveDesiredSize: 10,
        financialPressure: 30,
        marketOpportunity: 10,
        primaryStarterPenalty: -30,
        onlyAdequatePlayerPenalty: -40,
        positionThinPenalty: -30,
      },
      // The AI lists only when it would accept selling at the opening price
      // (the base-value default, §64.1). A positive threshold encourages supply;
      // too high starves the market. Tuned in Phase 11.
      listThreshold: 25,
      // Salary/value efficiency: salary above this fraction of value triggers
      // the poor-wage-efficiency sell signal (§36).
      poorWageEfficiencySalaryToValueRatio: 0.2,
      // Age at which an ageing-with-replacement sell signal applies (§36).
      ageingSellAge: 30,
      // Minimum senior players per position (used for market-opportunity
      // demand counting, §40).
      minPerPosition: [3, 4, 4, 5, 4],
      // Market-opportunity thresholds (§40): few listings at the position and
      // several needy clubs before the nudge applies.
      marketOpportunityMaxActiveListings: 1,
      marketOpportunityMinNeedyClubs: 2,
      // Number of AI clubs evaluated per worker tick (spreads load and keeps
      // each run small). 0 => evaluate every AI club.
      clubsPerTick: 4,
      // An AI club evaluates its squad at most this often (real-time minutes).
      evaluationIntervalMinutes: 120,
      // Maximum players a club lists in one evaluation run.
      maxListingsPerClub: 3,
      // Desired senior squad size (for oversized-squad pressure).
      desiredSeniorSquadSize: 26,
      // Players below this overall count as "adequate" for depth protection.
      depthReplacementOverallFloor: 60,
      // Market-opportunity horizon: how many recent days count as "few players
      // available" when a club over-stocks a position.
      marketOpportunityLookbackDays: 5,
    },

    aiBuying: {
      // Phase 6 AI buying (§28-§34). Weights are starting points tuned in
      // Phase 11; ranges come from the plan's suggested values.
      needScore: {
        // No viable senior starter at the position.
        noViableStarter: 50,
        // Below the required positional depth.
        belowRequiredDepth: 40,
        // Current starter is well below the desired level.
        starterBelowDesired: 25,
        // Backup is weak (senior present but below the depth floor).
        weakBackup: 15,
        // Ageing starter that needs eventual replacement.
        ageingStarter: 10,
        // Position is already strong/deep — discourages buying.
        alreadyStrong: -40,
      },
      // Desired number of senior players per position (used by need scoring).
      desiredDepthPerPosition: [2, 3, 3, 3, 3],
      // Players below this overall count as "inadequate" at a position.
      adequateOverallFloor: 60,
      // A starter below floor + this offset triggers starter-below-desired (§28).
      starterBelowDesiredOffset: 10,
      // At least floor + this surplus is "already strong" (§28).
      alreadyStrongSurplus: 2,
      // Upgrade gain below this ratio is treated as "does not improve the squad"
      // unless the positional need is severe (§29).
      upgradeGainFloor: 1.02,
      // Age at which a starter is considered "ageing" (§28).
      ageingBuyAge: 30,
      // Player-value multiplier applied to the base valuation for position need.
      needMultiplierRange: [0.95, 1.3],
      // Player-value multiplier applied for how much the target upgrades the squad.
      upgradeMultiplierRange: [0.95, 1.2],
      // Deterministic valuation noise multiplier bounds (§32).
      valuationNoiseRange: [0.95, 1.05],
      // Number of AI clubs that evaluate active listings per worker tick.
      clubsPerTick: 4,
      // AI evaluates active listings at most this often (real-time minutes).
      evaluationIntervalMinutes: 60,
      // Maximum active listings a club evaluates per run.
      maxListingsPerRun: 8,
    },

    // Recent-trade opening-price base (§48/§64.1). A player's own last
    // permanent trade price blends toward player.value over this many league
    // rounds played by the current owner. 0 => base is always player.value.
    recentTrade: {
      fadeOverGames: 6,
    },

    // Seller-defined opening-price range as a fraction of the base value
    // (§64.1). 60%–100% prevents artificially cheap funneling while letting
    // competitive bidding reach the max-bid cap. Sellers almost always choose
    // the maximum, so the default opening (the max) = the player's value.
    auctionOpeningRange: {
      minValueRatio: 0.6,
      maxValueRatio: 1.0,
    },

    // Transfer sales tax (review B1): a fraction of every club-to-club final
    // price that is burned at settlement (paid by neither club — it leaves the
    // economy). The primary structural money sink now that stadium/ticket
    // revenue is gone; it scales with market activity and hits the richest
    // clubs hardest.
    transferTax: {
      rate: 0.05,
    },

    loans: {
      exposureMinutes: 30,
      // Lender-chosen claim fee (§55): a fraction of the player's value within
      // this band, snapshotted at listing time and paid by the borrower to the
      // lender at claim.
      feeMinValueRatio: 0.1,
      feeMaxValueRatio: 0.3,
      // Maximum players one club may hold on loan at once.
      maxLoanedInPerClub: 5,
    },
  } as const;

  export type MarketConfig = typeof MARKET_CONFIG;

  // Multiplayer settings, all tunable without code changes. Kept out of the
  // strict game.config schema because they may not exist in older config files.
export const MP_CONFIG = {
  // Fraction of rounds after which no new humans may join the current season.
  joinThresholdPercent: 0.5,
  // UTC hour at which every scheduled round kicks off (GLOBAL_FIXED mode).
  matchKickoffHourUtc: 20,
  // Preferred-time scheduling: the day is divided into half-hour slots and
  // humans pick at least `minPreferredSlots` of them (8 hours). Fixture
  // kickoffs are optimized inside these slots; the configured
  // scheduler.leagueMatchStartUtc remains the tie-break anchor.
  preferredSlotMinutes: 30,
  slotsPerDay: 48,
  minPreferredSlots: 16,
  // Scheduling supports both the globally synchronized kickoff and a fixed
  // local hour for each division.  Fixture timestamps are always persisted in
  // UTC, so changing this setting affects only newly generated schedules.
  matchTimeMode: "DIVISION_LOCAL_KICKOFF" as "GLOBAL_FIXED_KICKOFF" | "DIVISION_LOCAL_KICKOFF",
  // Real minutes a scheduled live league match takes to play out. This paces
  // how quickly the worker advances in-progress live matches.
  matchDurationMinutes: 10,
  // How often (ms) the worker loop wakes up.
  workerIntervalMs: 5000,
  // How many match-minutes to advance per worker tick for an in-progress match.
  liveAdvanceMinutesPerTick: 1,
  // Idempotency guard: only one UTC day's daily tick runs per key.
  dailyTickHourUtc: 0,
  // Season budget economy (plans/1. multiplayer.md §17A).
  minimumTierBudgetRatio: 0.3,
  tierBudgetDecayRate: 0.55,
  // Inactivity thresholds by tier (days), per plan §41.
  inactivityThresholds: { 1: 42, 2: 35, default: 28 },
  // Multiplayer club/player generation baselines used to seed budgets.
  expectedSeniorSquadSize: 25,
  expectedMeaningfulSigningsPerSeason: 2,
  // Starting cash for a brand-new human club. The season budget is the only
  // initial funding; keep at 0 so new accounts cannot inject untracked cash.
  newClubStartingCash: 0,
  // Outbound-market lock: a new club may not list players for sale or loan
  // until it has played this many of its own league matches (anti-funnel).
  newClubSellLockMatches: 3,
} as const;

/** Human-club Elo settings. Elo is intentionally hidden from player-facing APIs. */
export const ELO_CONFIG = {
  initial: 1500,
  scale: 400,
  kFactor: 24,
  homeAdvantage: 60,
  seasonRetention: 0.9,
  costEpsilon: 0.000001,
} as const;

export type GameConfig = z.infer<typeof gameConfigSchema> & {
  roundsPerSeason: number;
  matchSpacingDays: number;
  lastLeagueMatchDayIndex: number;
  seasonDays: number;
};

const DEFAULT_GAME_CONFIG: GameConfig = {
  league: { teams: 8, turns: 2, startDay: 1, restDaysBetweenMatches: 1 },
  interseasonDays: 7,
  interseasonAfterMatchDays: 2,
  interseasonBeforeNextSeasonDays: 5,
  scheduler: { gameDayRolloverUtc: "00:00", leagueMatchStartUtc: "19:00", leaseSeconds: 30 },
  economy: { referenceSeasonDays: 30 },
  payrollIntervalDays: 7,
  weeklyIntervalDays: 7,
  freeAgentRetentionDays: 30,
  contractWarningSeasons: 2,
  playerValueBase: 500000,
  playerValueOverallReference: 50,
  playerValueOverallExponent: 3.5,
  playerValueMultiplier: 1,
  playerValueAgeCurve: {
    16: 0.65, 17: 0.72, 18: 0.8, 19: 0.88, 20: 0.95, 21: 1.03, 22: 1.1, 23: 1.14,
    24: 1.15, 25: 1.15, 26: 1.15, 27: 1.12, 28: 1.05, 29: 0.97, 30: 0.9, 31: 0.8,
    32: 0.7, 33: 0.6, 34: 0.5, 35: 0.4, 36: 0.3, 37: 0.22, 38: 0.15, 39: 0.1, 40: 0.08,
  },
  playerValueContractNeutralSeasons: 3,
  playerValueContractWeight: 0.05,
  playerValueContractMinMultiplier: 0.9,
  playerValueContractMaxMultiplier: 1.1,
  salaryBase: 70000,
  salaryOverallReference: 50,
  salaryOverallExponent: 2.5,
  salaryMultiplier: 1,
  salaryAgeCurve: {
    16: 0.5, 17: 0.6, 18: 0.7, 19: 0.8, 20: 0.9, 21: 1, 22: 1.05, 23: 1.1,
    24: 1.1, 25: 1.1, 26: 1.1, 27: 1.1, 28: 1.05, 29: 1, 30: 0.95, 31: 0.9,
    32: 0.85, 33: 0.8, 34: 0.75, 35: 0.7, 36: 0.65, 37: 0.6, 38: 0.55, 39: 0.5, 40: 0.45,
  },
  salaryFloor: 500,
  academySalaryMultiplier: 0.1,
  maxContractSeasons: 5,
  renewalMinRaise: 0.02,
  renewalSkillRaiseWeight: 0.08,
  renewalSkillExponent: 1.6,
  renewalMaxRaise: 0.15,
  renewalAgeCurve: {
    16: 1.15, 17: 1.2, 18: 1.3, 19: 1.35, 20: 1.3, 21: 1.2, 22: 1.1, 23: 1,
    24: 1, 25: 1, 26: 1, 27: 1, 28: 1, 29: 0.95, 30: 0.9, 31: 0.85, 32: 0.8,
    33: 0.75, 34: 0.7, 35: 0.65, 36: 0.6, 37: 0.55, 38: 0.5, 39: 0.45, 40: 0.4,
  },
  releaseClauseRemainingValuePct: 0.5,
  // Division-driven player quality (plans/4. player-generation.md §68). These
  // are the only three designer-facing quality-balance knobs; the top/bottom
  // division means and all age baselines are derived mathematically from them.
  playerGeneration: {
    playerQualitySpreadFraction: 0.06,
    divisionSpanSigmas: 3.0,
    academyPedigreeSigmas: 0.3,
  },
  playerGenerationRules: {
    initialSeniorSquadSize: 28,
    initialAcademySize: 8,
    academyRosterLimit: 12,
    seasonalAcademyIntake: 2,
    academyMinAge: 16,
    academyMaxAge: 19,
    academyPromotionAge: 21,
    academyContractSeasons: 4,
  },
  matchSimulator: {
    influence: { team: 0.4, tactics: 0.35, luck: 0.25 },
  },
  roundsPerSeason: 14,
  matchSpacingDays: 2,
  lastLeagueMatchDayIndex: 27,
  seasonDays: 35,
};

/** Validates a raw config object against the game config schema (throws on failure). */
export function parseGameConfig(raw: unknown): GameConfig {
  // Accept the pre-overhaul shape as an input migration convenience. The
  // shipped config and all runtime values use the derived calendar fields;
  // legacy `seasonDays` is never read by the game after this normalization.
  let normalized = raw as Record<string, unknown>;
  if (normalized && typeof normalized === "object") {
    const legacy = normalized as Record<string, unknown>;
    const legacyLeague = (legacy.league ?? {}) as Record<string, unknown>;
    const seasonDays = Number(legacy.seasonDays);
    const matchIntervalDays = Number(legacyLeague.matchIntervalDays);
    const hasLegacyShape = "seasonDays" in legacy || Number.isFinite(matchIntervalDays);
    if (hasLegacyShape) {
      const restDays = Number.isFinite(matchIntervalDays) ? matchIntervalDays - 1 : Number(legacyLeague.restDaysBetweenMatches ?? 0);
      const last = Number(legacyLeague.startDay ?? 0) + (Number(legacyLeague.turns ?? 0) * (Number(legacyLeague.teams ?? 0) - 1) - 1) * (restDays + 1);
      if (!Number.isFinite(seasonDays)) {
        // Old interval-only configs did not carry a separate duration. Keep the
        // canonical seven-day remainder unless the config already supplied one.
        normalized = {
          ...legacy,
          league: { ...legacyLeague, restDaysBetweenMatches: restDays },
          interseasonDays: legacy.interseasonDays ?? 7,
          scheduler: legacy.scheduler ?? { gameDayRolloverUtc: "00:00", leagueMatchStartUtc: "19:00", leaseSeconds: 30 },
          economy: legacy.economy ?? { referenceSeasonDays: 30 },
        };
        delete (normalized.league as Record<string, unknown>).matchIntervalDays;
      } else {
        if (seasonDays <= last) throw new Error(`Invalid game.config.jsonc: lastMatchDay (${last}) must be < seasonDays (${seasonDays})`);
        const gap = seasonDays - (last + 1);
        const explicitAfter = Number(legacy.interseasonAfterMatchDays);
        const explicitBefore = Number(legacy.interseasonBeforeNextSeasonDays);
        const hasAfter = Object.prototype.hasOwnProperty.call(legacy, "interseasonAfterMatchDays");
        const hasBefore = Object.prototype.hasOwnProperty.call(legacy, "interseasonBeforeNextSeasonDays");
        const after = hasAfter ? explicitAfter : hasBefore ? gap - explicitBefore : 0;
        const before = hasBefore ? explicitBefore : gap - after;
        normalized = {
          ...legacy,
          league: { ...legacyLeague, restDaysBetweenMatches: restDays },
          interseasonDays: gap,
          interseasonAfterMatchDays: after,
          interseasonBeforeNextSeasonDays: before,
          scheduler: legacy.scheduler ?? { gameDayRolloverUtc: "00:00", leagueMatchStartUtc: "19:00", leaseSeconds: 30 },
          economy: legacy.economy ?? { referenceSeasonDays: 30 },
        };
        delete normalized.seasonDays;
        delete (normalized.league as Record<string, unknown>).matchIntervalDays;
      }
    }
  }
  const parsed = gameConfigSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Invalid game.config.jsonc: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const data = parsed.data;
  const roundsPerSeason = data.league.turns * (data.league.teams - 1);
  const matchSpacingDays = data.league.restDaysBetweenMatches + 1;
  const lastLeagueMatchDayIndex = data.league.startDay + (roundsPerSeason - 1) * matchSpacingDays;
  return Object.assign(data, {
    roundsPerSeason,
    matchSpacingDays,
    lastLeagueMatchDayIndex,
    seasonDays: lastLeagueMatchDayIndex + 1 + data.interseasonDays,
  });
}

/**
 * Removes `//` and `/* ... *\/` comments from JSONC text while preserving the
 * contents of string literals (so URLs or text containing `//` survive).
 */
export function stripJsoncComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function loadGameConfig(): GameConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "config", "game.config.jsonc");
  try {
    return parseGameConfig(JSON.parse(stripJsoncComments(readFileSync(file, "utf8"))));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid game.config.jsonc")) throw err;
    return DEFAULT_GAME_CONFIG;
  }
}

/** Typed game settings consumed by the game modules (see config/game.config.jsonc). */
export const gameConfig = loadGameConfig();

/** Derived: total number of league match days (rounds). */
export const LEAGUE_MATCH_DAYS = gameConfig.league.turns * (gameConfig.league.teams - 1);

/** Derived: the day of the final league round. */
export const LEAGUE_LAST_MATCH_DAY = gameConfig.lastLeagueMatchDayIndex;

/** Ratio used to preserve the calibrated money-per-game-day rate. */
export function seasonFlowScale(config: Pick<GameConfig, "seasonDays" | "economy"> = gameConfig): number {
  return config.seasonDays / config.economy.referenceSeasonDays;
}

/** Scale an amount calibrated as a reference-season flow. */
export function scaleReferenceSeasonFlow(amount: number, config: Pick<GameConfig, "seasonDays" | "economy"> = gameConfig): number {
  return Math.round(amount * seasonFlowScale(config));
}

/** Parse a configured HH:MM UTC value into its hour component. */
export function configuredUtcHour(value: string): number {
  return Number(value.slice(0, 2));
}
