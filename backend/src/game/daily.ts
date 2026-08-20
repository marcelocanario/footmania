import type { Player, World } from "./types";
import { chance } from "./rng";
import { applyDevelopment } from "./player";
import { isIntervalDay } from "./calendar";
import { contractCycle, loanCycle, settlePayroll, stadiumCycle, weeklyUpdate } from "./season";
import { gameConfig } from "../config";
import { evaluateInactivity } from "./multiplayer";
import { runFinancialIntervention } from "./finance";

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
    // One-payroll-cycle grace period (financial-control §19/§20): a club that
    // was already cash-negative BEFORE this payroll and remains cash-negative
    // AFTER it enters financial intervention. A payroll that merely pushes a
    // previously positive club negative only warns (NEGATIVE_CASH display).
    const wasNegativeBeforePayroll = world.clubs.filter((club) => club.competitionState === "ACTIVE" && club.cash < 0);
    settlePayroll(rng, world);
    executed.push(PAYROLL);
    for (const club of world.clubs) {
      if (club.competitionState !== "ACTIVE") continue;
      const wasNegative = wasNegativeBeforePayroll.some((c) => c.id === club.id);
      if (wasNegative && club.cash < 0) {
        const intervention = runFinancialIntervention(world, club, {
          seasonId: world.mp.seasonId,
          payrollCycleId: world.dayIndex,
          now: now,
        });
        // `executed` is a per-date ledger, not a per-club result. Multiple
        // clubs may enter intervention on the same payroll date, but the
        // DailyExecution key permits only one row for this execution type.
        if (intervention.ok && !executed.includes("FINANCIAL_INTERVENTION")) {
          executed.push("FINANCIAL_INTERVENTION");
        }
      }
    }
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

/** Process one authoritative game day. Unlike the legacy date replay helper,
 * this function never consults a civil calendar or month length. */
export function processGameDay(world: World, seasonDayIndex: number, now = Date.now()): DailyResult {
  const result = processGameDayStart(world, seasonDayIndex, now);
  if ((seasonDayIndex + 1) % gameConfig.payrollIntervalDays === 0) {
    processGameDayPayroll(world, seasonDayIndex, now);
    result.executed.push(PAYROLL);
  }
  if ((seasonDayIndex + 1) % gameConfig.weeklyIntervalDays === 0) {
    processGameDayWeekly(world, seasonDayIndex);
    result.executed.push(WEEKLY);
  }
  processGameDayEnd(world);
  return result;
}

/** Run daily systems that belong to the beginning of a game day. */
export function processGameDayStart(world: World, seasonDayIndex: number, now = Date.now()): DailyResult {
  if (seasonDayIndex < 0 || seasonDayIndex >= gameConfig.seasonDays) throw new Error(`Invalid season day index: ${seasonDayIndex}`);
  world.dayIndex = seasonDayIndex;
  world.dayOfWeek = ((world.mp.absoluteGameDay ?? seasonDayIndex) % 7 + 7) % 7;
  world.year = world.mp.seasonNumber ?? world.year;
  const executed: string[] = [DAILY_TICK];
  evaluateInactivity(world, now);
  for (const player of world.players) {
    if (player.clubId !== null && player.energy < 100) player.energy = Math.min(100, player.energy + 6);
  }
  dailyDevelopment(world);
  return { executed };
}

/** Run the payroll event for a game day, if that day is a payroll boundary. */
export function processGameDayPayroll(world: World, seasonDayIndex: number, now = Date.now()): void {
  const humanDay = seasonDayIndex + 1;
  if (humanDay % gameConfig.payrollIntervalDays !== 0) return;
  const wasNegativeBeforePayroll = world.clubs.filter((club) => club.competitionState === "ACTIVE" && club.cash < 0);
  // Payroll boundaries are human-readable days, while the engine index is
  // zero-based. This gives exactly five boundaries in a 35-day season.
  settlePayrollThroughForGameDay(world, humanDay);
  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE") continue;
    if (!wasNegativeBeforePayroll.some((candidate) => candidate.id === club.id) || club.cash >= 0) continue;
    runFinancialIntervention(world, club, { seasonId: world.mp.seasonId, payrollCycleId: seasonDayIndex, now });
  }
}

/** Run weekly-only systems for a game day, if that day is a weekly boundary. */
export function processGameDayWeekly(world: World, seasonDayIndex: number): void {
  if ((seasonDayIndex + 1) % gameConfig.weeklyIntervalDays !== 0) return;
  weeklyUpdate(world.rng, world);
  contractCycle(world.rng, world);
  loanCycle(world.rng, world);
}

/** Run systems that complete the current game day. */
export function processGameDayEnd(world: World): void {
  stadiumCycle(world);
}

function settlePayrollThroughForGameDay(world: World, humanDay: number): void {
  // Keep the existing payroll implementation authoritative while supplying the
  // canonical one-based boundary for its cumulative rounding calculation.
  const originalDay = world.dayIndex;
  world.dayIndex = humanDay;
  settlePayroll(world.rng, world);
  world.dayIndex = originalDay;
}
