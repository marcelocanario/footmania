import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

export const PORT = Number(process.env.PORT ?? 3001);
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
export const COOKIE_NAME = "fm_session";

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
    payrollLoanInterestPercent: z.number().int().min(0).max(100),
    stadiumUpgradeDays: z.number().int().min(1),
    contractWarningSeasons: z.number().int().min(1),
    humanMatchDurationMinutes: z.number().int().min(1).max(60),
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
  payrollLoanInterestPercent: 3,
  stadiumUpgradeDays: 15,
  contractWarningSeasons: 2,
  humanMatchDurationMinutes: 10,
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
