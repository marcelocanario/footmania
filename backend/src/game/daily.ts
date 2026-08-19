import type { Player, World } from "./types";
import { chance } from "./rng";
import { applyDevelopment } from "./player";
import { isIntervalDay } from "./calendar";
import { contractCycle, loanCycle, settlePayroll, stadiumCycle, weeklyUpdate } from "./season";
import { gameConfig } from "../config";
import { evaluateInactivity } from "./multiplayer";

/**
 * Date-aware daily processing (worker plan §2/§3).
 *
 * A season is one calendar month, so the in-game day-of-month equals the
 * calendar day. `processDailyDate` drives development, payroll, weekly
 * updates, contracts, loans, stadiums, inactivity evaluation and daily AI
 * activity for an explicit UTC date. It never reads `Date.now()` internally so
 * historical catch-up dates are processed faithfully.
 */

export const DAILY_TICK = "DAILY_TICK";
export const PAYROLL = "PAYROLL";
export const WEEKLY = "WEEKLY";
export const NOTIFICATIONS = "NOTIFICATIONS";

/** "YYYY-MM-DD" for a UTC instant. */
export function utcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse a "YYYY-MM-DD" key into the UTC start-of-day instant. */
export function parseDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date key: ${key}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function isValidDateKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/**
 * The sequence of UTC dates from the day after `lastProcessed` through `now`
 * (inclusive), as "YYYY-MM-DD" strings. When `lastProcessed` is null the
 * sequence starts at the beginning of `now`'s calendar month so we never
 * fabricate state for months that predate the world's season.
 */
export function missingDailyDates(lastProcessed: string | null, now: Date): string[] {
  const todayKey = utcDateKey(now);
  const first = lastProcessed
    ? new Date(Date.UTC(Number(lastProcessed.slice(0, 4)), Number(lastProcessed.slice(5, 7)) - 1, Number(lastProcessed.slice(8, 10)) + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dates: string[] = [];
  const cursor = new Date(first);
  for (let guard = 0; guard < 370; guard++) {
    const key = utcDateKey(cursor);
    if (key > todayKey) break;
    dates.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export interface DailyResult {
  /** execution types that actually ran for this date (for the ledger). */
  executed: string[];
}

function dailyDevelopment(world: World) {
  const squads = new Map<number, Player[]>();
  for (const p of world.players) {
    if (p.clubId === null) continue;
    let squad = squads.get(p.clubId);
    if (!squad) {
      squad = [];
      squads.set(p.clubId, squad);
    }
    squad.push(p);
  }
  for (const club of world.clubs) {
    const squad = squads.get(club.id);
    if (!squad) continue;
    for (const player of squad) applyDevelopment(world.rng, player, club, world.dayIndex);
  }
}

/**
 * Process a single UTC date. The world must already be positioned in the
 * correct season for `date` (the caller handles month-boundary rollover).
 * `now` is the timestamp of the date being processed (UTC start-of-day) and is
 * used only for activities that anchor to wall-clock time (inactivity).
 */
export function processDailyDate(
  world: World,
  opts: { date: string; now: number }
): DailyResult {
  const { date, now } = opts;
  const day = parseDateKey(date);
  const dayOfMonth = day.getUTCDate();
  const dayOfWeek = day.getUTCDay();

  world.dayIndex = dayOfMonth;
  world.dayOfWeek = dayOfWeek;
  world.year = world.mp.seasonYear;

  const rng = world.rng;
  const executed: string[] = [];

  // Inactivity / abandonment eligibility evaluation runs once per day.
  evaluateInactivity(world, now);
  executed.push(DAILY_TICK);

  for (const p of world.players) {
    if (p.clubId !== null && p.energy < 100) p.energy = Math.min(100, p.energy + 6);
  }
  dailyDevelopment(world);

  if (isIntervalDay(world.dayIndex, gameConfig.payrollIntervalDays)) {
    settlePayroll(rng, world);
    executed.push(PAYROLL);
  }
  if (isIntervalDay(world.dayIndex, gameConfig.weeklyIntervalDays)) {
    weeklyUpdate(rng, world);
    contractCycle(rng, world);
    loanCycle(rng, world);
    executed.push(WEEKLY);
  }
  stadiumCycle(world);

  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE") continue;
    const warningThreshold = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
    const expiring = world.players.filter((p) => p.clubId === club.id && p.contractDays <= warningThreshold && p.contractDays > 0);
    for (const p of expiring) {
      if (chance(rng, 3)) {
        world.news.push({ dayIndex: world.dayIndex, text: `${p.name} (${club.name}) contract expiring soon`, kind: "contract" });
      }
    }
  }

  return { executed };
}