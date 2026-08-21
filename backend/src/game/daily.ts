import type { Player, World } from "./types";
import { applyDevelopment } from "./player";
import { contractCycle, settlePayroll, weeklyUpdate } from "./season";
import { gameConfig } from "../config";
import { evaluateInactivity } from "./multiplayer";
import { runFinancialIntervention } from "./finance";
import { isEphemeralAI } from "./club";

/**
 * Authoritative game-day processing. The durable scheduler drives one
 * BEGIN_GAME_DAY / PAYROLL_RUN / WEEKLY_SIM_UPDATE triple per season day;
 * every entry point here is clock-based (season day indices) and never
 * consults a civil calendar.
 */

export const DAILY_TICK = "DAILY_TICK";
export const PAYROLL = "PAYROLL";
export const WEEKLY = "WEEKLY";

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
  // Ephemeral AI clubs are financially inert (invariant #28): they never pay
  // wages and can never enter a financial intervention.
  const wasNegativeBeforePayroll = world.clubs.filter((club) => club.competitionState === "ACTIVE" && !isEphemeralAI(club) && club.cash < 0);
  // Payroll boundaries are human-readable days, while the engine index is
  // zero-based. This gives exactly five boundaries in a 35-day season.
  settlePayrollThroughForGameDay(world, humanDay);
  for (const club of world.clubs) {
    if (club.competitionState !== "ACTIVE" || isEphemeralAI(club)) continue;
    if (!wasNegativeBeforePayroll.some((candidate) => candidate.id === club.id) || club.cash >= 0) continue;
    runFinancialIntervention(world, club, { seasonId: world.mp.seasonId, payrollCycleId: seasonDayIndex, now });
  }
}

/** Run weekly-only systems for a game day, if that day is a weekly boundary. */
export function processGameDayWeekly(world: World, seasonDayIndex: number): void {
  if ((seasonDayIndex + 1) % gameConfig.weeklyIntervalDays !== 0) return;
  weeklyUpdate(world.rng, world);
  contractCycle(world.rng, world);
}

function settlePayrollThroughForGameDay(world: World, humanDay: number): void {
  // Keep the existing payroll implementation authoritative while supplying the
  // canonical one-based boundary for its cumulative rounding calculation.
  const originalDay = world.dayIndex;
  world.dayIndex = humanDay;
  settlePayroll(world.rng, world);
  world.dayIndex = originalDay;
}
