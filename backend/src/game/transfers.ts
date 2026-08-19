import type { Club, Player, World } from "./types";
import { positionCount } from "./club";
import { DAYS_PER_YEAR } from "./constants";
import { resetPayrollPeriod, settlePlayerPayroll } from "./payroll";
import { playerHasActiveListing } from "./market";
import { getImmediateAvailableCash } from "./finance";

const MIN_SQUAD = [3, 4, 4, 5, 4];

export function squadNeeds(club: Club, allPlayers: Player[]): number[] {
  const counts = positionCount(club, allPlayers);
  return counts.map((count, position) => Math.max(0, MIN_SQUAD[position] - count));
}

/** Release a player into the normalized free-agent market lifecycle. */
export function releasePlayer(world: World, player: Player, club: Club): { ok: boolean; error?: string; cost: number } {
  if (player.clubId !== club.id) return { ok: false, error: "Player not in squad", cost: 0 };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "A player with an active market listing cannot be released", cost: 0 };
  }
  const cost = player.isYouth ? 0 : Math.max(0, player.releaseClause);
  // §9: a new immediate expense (the release-clause payment) requires actual
  // unreserved cash; binding bid reservations are not spendable.
  if (cost > getImmediateAvailableCash(world, club)) {
    return { ok: false, error: "The club cannot afford to release this player", cost };
  }

  settlePlayerPayroll(world, player);
  club.cash -= cost;
  if (cost > 0) {
    club.ledger.expense.push({ code: 2, amount: cost, day: world.dayIndex, label: `Release clause: ${player.name}` });
  }
  player.clubId = null;
  resetPayrollPeriod(player, world.dayIndex);
  player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  world.news.push({
    dayIndex: world.dayIndex,
    text: `${player.name} was released by ${club.name} as a free agent`,
    kind: "contract",
    clubId: club.id,
  });
  return { ok: true, cost };
}
