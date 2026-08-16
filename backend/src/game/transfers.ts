import type { Club, Player, RngState, World } from "./types";
import { chance, nextInt, pick } from "./rng";
import { positionCount } from "./club";
import { generatePlayer } from "./player";
import { generateName } from "./names";

const MIN_SQUAD = [3, 4, 4, 5, 4];
const SURPLUS_MARKUP = [0.5, 0.2, 0.2, 0.2, 0.5, 1.0];
const RARE_MARKUP = [1.5, 1.5, 1.5, 1.5, 2.0, 1.0];
const NORMAL_MARKUP = [1.0, 1.0, 1.0, 1.0, 1.5, 2.0];
const SURPLUS_DISCOUNT = [15, 20, 20, 10, 10, 2];

export function squadNeeds(club: Club, allPlayers: Player[]): number[] {
  const counts = positionCount(club, allPlayers);
  return counts.map((c, i) => Math.max(0, MIN_SQUAD[i] - c));
}

export function counterOffer(club: Club, player: Player, allPlayers: Player[]): number {
  const counts = positionCount(club, allPlayers);
  const pos = player.position;
  if (counts[pos] >= MIN_SQUAD[pos]) {
    if (player.overall < 30 || player.age > 35) {
      return player.value - Math.round((player.value * SURPLUS_DISCOUNT[pos]) / 100);
    }
    return player.value + Math.round(player.value * SURPLUS_MARKUP[pos]);
  }
  if (counts[pos] === 1) {
    return player.value + Math.round(player.value * RARE_MARKUP[pos]);
  }
  return player.value + Math.round(player.value * NORMAL_MARKUP[pos]);
}

export function evaluateBid(
  rng: RngState,
  player: Player,
  bid: number,
  seller: Club,
  buyer: Club,
  allPlayers: Player[]
): { accepted: boolean; counter: number } {
  if (player.isStar || player.worldClass) {
    if (bid < counterOffer(seller, player, allPlayers)) {
      return { accepted: false, counter: Math.round(counterOffer(seller, player, allPlayers) * 1.3) };
    }
    return { accepted: true, counter: bid };
  }
  if (seller.isHuman) {
    const target = counterOffer(seller, player, allPlayers);
    return { accepted: bid >= target, counter: target };
  }
  const target = counterOffer(seller, player, allPlayers);
  if (bid >= target) return { accepted: true, counter: bid };
  if (bid >= target * 0.6 && chance(rng, 40)) {
    return { accepted: true, counter: bid };
  }
  return { accepted: false, counter: Math.round(target * 0.85) };
}

export function createAuction(rng: RngState, world: World, playerId: number, sellerClubId: number | null, deadlineDay: number): number {
  const player = world.players.find((p) => p.id === playerId);
  if (!player) return -1;
  const listing = {
    id: world.nextId++,
    playerId,
    minBid: Math.max(1, Math.round(player.value * 0.5)),
    deadlineDay,
    sellerClubId,
    bids: [] as { clubId: number; amount: number }[],
  };
  world.auctions.push(listing);
  return listing.id;
}

export function aiBid(rng: RngState, club: Club, listing: { minBid: number; bids: { clubId: number; amount: number }[] }, playerValue: number): number | null {
  const currentMax = listing.bids.length > 0 ? Math.max(...listing.bids.map((b) => b.amount)) : 0;
  const minBid = listing.minBid;
  const ceiling = minBid * 2.5;
  let bid = Math.round(minBid * (0.45 + nextInt(rng, 38) / 100));
  if (currentMax > 0) bid = Math.round(currentMax * (1.02 + nextInt(rng, 5) / 100));
  if (bid > ceiling) bid = ceiling;
  if (bid <= currentMax) return null;
  if (bid > club.cash) return null;
  return bid;
}

export function resolveAuction(world: World, listingId: number): number | null {
  const idx = world.auctions.findIndex((a) => a.id === listingId);
  if (idx < 0) return null;
  const listing = world.auctions[idx];
  world.auctions.splice(idx, 1);
  if (listing.bids.length === 0) return null;
  const best = [...listing.bids].sort((a, b) => b.amount - a.amount)[0];
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player) return null;
  const buyer = world.clubs.find((c) => c.id === best.clubId);
  const seller = listing.sellerClubId ? world.clubs.find((c) => c.id === listing.sellerClubId) : null;
  if (buyer) {
    buyer.cash -= best.amount;
    if (seller) seller.cash += best.amount;
    transferPlayer(world, player, buyer, best.amount);
  }
  return best.clubId;
}

export function transferPlayer(world: World, player: Player, toClub: Club, fee: number) {
  const from = world.clubs.find((c) => c.id === player.clubId);
  if (from) {
    from.cash += fee;
    from.ledger.income.push({ code: 3, amount: fee, day: world.dayIndex, label: `Transfer fee: ${player.name}` });
  }
  player.clubId = toClub.id;
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  player.salePrice = null;
  toClub.cash -= fee;
  toClub.ledger.expense.push({ code: 1, amount: fee, day: world.dayIndex, label: `Transfer fee: ${player.name}` });
}

export function generateFreeAgents(rng: RngState, world: World, count: number) {
  for (let i = 0; i < count; i++) {
    const club = pick(rng, world.clubs.filter((c) => c.division === 1 || c.division === 2));
    const player = generatePlayer(rng, club, { id: world.nextId++ });
    player.clubId = null;
    player.contractDays = 180;
    player.age = 18 + nextInt(rng, 12);
    player.isYouth = false;
    player.name = generateName(rng, "BRA");
    world.players.push(player);
  }
}

export function aiSellSurplus(rng: RngState, world: World, club: Club) {
  const roster = world.players.filter((p) => p.clubId === club.id && !p.isStar && !p.worldClass);
  const counts = positionCount(club, world.players);
  for (const p of roster) {
    if (counts[p.position] > MIN_SQUAD[p.position] + 1) {
      if (chance(rng, 30)) {
        const price = counterOffer(club, p, world.players);
        if (p.clubId !== null) {
          const buyer = findBuyer(rng, world, p);
          if (buyer) {
            transferPlayer(world, p, buyer, Math.max(1, Math.round(price * 0.9)));
            world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed ${p.name} from ${club.name}`, kind: "transfer" });
          }
        }
      }
    }
  }
}

function findBuyer(rng: RngState, world: World, player: Player): Club | null {
  const candidates = world.clubs.filter((c) => {
    const needs = squadNeeds(c, world.players);
    return needs[player.position] > 0 && c.cash > player.value * 0.7;
  });
  if (candidates.length === 0) return null;
  return pick(rng, candidates);
}

export function aiBuyGaps(rng: RngState, world: World, club: Club) {
  if (club.division > 2) return;
  const monthlySalaries = world.players
    .filter((p) => p.clubId === club.id)
    .reduce((s, p) => s + p.salary, 0);
  const needs = squadNeeds(club, world.players);
  for (let pos = 0; pos < 5; pos++) {
    if (needs[pos] > 0 && chance(rng, 40)) {
      const candidates = world.players.filter((p) => p.clubId === null && p.position === pos && p.value < club.cash * 0.5);
      if (candidates.length > 0) {
        const sorted = candidates.sort((a, b) => b.overall - a.overall);
        const target = sorted[0];
        const price = Math.max(1, Math.round(target.value * 0.9));
        if (club.cash - price < monthlySalaries) continue;
        transferPlayer(world, target, club, price);
        world.news.push({ dayIndex: world.dayIndex, text: `${club.name} signed ${target.name}`, kind: "transfer" });
      }
    }
  }
}

export function aiBuyListings(rng: RngState, world: World) {
  const listings = world.players.filter((p) => p.onSale && p.salePrice !== null && p.clubId !== null);
  for (const player of listings) {
    const seller = world.clubs.find((c) => c.id === player.clubId);
    if (!seller) continue;
    const buyers = world.clubs.filter((c) => {
      const needs = squadNeeds(c, world.players);
      return c.id !== seller.id && needs[player.position] > 0 && c.cash >= player.salePrice!;
    });
    if (buyers.length === 0) continue;
    const buyer = pick(rng, buyers);
    if (chance(rng, 50)) {
      transferPlayer(world, player, buyer, player.salePrice!);
      player.onSale = false;
      player.salePrice = null;
      world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} bought ${player.name} from ${seller.name}`, kind: "transfer" });
    }
  }
}

export function keepFreeAgentPool(rng: RngState, world: World) {
  const current = world.players.filter((p) => p.clubId === null).length;
  if (current >= 15) return;
  generateFreeAgents(rng, world, 3);
}
