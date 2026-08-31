import type { Club, Player, World } from "./types";
import { DAYS_PER_YEAR } from "./constants";
import { resetPayrollPeriod, settlePlayerPayroll } from "./payroll";
import { playerHasActiveListing } from "./market";
import { prepareFreeAgentListing } from "./freeAgents";
import { getImmediateAvailableCash } from "./finance";
import { publishNews } from "./news";
import { msg } from "../i18n/catalog";

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

  const prepared = player.isYouth
    ? null
    : prepareFreeAgentListing(world, player, { allowOwnedPlayer: true });
  if (prepared && !prepared.ok) return { ok: false, error: prepared.error, cost };

  settlePlayerPayroll(world, player);
  club.cash -= cost;
  if (cost > 0) {
    club.ledger.expense.push({ code: 2, amount: cost, day: world.dayIndex, label: `Release clause: ${player.name}` });
  }
  player.clubId = null;
  resetPayrollPeriod(player, world.dayIndex);
  player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
  player.starter = false;
  player.starter = false;
  player.onSale = false;
  if (prepared?.ok) world.freeAgentListings.push(prepared.listing);
  publishNews(world, {
    kind: "contract",
    recipientClubId: club.id,
    headline: "news.headline.squadUpdate",
    body: cost > 0
      ? msg("news.releasePaid", { player: player.name, club: club.name, cost })
      : msg("news.releaseFree", { player: player.name, club: club.name }),
  });
  return { ok: true, cost };
}
