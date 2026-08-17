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

const gameConfigSchema = z
  .object({
    seasonDays: z.number().int().min(2),
    league: z.object({
      teams: z.number().int().min(2),
      turns: z.number().int().min(1),
      startDay: z.number().int().min(0),
      matchIntervalDays: z.number().int().min(1),
    }),
    payrollIntervalDays: z.number().int().min(1),
    weeklyIntervalDays: z.number().int().min(1),
    transferIntervalDays: z.number().int().min(1),
    auctionDurationDays: z.number().int().min(1),
    loanDurationSeasons: z.number().int().min(1),
    stadiumUpgradeDays: z.number().int().min(1),
    contractWarningSeasons: z.number().int().min(1),
    humanMatchDurationMinutes: z.number().int().min(1).max(60),
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
  })
  .superRefine((cfg, ctx) => {
    const matchDays = cfg.league.turns * (cfg.league.teams - 1);
    const lastMatchDay = cfg.league.startDay + (matchDays - 1) * cfg.league.matchIntervalDays;
    if (lastMatchDay >= cfg.seasonDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lastMatchDay (${lastMatchDay}) must be < seasonDays (${cfg.seasonDays})`,
        path: ["league"],
      });
    }
  });

export type GameConfig = z.infer<typeof gameConfigSchema>;

const DEFAULT_GAME_CONFIG: GameConfig = {
  seasonDays: 30,
  league: { teams: 8, turns: 2, startDay: 1, matchIntervalDays: 2 },
  payrollIntervalDays: 7,
  weeklyIntervalDays: 7,
  transferIntervalDays: 1,
  auctionDurationDays: 7,
  loanDurationSeasons: 1,
  stadiumUpgradeDays: 15,
  contractWarningSeasons: 2,
  humanMatchDurationMinutes: 10,
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
};

/** Validates a raw config object against the game config schema (throws on failure). */
export function parseGameConfig(raw: unknown): GameConfig {
  const parsed = gameConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid game.config.jsonc: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
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
export const LEAGUE_LAST_MATCH_DAY = gameConfig.league.startDay + (LEAGUE_MATCH_DAYS - 1) * gameConfig.league.matchIntervalDays;
