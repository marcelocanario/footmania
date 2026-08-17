import type { Club, Player, RngState, World } from "./types";
import { chance, nextInt, pick } from "./rng";
import { positionCount } from "./club";
import { generatePlayer } from "./player";
import { generateName } from "./names";
import { DAYS_PER_YEAR } from "./constants";

const MIN_SQUAD = [3, 4, 4, 5, 4];
const SURPLUS_MARKUP = [0.5, 0.2, 0.2, 0.2, 0.5, 1.0];
const RARE_MARKUP = [1.5, 1.5, 1.5, 1.5, 2.0, 1.0];
const NORMAL_MARKUP = [1.0, 1.0, 1.0, 1.0, 1.5, 2.0];
const SURPLUS_DISCOUNT = [15, 20, 20, 10, 10, 2];

/** Brasfoot free agents do not have a transfer fee; they ask for a one-time
 * signing bonus based on their salary, with better players asking for more. */
export function freeAgentSigningBonus(player: Pick<Player, "salary" | "overall">): number {
  const overall = Math.max(0, Math.min(100, player.overall));
  const multiplier = 1.5 + overall / 40;
  return Math.max(1, Math.round(player.salary * multiplier));
}

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
  if (player.releaseClause > 0 && bid >= player.releaseClause) {
    return { accepted: true, counter: bid };
  }
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
  player.onSale = true;
  player.salePrice = null;
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

export function aiBid(
  rng: RngState,
  club: Club,
  listing: { minBid: number; bids: { clubId: number; amount: number }[] },
  playerValue: number,
  position?: number,
  allPlayers?: Player[],
  availableCash = club.cash
): number | null {
  if (position !== undefined && allPlayers !== undefined) {
    const counts = [0, 0, 0, 0, 0];
    for (const p of allPlayers) {
      if (p.clubId === club.id && !p.isYouth) counts[p.position]++;
    }
    if (counts[position] > MIN_SQUAD[position] + 1) return null;
  }
  const currentMax = listing.bids.length > 0 ? Math.max(...listing.bids.map((b) => b.amount)) : 0;
  const minBid = listing.minBid;
  const ceiling = minBid * 2.5;
  let bid: number;
  if (currentMax > 0) {
    bid = Math.round(currentMax * (1.02 + nextInt(rng, 8) / 100));
  } else {
    bid = Math.max(minBid, Math.round(minBid * (0.9 + nextInt(rng, 50) / 100)));
  }
  if (bid > ceiling) return null;
  if (bid <= currentMax) return null;
  if (bid > availableCash) return null;
  return bid;
}

/** Cash already committed to bids on other active auctions. */
export function auctionReservedCash(world: World, clubId: number, excludeAuctionId?: number): number {
  return world.auctions.reduce((sum, auction) => {
    if (auction.id === excludeAuctionId) return sum;
    const bid = auction.bids.find((b) => b.clubId === clubId);
    return sum + (bid?.amount ?? 0);
  }, 0);
}

export function auctionAvailableCash(world: World, clubId: number, excludeAuctionId?: number): number {
  const club = world.clubs.find((c) => c.id === clubId);
  if (!club) return 0;
  return club.cash - auctionReservedCash(world, clubId, excludeAuctionId);
}

export function isEligibleAuctionBidder(
  listing: { sellerClubId: number | null; bids: { clubId: number }[] },
  club: Club
): boolean {
  if (club.isHuman) return false;
  // Auction bidding requires the financial sophistication of a rep >= 3 club;
  // lower-reputation clubs shop the free-agent market instead (aiBuyGaps).
  if (club.reputation < 3) return false;
  if (listing.sellerClubId !== null && club.id === listing.sellerClubId) return false;
  if (listing.bids.some((b) => b.clubId === club.id)) return false;
  return true;
}

export function resolveAuction(world: World, listingId: number): number | null {
  const idx = world.auctions.findIndex((a) => a.id === listingId);
  if (idx < 0) return null;
  const listing = world.auctions[idx];
  world.auctions.splice(idx, 1);
  const player = world.players.find((p) => p.id === listing.playerId);
  if (listing.bids.length === 0) {
    if (player) player.onSale = false;
    return null;
  }
  if (!player) return null;
  const best = [...listing.bids]
    .sort((a, b) => b.amount - a.amount)
    .find((bid) => bid.amount <= auctionAvailableCash(world, bid.clubId, listing.id));
  if (!best) {
    player.onSale = false;
    return null;
  }
  const buyer = world.clubs.find((c) => c.id === best.clubId);
  if (buyer && transferPlayer(world, player, buyer, best.amount)) {
    return best.clubId;
  }
  player.onSale = false;
  return null;
}

export function transferPlayer(world: World, player: Player, toClub: Club, fee: number): boolean {
  if (!Number.isFinite(fee) || fee < 0 || toClub.cash < fee) return false;
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
  return true;
}

export function generateFreeAgents(rng: RngState, world: World, count: number) {
  for (let i = 0; i < count; i++) {
    const club = pick(rng, world.clubs);
    const player = generatePlayer(rng, club, { id: world.nextId++, seed: world.seed });
    player.clubId = null;
    player.contractDays = Math.max(1, Math.round(DAYS_PER_YEAR / 2));
    player.age = 18 + nextInt(rng, 12);
    player.isYouth = false;
    player.name = generateName(rng, club.country);
    world.players.push(player);
  }
}

export function aiSellSurplus(rng: RngState, world: World, club: Club) {
  const roster = world.players.filter((p) => p.clubId === club.id && !p.isStar && !p.worldClass && !p.onSale);
  const counts = positionCount(club, world.players);
  for (const p of roster) {
    if (counts[p.position] > MIN_SQUAD[p.position] + 1) {
      if (chance(rng, 30)) {
        const price = counterOffer(club, p, world.players);
        if (p.clubId !== null) {
          const buyer = findBuyer(rng, world, p);
          if (buyer) {
            const fee = Math.max(1, Math.round(price * 0.9));
            if (transferPlayer(world, p, buyer, fee)) {
              world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed ${p.name} from ${club.name}`, kind: "transfer" });
            }
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
  // Free-agent signings are open to rep >= 2 clubs; the single rep-1 minnow
  // rebuilds via academy and the free rollover squad top-up instead.
  if (club.reputation < 2) return;
  const seasonalWages = world.players
    .filter((p) => p.clubId === club.id)
    .reduce((s, p) => s + p.salary, 0);
  const needs = squadNeeds(club, world.players);
  for (let pos = 0; pos < 5; pos++) {
    if (needs[pos] > 0 && chance(rng, 40)) {
      const candidates = world.players.filter(
        (p) => p.clubId === null && p.position === pos && freeAgentSigningBonus(p) < club.cash * 0.5
      );
      if (candidates.length > 0) {
        const sorted = candidates.sort((a, b) => b.overall - a.overall);
        const target = sorted[0];
        const price = freeAgentSigningBonus(target);
        if (club.cash - price < seasonalWages) continue;
        if (transferPlayer(world, target, club, price)) {
          world.news.push({ dayIndex: world.dayIndex, text: `${club.name} signed ${target.name}`, kind: "transfer" });
        }
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
      if (transferPlayer(world, player, buyer, player.salePrice!)) {
        player.onSale = false;
        player.salePrice = null;
        world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} bought ${player.name} from ${seller.name}`, kind: "transfer" });
      }
    }
  }
}

export function keepFreeAgentPool(rng: RngState, world: World) {
  const current = world.players.filter((p) => p.clubId === null).length;
  if (current >= 15) return;
  generateFreeAgents(rng, world, 3);
}
