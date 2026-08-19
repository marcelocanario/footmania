import type { Club, Player, World } from "./types";
import { positionCount } from "./club";
import { DAYS_PER_YEAR } from "./constants";
import { resetPayrollPeriod, settlePlayerPayroll } from "./payroll";
import { createFreeAgentListing } from "./freeAgents";
import { playerHasActiveListing } from "./market";

const MIN_SQUAD = [3, 4, 4, 5, 4];

export function squadNeeds(club: Club, allPlayers: Player[]): number[] {
  const counts = positionCount(club, allPlayers);
  return counts.map((c, i) => Math.max(0, MIN_SQUAD[i] - c));
}

/** Free-agent days granted when a player leaves a club (release or expiry). */
const FREE_AGENT_DAYS = Math.max(1, Math.round(DAYS_PER_YEAR / 2));

/**
 * Releases a player from the human club's squad. For senior players the club
 * pays the release clause; youth players can always be released for free. The
 * player becomes a free agent and immediately enters the free-agent market
 * (§42).
 */
export function releasePlayer(world: World, player: Player, club: Club): { ok: boolean; error?: string; cost: number } {
  if (player.clubId !== club.id) return { ok: false, error: "Player not in squad", cost: 0 };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "A player with an active market listing cannot be released", cost: 0 };
  }
  const cost = player.isYouth ? 0 : Math.max(0, player.releaseClause);
  if (cost > club.cash) return { ok: false, error: "The club cannot afford to release this player", cost };
  settlePlayerPayroll(world, player);
  club.cash -= cost;
  if (cost > 0) {
    club.ledger.expense.push({ code: 2, amount: cost, day: world.dayIndex, label: `Release clause: ${player.name}` });
  }
  player.clubId = null;
  resetPayrollPeriod(player, world.dayIndex);
  player.contractDays = FREE_AGENT_DAYS;
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  // §42: released players immediately enter the free-agent market.
  createFreeAgentListing(world, player);
  world.news.push({
    dayIndex: world.dayIndex,
    text: `${player.name} was released by ${club.name} as a free agent`,
    kind: "contract",
    clubId: club.id,
  });
  return { ok: true, cost };
}
