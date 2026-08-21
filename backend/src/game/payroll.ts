import { gameConfig } from "../config";
import type { Player, World } from "./types";
import { isEphemeralAI } from "./club";

/** Starts a new ownership/salary period for a player. */
export function resetPayrollPeriod(player: Player, day: number): void {
  const normalizedDay = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(day)));
  player.payrollPeriodStartDay = normalizedDay;
  player.payrollPaidThroughDay = normalizedDay;
  player.payrollPaidAmount = 0;
}

function normalizePayrollState(player: Player): void {
  if (!Number.isFinite(player.payrollPaidThroughDay)) player.payrollPaidThroughDay = 0;
  if (!Number.isFinite(player.payrollPaidAmount)) player.payrollPaidAmount = 0;
  if (!Number.isFinite(player.payrollPeriodStartDay)) player.payrollPeriodStartDay = 0;
  player.payrollPeriodStartDay = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(player.payrollPeriodStartDay)));
  player.payrollPaidThroughDay = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(player.payrollPaidThroughDay)));
  player.payrollPaidAmount = Math.max(0, Math.round(player.payrollPaidAmount));
}

/** Accrues and deducts one player's wages through `throughDay`. */
export function settlePlayerPayroll(world: World, player: Player, throughDay = world.dayIndex): number {
  normalizePayrollState(player);
  // Provisional and dormant clubs do not pay salaries (plan §19/§47). Their
  // players keep accruing age/development but the wage clock stays frozen.
  // Ephemeral filler-AI clubs are financially inert (invariant #28): no wages
  // are ever charged to them and their cash never changes.
  if (player.clubId !== null) {
    const club = world.clubs.find((candidate) => candidate.id === player.clubId);
    if (club && isEphemeralAI(club)) return 0;
    if (club && club.competitionState !== "ACTIVE") return 0;
  }
  const startDay = player.payrollPaidThroughDay;
  const endDay = Math.max(startDay, Math.min(gameConfig.seasonDays, Math.trunc(throughDay)));
  const target = Math.round((player.salary * (endDay - player.payrollPeriodStartDay)) / gameConfig.seasonDays);
  const amount = Math.max(0, target - player.payrollPaidAmount);
  player.payrollPaidThroughDay = endDay;
  player.payrollPaidAmount = target;
  if (amount <= 0 || player.clubId === null) return 0;

  const club = world.clubs.find((candidate) => candidate.id === player.clubId);
  if (!club) return 0;
  club.cash -= amount;
  club.ledger.expense.push({ code: 4, amount, day: world.dayIndex, label: "Player salaries" });
  return amount;
}

/** Settles the current payroll period for all contracted players. */
export function settlePayrollThrough(world: World, throughDay = world.dayIndex): Map<number, number> {
  const salaries = new Map<number, number>();
  for (const player of world.players) {
    if (player.clubId === null) continue;
    const amount = settlePlayerPayroll(world, player, throughDay);
    if (amount > 0) salaries.set(player.clubId, (salaries.get(player.clubId) ?? 0) + amount);
  }
  return salaries;
}
