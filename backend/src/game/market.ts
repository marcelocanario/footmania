import { MARKET_CONFIG, gameConfig } from "../config";
import type {
  Club,
  FreeAgentListing,
  MarketBid,
  MarketReservation,
  MarketType,
  Player,
  PlayerMarketTransaction,
  TransferAuction,
  World,
} from "./types";
import { calculateContractDemand, contractDaysForTerm, contractDemandOptions, clamp, calculateReleaseClause, remainingSeasonFractionForDay, remainingSeasons } from "./economy";
import { roundForDay } from "./clock";
import { seniorRosterFullError, isEphemeralAI } from "./club";
import { newClubSellLockError } from "./league";
import { settlePlayerPayroll, resetPayrollPeriod } from "./payroll";
import { ensureClubSquadNumbers } from "./squadNumbers";
import { formatMoney, NEWS_SUBJECTS, publishNews } from "./news";

/**
 * Shared marketplace infrastructure (transfer-market-overhaul Phase 2).
 *
 * This module separates market *execution* (proxy bidding, financial
 * validation, reservations, history) from AI *decision-making* (later phases).
 * The AI decides; these services execute. Everything here is pure/engine-side
 * so it can be unit-tested and reused by routes and workers alike.
 */

/** A function returning a club's configured standard division budget. */
export type DivisionBudgetProvider = (club: Club) => number;

// ---------------------------------------------------------------------------
// ProxyBidEngine (§11-14)
// ---------------------------------------------------------------------------

/** Round a value to a "sensible" monetary increment (nearest 1000 up to 1M). */
export function roundToSensibleIncrement(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return Math.round(value / 500_000) * 500_000;
  if (abs >= 1_000_000) return Math.round(value / 50_000) * 50_000;
  if (abs >= 100_000) return Math.round(value / 5_000) * 5_000;
  if (abs >= 10_000) return Math.round(value / 500) * 500;
  return Math.round(value / 50) * 50;
}

/** The bid increment for a listing based on the player's value (§14). */
export function bidIncrementForValue(playerValue: number): number {
  const raw = playerValue * MARKET_CONFIG.transferAuction.bidIncrementRate;
  return Math.max(1, roundToSensibleIncrement(raw));
}

/**
 * Bidder-specific club-to-club maximum (§10/§102.13.3). The cap is asymmetric
 * based on the division GAP between buyer and seller, not configured budgets:
 *   favorableGap = max(0, Dseller - Dbuyer)
 *   normalizedGap = favorableGap / max(1, Dmax - 1)
 *   curve = (1 - exp(-K * normalizedGap)) / (1 - exp(-K))
 *   capMultiplier = BASE + BONUS * curve
 * Same-division or weaker-division buyers stay at the BASE (150%); a stronger
 * division buying from a weaker one relaxes smoothly toward BASE+BONUS (300%).
 */
export function clubTransferCapMultiplier(buyerDivision: number, sellerDivision: number, totalDivisions: number): number {
  const { baseMultiplier, maxBonusMultiplier, curveK } = MARKET_CONFIG.transferAuction.cap;
  const favorableGap = Math.max(0, sellerDivision - buyerDivision);
  const normalizedGap = favorableGap / Math.max(1, totalDivisions - 1);
  const curve =
    normalizedGap <= 0 ? 0 : (1 - Math.exp(-curveK * normalizedGap)) / (1 - Math.exp(-curveK));
  return baseMultiplier + maxBonusMultiplier * curve;
}

/**
 * The bidder-specific maximum allowed by rule for a TRANSFER bid
 * (financial-control §10). For humans this is the club-to-club value cap
 * subject only to the hard immediate-cash rule:
 *
 *   maximumAllowedBid = min(bidderSpecificPlayerValueCap, ImmediateAvailableCash)
 */
export function maximumAllowedBid(
  playerValue: number,
  buyerDivision: number,
  sellerDivision: number,
  totalDivisions: number,
  immediateAvailableCash: number
): number {
  const capMultiplier = clubTransferCapMultiplier(buyerDivision, sellerDivision, totalDivisions);
  return Math.min(playerValue * capMultiplier, immediateAvailableCash);
}

/**
 * Private maximum bids are validated for amount floor/cap and the hard
 * immediate-cash rule (financial-control §9/§10/§11). Returns an error string
 * or the accepted maximum.
 */
export function validateMaxBid(opts: {
  listing: TransferAuction;
  club: Club;
  player: Player;
  proposedMaximum: number;
  buyerDivision: number;
  immediateAvailableCash: number;
  existingBid?: MarketBid;
}): { ok: true; maximum: number } | { ok: false; error: string } {
  const { listing, club, player, proposedMaximum, buyerDivision, immediateAvailableCash } = opts;

  // Invariant #28: ephemeral filler-AI clubs never participate in the market.
  if (isEphemeralAI(club)) {
    return { ok: false, error: "AI clubs cannot bid on transfer listings" };
  }
  if (!Number.isFinite(proposedMaximum) || proposedMaximum <= 0) {
    return { ok: false, error: "Maximum bid must be positive" };
  }
  // §21: seller cannot bid on own player (service/database-level, not UI).
  if (listing.sellerClubId === club.id) {
    return { ok: false, error: "Cannot bid on your own listing" };
  }
  // §19: irreversible commitments may only be increased.
  if (opts.existingBid && proposedMaximum < opts.existingBid.maxBid) {
    return { ok: false, error: "Maximum bids are commitments and cannot be decreased" };
  }
  // Must at least cover the opening price. (The first max bid is validated
  // against the opening floor; later increases only raise it.)
  if (opts.existingBid === undefined && proposedMaximum < listing.openingPrice) {
    return { ok: false, error: "Maximum must be at least the opening price" };
  }
  // §9/§10/§11: the hard immediate-cash rule. Humans may make their financial
  // cushion negative, but a new immediate obligation cannot exceed actual
  // unreserved cash.
  if (proposedMaximum > immediateAvailableCash) {
    return { ok: false, error: "Maximum exceeds your immediately available cash" };
  }
  // §10/§102.13.3: club-to-club value cap, bidder-specific, based on the
  // division gap. Uses the player value and division snapshots taken at
  // listing time (not the mutable current values) so later development or
  // pyramid changes cannot retroactively change a listing's cap (§68).
  const capMultiplier = clubTransferCapMultiplier(buyerDivision, listing.sellerDivisionAtListing, listing.totalDivisionsAtListing);
  const valueCap = listing.playerValueAtListing * capMultiplier;
  if (proposedMaximum > valueCap) {
    return { ok: false, error: `Maximum exceeds the ${Math.round(capMultiplier * 100)}% market cap` };
  }
  return { ok: true, maximum: Math.round(proposedMaximum) };
}

/**
 * eBay-style proxy clearing price (§12).
 *
 *   bidCount 0  -> openingPrice
 *   bidCount 1  -> openingPrice
 *   bidCount 2+ -> min(highestMax, secondHighestMax + bidIncrement)
 *
 * Always >= openingPrice.
 */
export function calculateCurrentPrice(listing: {
  openingPrice: number;
  bidIncrement: number;
  bids: { maxBid: number }[];
}): number {
  const { openingPrice, bidIncrement, bids } = listing;
  if (bids.length === 0) return openingPrice;
  if (bids.length === 1) return openingPrice;
  const sorted = [...bids].map((b) => b.maxBid).sort((a, b) => b - a);
  const highest = sorted[0];
  const secondHighest = sorted[1];
  return Math.max(openingPrice, Math.min(highest, secondHighest + bidIncrement));
}

/**
 * Determine the leading club (§12/§13). At equal maximums the earliest
 * submitted maximum wins; the actual current price is capped at the tied
 * maximum. Returns the leading club id or null when no bids exist.
 */
export function determineLeader(bids: { clubId: number; maxBid: number; initialPriorityAt: number }[]): number | null {
  if (bids.length === 0) return null;
  const sorted = [...bids].sort((a, b) => {
    if (b.maxBid !== a.maxBid) return b.maxBid - a.maxBid;
    return a.initialPriorityAt - b.initialPriorityAt;
  });
  return sorted[0].clubId;
}

/**
 * Anti-sniping soft close (§18). A competitive bid (leader or price change)
 * resets the remaining time to the configured window whenever less than the
 * window remains; otherwise the deadline is untouched. There is no extension
 * cap: every competitive bid in the final window pushes the close a full
 * window away, so scripted last-second bids cannot snipe.
 */
export function extendDeadline(opts: {
  listing: TransferAuction;
  previousLeader: number | null;
  previousPrice: number;
  newLeader: number | null;
  newPrice: number;
  now: number;
  seasonRolloverAt?: number;
}): number {
  const { listing, previousLeader, previousPrice, newLeader, newPrice, now, seasonRolloverAt } = opts;
  const competitive = newLeader !== previousLeader || newPrice > previousPrice;
  if (!competitive) return listing.deadline;
  const windowMs = MARKET_CONFIG.transferAuction.softCloseWindowMinutes * 60_000;
  if (listing.deadline - now >= windowMs) return listing.deadline;
  // Reset the close a full window away. Auctions and soft-close resets use
  // absolute real time and may cross a season boundary. The legacy argument is
  // retained for callers compiled against the old signature but no longer
  // truncates the deadline.
  void seasonRolloverAt;
  return now + windowMs;
}

// ---------------------------------------------------------------------------
// MarketFinanceService (§24, §102.10 — simplified by financial-control.md)
// ---------------------------------------------------------------------------

/**
 * Sum of a club's active market reservations (their own private maximums on
 * listings they currently lead or bid on).
 */
export function activeReservations(world: World, clubId: number, excludeListingId?: number): number {
  return world.marketReservations
    .filter((r) => r.clubId === clubId && r.releasedAt === null && r.listingId !== excludeListingId)
    .reduce((sum, r) => sum + r.amount, 0);
}

// ---------------------------------------------------------------------------
// MarketHistoryService (§72)
// ---------------------------------------------------------------------------

/**
 * Append a durable market transaction. Only permanent acquisitions
 * (TRANSFER, FREE_AGENT_SIGNING) feed the resale anchor / transfer cooldown;
 * LOAN records are audit-only (§72). The row is stamped with the global
 * completed-rounds counter so the anchor fade uses a monotonic clock (§C4).
 */
export function recordTransaction(
  world: World,
  tx: Omit<PlayerMarketTransaction, "id">
): PlayerMarketTransaction {
  const row: PlayerMarketTransaction = { ...tx, id: world.nextId++, completedRounds: world.mp.completedRounds };
  world.playerMarketHistory.push(row);
  return row;
}

/** The most recent permanent acquisition transaction for a player, if any. */
export function lastPermanentAcquisition(
  world: World,
  playerId: number
): PlayerMarketTransaction | null {
  const permanent = world.playerMarketHistory
    .filter((t) => t.playerId === playerId && t.type !== "LOAN")
    .sort((a, b) => b.timestamp - a.timestamp);
  return permanent[0] ?? null;
}

/**
 * The opening-price base value for a listing (§48/§64.1).
 *
 * If the player has a recent permanent trade, the base blends the actual paid
 * price toward `player.value` linearly over `RECENT_TRADE_FADE_OVER_GAMES`
 * league rounds completed by the whole world since the trade. With no trade,
 * or after the fade window, the base is `player.value`.
 *
 * Both endpoints use the monotonic `completedRounds` counter (review C4):
 * trades are stamped at record time, so off-match-day trades no longer snap to
 * round 1 and mis-anchor the fade. Legacy rows without the stamp fall back to
 * the day-based approximation; when even that cannot resolve a round (the day
 * was not a match day), the row counts as fully faded so a stale price can
 * never pin the base indefinitely.
 *
 * LOAN records never feed the base (§72). The base always uses the player's own
 * last permanent trade price — never a similar-player market average.
 */
export function recentTradeBaseValue(world: World, player: Player): number {
  const last = lastPermanentAcquisition(world, player.id);
  if (!last) return player.value;
  const fade = MARKET_CONFIG.recentTrade.fadeOverGames;
  if (fade <= 0) return player.value;

  const currentRound = world.mp.completedRounds;
  const acquisitionRound = last.completedRounds ?? roundForDay(last.seasonDayIndex);
  if (acquisitionRound === undefined || acquisitionRound === null) return player.value;
  const gamesSinceTrade = Math.max(0, currentRound - acquisitionRound);

  if (gamesSinceTrade >= fade) return player.value;
  const t = gamesSinceTrade / fade;
  return last.price + (player.value - last.price) * t;
}

/** The seller's allowed opening-price range for a player (§64.1). */
export function auctionOpeningRange(world: World, player: Player): { min: number; max: number } {
  const base = recentTradeBaseValue(world, player);
  const { minValueRatio, maxValueRatio } = MARKET_CONFIG.auctionOpeningRange;
  return {
    min: Math.max(1, roundToSensibleIncrement(base * minValueRatio)),
    max: Math.max(1, roundToSensibleIncrement(base * maxValueRatio)),
  };
}

/**
 * Validate a seller-supplied opening price against the permitted range (§64.1).
 * When no price is supplied, the system uses the base value (100% of V).
 */
export function resolveOpeningPrice(
  world: World,
  player: Player,
  asked?: number
): { ok: true; openingPrice: number } | { ok: false; error: string } {
  const { min, max } = auctionOpeningRange(world, player);
  const price = asked === undefined ? max : roundToSensibleIncrement(asked);
  if (asked !== undefined && !Number.isFinite(asked)) {
    return { ok: false, error: "Invalid opening price" };
  }
  if (price < min) {
    return { ok: false, error: `Opening price must be at least ${formatMoney(min)} (${Math.round(MARKET_CONFIG.auctionOpeningRange.minValueRatio * 100)}% of base value)` };
  }
  if (price > max) {
    return { ok: false, error: `Opening price cannot exceed ${formatMoney(max)} (${Math.round(MARKET_CONFIG.auctionOpeningRange.maxValueRatio * 100)}% of base value)` };
  }
  return { ok: true, openingPrice: price };
}

// ---------------------------------------------------------------------------
// Reservation helpers (§23/§73)
// ---------------------------------------------------------------------------

/**
 * Create (or update) a club's durable reservation on a listing. When leading,
 * the reserved amount equals the club's private maximum (§23).
 */
export function upsertReservation(
  world: World,
  opts: { clubId: number; listingId: number; marketType: "TRANSFER" | "FREE_AGENT"; amount: number }
): MarketReservation {
  let reservation = world.marketReservations.find(
    (r) => r.clubId === opts.clubId && r.listingId === opts.listingId && r.marketType === opts.marketType
  );
  if (!reservation) {
    reservation = {
      id: world.nextId++,
      clubId: opts.clubId,
      listingId: opts.listingId,
      marketType: opts.marketType,
      amount: opts.amount,
      createdAt: Date.now(),
      releasedAt: null,
    };
    world.marketReservations.push(reservation);
  } else {
    reservation.amount = opts.amount;
    // A previously outbid club may bid again on the same listing. Reuse the
    // durable row, but make the commitment active again; otherwise settlement
    // would see the club as leader with no live reservation (§23/§73).
    reservation.releasedAt = null;
  }
  return reservation;
}

/** Release a club's reservation on a listing (outbid / settlement / cancel). */
export function releaseReservation(world: World, clubId: number, listingId: number, marketType: "TRANSFER" | "FREE_AGENT"): void {
  for (const r of world.marketReservations) {
    if (r.clubId === clubId && r.listingId === listingId && r.marketType === marketType && r.releasedAt === null) {
      r.releasedAt = Date.now();
    }
  }
}

/** Release every active reservation on a listing (settlement/cancellation). */
export function releaseAllReservations(world: World, listingId: number, marketType: "TRANSFER" | "FREE_AGENT"): void {
  for (const r of world.marketReservations) {
    if (r.listingId === listingId && r.marketType === marketType && r.releasedAt === null) {
      r.releasedAt = Date.now();
    }
  }
}

/**
 * Recompute the cached proxy state (leader, current price, reservations) of an
 * active listing from its surviving bids. Used after bids are removed outside
 * the normal `applyMaxBid` path (destroyed-club cleanup) so the next-highest
 * surviving bidder leads with a live reservation (§12/§13/§23).
 */
export function recomputeProxyState(world: World, listingId: number, marketType: MarketType): void {
  const listing: TransferAuction | FreeAgentListing | undefined =
    marketType === "TRANSFER"
      ? world.transferAuctions.find((a) => a.id === listingId)
      : world.freeAgentListings.find((l) => l.id === listingId);
  if (!listing || listing.status !== "ACTIVE") return;
  const bids = world.marketBids
    .filter((b) => b.marketType === marketType && b.listingId === listingId)
    .map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: b.initialPriorityAt }));
  listing.currentPrice = calculateCurrentPrice({ openingPrice: listing.openingPrice, bidIncrement: listing.bidIncrement, bids });
  listing.leadingClubId = determineLeader(bids);
  for (const bid of world.marketBids.filter((b) => b.marketType === marketType && b.listingId === listingId)) {
    if (bid.clubId === listing.leadingClubId) {
      upsertReservation(world, { clubId: bid.clubId, listingId, marketType, amount: bid.maxBid });
    } else {
      releaseReservation(world, bid.clubId, listingId, marketType);
    }
  }
}

/**
 * Void every market commitment of a club that is being destroyed (retiring
 * filler / rollover filler removal): its bids are removed, its reservations
 * released, and every affected active listing gets its proxy state recomputed.
 * A destroyed club's commitments are void — they are never settled in its
 * favor — but surviving bidders on the same listings keep their state intact.
 */
export function purgeClubBids(world: World, clubId: number): void {
  const affected = new Set<string>();
  for (const bid of world.marketBids) {
    if (bid.clubId === clubId) affected.add(`${bid.marketType}:${bid.listingId}`);
  }
  world.marketBids = world.marketBids.filter((bid) => bid.clubId !== clubId);
  for (const r of world.marketReservations) {
    if (r.clubId === clubId && r.releasedAt === null) r.releasedAt = Date.now();
  }
  for (const key of affected) {
    const separator = key.indexOf(":");
    recomputeProxyState(world, Number(key.slice(separator + 1)), key.slice(0, separator) as MarketType);
  }
}

// ---------------------------------------------------------------------------
// Listing helpers (§68)
// ---------------------------------------------------------------------------

/**
 * True when the player already has any active market commitment that blocks a
 * new listing/release (§102.3 #1): an active transfer auction, an active
 * free-agent listing, or an active loan listing/claim (via `loanId`).
 */
export function playerHasActiveListing(world: World, player: Player): boolean {
  if (player.loanId !== null) return true;
  if (world.transferAuctions.some((a) => a.playerId === player.id && a.status === "ACTIVE")) return true;
  if (world.freeAgentListings.some((l) => l.playerId === player.id && l.status === "ACTIVE")) return true;
  return false;
}

/**
 * Create a new public club-to-club auction listing. The seller may choose the
 * opening asking price within the permitted range of the opening-price base
 * (§64.1); when omitted, the base value is used. Enforces one active listing
 * per player (domain invariant) and youth ineligibility.
 */
export function createTransferAuction(
  world: World,
  opts: {
    player: Player;
    sellerClub: Club;
    sellerDivision: number;
    totalDivisions: number;
    /** Seller-chosen opening asking price (§64.1); defaults to the base value. */
    openingPrice?: number;
    now?: number;
    seasonRolloverAt?: number;
  }
): { ok: true; listing: TransferAuction } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const { player, sellerClub } = opts;

  // Invariant #28: ephemeral filler-AI clubs never list players for sale.
  if (isEphemeralAI(sellerClub)) {
    return { ok: false, error: "AI clubs cannot list players for transfer" };
  }
  if (player.isYouth) return { ok: false, error: "Youth players cannot be listed for auction" };
  if (player.clubId !== sellerClub.id) return { ok: false, error: "Player not in squad" };
  // New-club outbound lock: buying/releasing stay open, selling does not.
  const sellLock = newClubSellLockError(world, sellerClub.id);
  if (sellLock) return { ok: false, error: sellLock };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "This player already has an active market listing" };
  }
  // §53: same-season club-to-club anti-circular cooldown (FA signings exempt).
  const cooldown = transferCooldownError(world, player, now);
  if (cooldown) return { ok: false, error: cooldown };

  // §64.1: the seller chooses within [0.60, 1.00] × base; default to base.
  const resolved = resolveOpeningPrice(world, player, opts.openingPrice);
  if (!resolved.ok) return resolved;
  const openingPrice = resolved.openingPrice;
  // Real-time listing window from MARKET_CONFIG (review C3): the single source
  // of truth for auction duration; the legacy gameConfig.auctionDurationDays
  // was removed.
  const deadline = now + MARKET_CONFIG.transferAuction.durationHours * 60 * 60 * 1000;

  const listing: TransferAuction = {
    id: world.nextId++,
    playerId: player.id,
    sellerClubId: sellerClub.id,
    playerValueAtListing: player.value,
    openingPrice,
    bidIncrement: bidIncrementForValue(player.value),
    sellerDivisionAtListing: opts.sellerDivision,
    totalDivisionsAtListing: opts.totalDivisions,
    salaryBaselineAtListing: player.salary,
    playerOverallAtListing: player.overall,
    playerAgeAtListing: player.age,
    currentPrice: openingPrice,
    leadingClubId: null,
    createdAt: now,
    deadline,
    originalDeadline: deadline,
    status: "ACTIVE",
    completedAt: null,
    winningClubId: null,
    finalPrice: null,
    cancelledAt: null,
    softClosed: false,
    deadlineVersion: 0,
  };
  world.transferAuctions.push(listing);
  player.onSale = true;
  return { ok: true, listing };
}

/**
 * Cancel a listing before any valid bid (§20). Releases all reservations and
 * clears the player's on-sale flag.
 */
export function cancelTransferAuction(
  world: World,
  listing: TransferAuction
): { ok: true } | { ok: false; error: string } {
  if (listing.status !== "ACTIVE") return { ok: false, error: "Listing is not active" };
  const bidCount = world.marketBids.filter((b) => b.listingId === listing.id).length;
  if (bidCount > 0) return { ok: false, error: "A listing with bids cannot be cancelled" };
  listing.status = "CANCELLED";
  listing.cancelledAt = Date.now();
  releaseAllReservations(world, listing.id, "TRANSFER");
  const player = world.players.find((p) => p.id === listing.playerId);
  if (player) player.onSale = false;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Due-listing resolution (§77)
// ---------------------------------------------------------------------------

/**
 * Mark expired club-to-club auction listings that received no bids as
 * CANCELLED, releasing reservations and clearing the player's on-sale flag.
 * Listings WITH bids are left for settlement (Phase 3) so no money/ownership
 * moves before the full atomic settlement path exists. Returns the number of
 * listings resolved.
 */
export function expireDueListings(world: World, now: number): number {
  let resolved = 0;
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE" || listing.deadline > now) continue;
    const bidCount = world.marketBids.filter((b) => b.listingId === listing.id).length;
    if (bidCount === 0) {
      listing.status = "CANCELLED";
      listing.cancelledAt = now;
      releaseAllReservations(world, listing.id, "TRANSFER");
      const player = world.players.find((p) => p.id === listing.playerId);
      if (player) player.onSale = false;
      resolved += 1;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Settlement (§22)
// ---------------------------------------------------------------------------

/**
 * Atomic auction settlement. Runs entirely inside the caller's mutation (the
 * route/worker holds `withGlobalLock` + a single Prisma transaction), so there
 * is no state where payment succeeds but the player transfer fails (§22).
 *
 * Steps: ensure active → determine winner (highest max, earliest priority) →
 * clearing price (proxy) → deduct from buyer → credit seller → transfer player
 * (preserving contract/salary) → release all reservations → record history →
 * mark complete → news.
 *
 * `forceClose` bypasses the deadline check for callers that must resolve a
 * listing immediately because its seller is being destroyed (financial
 * intervention, filler-club retirement); the proxy rules are unchanged.
 */
export function settleTransferAuction(
  world: World,
  listing: TransferAuction,
  now: number,
  opts: { forceClose?: boolean } = {}
): { ok: true; winnerClubId: number | null; finalPrice: number | null } | { ok: false; error: string; terminal?: boolean } {
  if (listing.status !== "ACTIVE") return { ok: false, error: "Listing is not active" };
  if (!opts.forceClose && now < listing.deadline) return { ok: false, error: "Listing has not closed yet" };

  const bids = world.marketBids
    .filter((b) => b.listingId === listing.id)
    .map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: b.initialPriorityAt }));
  const player = world.players.find((p) => p.id === listing.playerId);
  const seller = world.clubs.find((c) => c.id === listing.sellerClubId);

  // No bids: mark cancelled, release nothing, clear on-sale. (Historical note:
  // the listing expired earlier via expireDueListings; this is a defensive
  // path if a listing reaches settlement without bids.)
  if (bids.length === 0) {
    listing.status = "CANCELLED";
    listing.cancelledAt = now;
    if (player) player.onSale = false;
    return { ok: true, winnerClubId: null, finalPrice: null };
  }

  const winnerId = determineLeader(bids);
  if (winnerId === null) return { ok: false, error: "No winner could be determined" };
  const winner = world.clubs.find((c) => c.id === winnerId);
  if (!winner) return { ok: false, error: "Winning club not found" };
  if (!player || !seller) return { ok: false, error: "Player or seller not found" };
  // §102.3: the seller must still own the player at settlement; a player with
  // an active loan/FA commitment cannot be auctioned through to a new owner.
  if (player.clubId !== seller.id) return { ok: false, error: "Seller no longer owns the player" };

  const winningBid = world.marketBids.find((bid) => bid.marketType === "TRANSFER" && bid.listingId === listing.id && bid.clubId === winner.id);
  const contractSeasons = winningBid?.contractSeasons ?? 1;
  const contractSalary = winningBid?.contractSalary ?? player.salary;

  const finalPrice = calculateCurrentPrice({ openingPrice: listing.openingPrice, bidIncrement: listing.bidIncrement, bids });

  // The bid is a binding commitment. Payroll or another already-authorized
  // event may have made the winner's cash negative since the bid was placed;
  // §20 explicitly allows that settlement to push cash further negative. Do
  // still fail closed if the durable reservation itself is missing or too
  // small, which indicates corrupted/stale market state rather than a normal
  // cash-negative settlement.
  const reservation = world.marketReservations.find(
    (candidate) => candidate.clubId === winner.id && candidate.listingId === listing.id && candidate.marketType === "TRANSFER" && candidate.releasedAt === null,
  );
  if (!reservation || reservation.amount < finalPrice) {
    return { ok: false, error: "Winning bid reservation is missing or insufficient", terminal: true };
  }
  // Defensive single-roster-cap re-check at settlement: two auctions for the
  // same buyer may both pass the bid-time check and settle in one worker pass.
  // Terminal: retrying can never succeed, so callers cancel the listing.
  const rosterFull = seniorRosterFullError(world, winner.id);
  if (rosterFull) return { ok: false, error: rosterFull, terminal: true };

  // Settle the seller's accrued payroll through today before ownership moves;
  // the buyer receives the winning bidder's new contract rather than inheriting
  // the seller's salary or remaining duration.
  settlePlayerPayroll(world, player);
  // Transfer sales tax (review B1): a configured fraction of the final price
  // is burned — credited to no club — so every club-to-club transfer shrinks
  // the money supply. The seller receives the net amount; the winner pays the
  // gross price. Transaction history keeps the gross price (one cause, one
  // effect: the tax never distorts values, anchors or caps).
  const tax = Math.max(0, Math.round(finalPrice * MARKET_CONFIG.transferTax.rate));
  const netToSeller = finalPrice - tax;
  // Invariant #28: ephemeral AI clubs hold no cash. When a destroyed filler's
  // listing is force-settled, its proceeds burn with the club instead of
  // transiently crediting it.
  if (!isEphemeralAI(seller)) {
    seller.cash += netToSeller;
    seller.ledger.income.push({ code: 3, amount: netToSeller, day: world.dayIndex, label: `Transfer fee: ${player.name}` });
    if (tax > 0) {
      seller.ledger.expense.push({ code: 17, amount: tax, day: world.dayIndex, label: `Transfer sales tax: ${player.name}` });
    }
  }
  winner.cash -= finalPrice;
  winner.ledger.expense.push({ code: 1, amount: finalPrice, day: world.dayIndex, label: `Transfer fee: ${player.name}` });

  player.clubId = winner.id;
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  player.salary = contractSalary;
  player.contractDays = contractDaysForTerm(contractSeasons);
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  // The player's payroll clock continues at the buyer (same contract/salary).
  resetPayrollPeriod(player, world.dayIndex);
  // The buying club may already wear the player's old number.
  ensureClubSquadNumbers(world, winner.id);

  // Record transaction history (feeds resale anchor + cooldown, §72).
  recordTransaction(world, {
    playerId: player.id,
    listingId: listing.id,
    type: "TRANSFER",
    fromClubId: seller.id,
    toClubId: winner.id,
    price: finalPrice,
    seasonId: world.mp.seasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    seasonDayIndex: world.mp.seasonDayIndex ?? world.dayIndex,
    contractSeasons,
    contractSalary,
    timestamp: now,
  });

  // Release every reservation (winner's excess and all losers').
  releaseAllReservations(world, listing.id, "TRANSFER");

  listing.status = "COMPLETED";
  listing.completedAt = now;
  listing.winningClubId = winner.id;
  listing.finalPrice = finalPrice;

  publishNews(world, {
    kind: "auction",
    subject: NEWS_SUBJECTS.transfers,
    clubId: winner.id,
    headline: "Transfer completed",
    entries: [{
      key: `auction:${listing.id}`,
      label: player.name,
      detail: `${winner.name} won the auction for ${formatMoney(finalPrice)}${tax > 0 ? ` (includes ${formatMoney(tax)} sales tax)` : ""}`,
    }],
  });

  return { ok: true, winnerClubId: winner.id, finalPrice };
}

/**
 * Fail-closed cancellation of a listing that can never settle (missing
 * reservation, roster cap breach): release reservations, keep the player owned
 * by the seller, and announce the cancellation (§22 no partial state).
 */
export function cancelUnsettleableAuction(world: World, listing: TransferAuction, now: number, reason: string): void {
  const player = world.players.find((p) => p.id === listing.playerId);
  releaseAllReservations(world, listing.id, "TRANSFER");
  listing.status = "CANCELLED";
  listing.cancelledAt = now;
  if (player) player.onSale = false;
  publishNews(world, {
    kind: "auction",
    text: `The auction for ${player?.name ?? "a player"} was cancelled (${reason})`,
  });
}

/** Settle every due transfer auction (§77 worker path). Returns count settled. */
export function settleDueTransferAuctions(world: World, now: number): number {
  let settled = 0;
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE" || listing.deadline > now) continue;
    const result = settleTransferAuction(world, listing, now);
    if (result.ok) {
      settled += 1;
      continue;
    }
    // A settlement failure should be impossible while reservations are held
    // (the winner's max >= clearing price). Fail closed rather than letting a
    // broken listing retry forever: cancel it, release reservations, and keep
    // the player owned by the seller (§22 no partial state).
    cancelUnsettleableAuction(world, listing, now, result.error);
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Transfer cooldown (§53)
// ---------------------------------------------------------------------------

/**
 * Anti-circular-transfer cooldown: a player purchased from another club via a
 * club-to-club auction cannot be permanently transferred again during the same
 * season. Free-agent signings are EXEMPT (they use the recent-price anchor
 * instead, §53/§54). Returns an error when the player is still cooling down.
 */
export function transferCooldownError(world: World, player: Player, now = Date.now()): string | null {
  const last = lastPermanentAcquisition(world, player.id);
  if (!last) return null;
  if (last.type !== "TRANSFER") return null; // FA signings are exempt
  if (last.seasonId === world.mp.seasonId) {
    return "A player acquired from another club this season cannot be listed again until next season";
  }
  const elapsed = now - last.timestamp;
  const lockupMs = MARKET_CONFIG.transferAuction.transferLockupDays * 24 * 60 * 60 * 1000;
  if (elapsed < lockupMs) {
    const remainingDays = Math.ceil((lockupMs - Math.max(0, elapsed)) / (24 * 60 * 60 * 1000));
    return `This player is under a ${MARKET_CONFIG.transferAuction.transferLockupDays}-day transfer lockup (${remainingDays} day${remainingDays === 1 ? "" : "s"} remaining)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Removed-player reconciliation (§10, §16)
// ---------------------------------------------------------------------------

/**
 * Ordinary season rollover leaves transfer auctions untouched. This helper is
 * retained for cleanup callers that remove a seller/player (for example,
 * ephemeral filler-club cleanup), where an active listing can no longer settle.
 */
export function reconcileListingsAtRollover(world: World, now: number): number {
  let cancelled = 0;
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE") continue;
    const player = world.players.find((p) => p.id === listing.playerId);
    const seller = world.clubs.find((club) => club.id === listing.sellerClubId);
    if (player && seller) continue;
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = now;
    if (player) player.onSale = false;
    cancelled += 1;
  }
  // Free-agent listings may cross rollover (§17) — untouched here (Phase 7).
  return cancelled;
}

// ---------------------------------------------------------------------------
// MarketBid helpers (§69)
// ---------------------------------------------------------------------------

/** Find a club's current maximum on a listing. */
export function marketBidFor(world: World, listingId: number, clubId: number): MarketBid | undefined {
  return world.marketBids.find((b) => b.listingId === listingId && b.clubId === clubId);
}

/**
 * Apply a new/increased private maximum to a listing. Updates the durable
 * reservation, recomputes the proxy state, and applies the soft close.
 * Returns the updated public projection (never competing maximums).
 */
export function applyMaxBid(
  world: World,
  opts: {
    listing: TransferAuction;
    club: Club;
    player: Player;
    proposedMaximum: number;
    buyerDivision: number;
    immediateAvailableCash: number;
    contractSeasons?: number;
    now?: number;
    seasonRolloverAt?: number;
  }
): { ok: true; currentPrice: number; leading: boolean; contractSeasons: number; contractSalary: number; outbidClubId?: number } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const { listing, club, player } = opts;
  // Invariant #28: ephemeral filler-AI clubs never enter bid commitments.
  if (isEphemeralAI(club)) return { ok: false, error: "AI clubs cannot bid on transfer listings" };
  const existing = marketBidFor(world, listing.id, club.id);
  const existingReservation = existing
    ? world.marketReservations.find(
        (reservation) =>
          reservation.clubId === club.id &&
          reservation.listingId === listing.id &&
          reservation.marketType === "TRANSFER" &&
          reservation.releasedAt === null,
      )
    : undefined;

  if (listing.status !== "ACTIVE") return { ok: false, error: "Listing is not active" };
  if (now >= listing.deadline) return { ok: false, error: "Listing has closed" };
  // Single senior-roster cap: a full squad cannot enter new binding commitments.
  const rosterFull = seniorRosterFullError(world, club.id);
  if (rosterFull) return { ok: false, error: rosterFull };

  const validated = validateMaxBid({
    listing,
    club,
    player,
    proposedMaximum: opts.proposedMaximum,
    buyerDivision: opts.buyerDivision,
    // An active reservation for this same bid is being replaced, so it is
    // available capacity for the increased maximum rather than an additional
    // cash requirement.
    immediateAvailableCash: opts.immediateAvailableCash + (existingReservation?.amount ?? 0),
    existingBid: existing,
  });
  if (!validated.ok) return validated;

  const maxBid = validated.maximum;
  const requestedContractSeasons = opts.contractSeasons;
  const contractSeasons = existing?.contractSeasons ?? requestedContractSeasons ?? 1;
  if (contractSeasons < 1 || contractSeasons > gameConfig.maxContractSeasons || !Number.isInteger(contractSeasons)) {
    return { ok: false, error: `Contract term must be between 1 and ${gameConfig.maxContractSeasons} seasons` };
  }
  if (existing?.contractSeasons !== undefined && requestedContractSeasons !== undefined && existing.contractSeasons !== requestedContractSeasons) {
    return { ok: false, error: "Contract term cannot be changed after the first bid" };
  }
  const baseline = listing.salaryBaselineAtListing ?? player.salary;
  const overall = listing.playerOverallAtListing ?? player.overall;
  const age = listing.playerAgeAtListing ?? player.age;
  const calculatedContractSalary = calculateContractDemand(
    baseline,
    overall,
    age,
    contractSeasons,
    remainingSeasonFractionForDay(world.mp.seasonDayIndex ?? world.dayIndex),
  );
  const contractSalary = existing?.contractSalary ?? calculatedContractSalary;
  const capMultiplier = clubTransferCapMultiplier(opts.buyerDivision, listing.sellerDivisionAtListing, listing.totalDivisionsAtListing);
  if (existing) {
    // §69: increasing the maximum revalidates the bidder-specific cap and
    // updates the commitment while preserving the immutable tie priority.
    existing.maxBid = maxBid;
    existing.updatedAt = now;
    existing.capMultiplierAtSubmission = capMultiplier;
    existing.maximumAllowedByRuleAtSubmission = listing.playerValueAtListing * capMultiplier;
    existing.buyerDivisionAtSubmission = opts.buyerDivision;
    existing.contractSalary ??= contractSalary;
    existing.contractDemandAtSubmission ??= existing.contractSalary;
    existing.contractSeasons ??= contractSeasons;
  } else {
    world.marketBids.push({
      id: world.nextId++,
      marketType: "TRANSFER",
      listingId: listing.id,
      clubId: club.id,
      maxBid,
      capMultiplierAtSubmission: capMultiplier,
      maximumAllowedByRuleAtSubmission: listing.playerValueAtListing * capMultiplier,
      buyerDivisionAtSubmission: opts.buyerDivision,
      contractSeasons,
      contractSalary,
      contractDemandAtSubmission: contractSalary,
      createdAt: now,
      updatedAt: now,
      initialPriorityAt: now,
    });
  }

  const bids = world.marketBids
    .filter((b) => b.listingId === listing.id)
    .map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: b.initialPriorityAt }));
  const previousLeader = listing.leadingClubId;
  const previousPrice = listing.currentPrice;

  listing.currentPrice = calculateCurrentPrice({ openingPrice: listing.openingPrice, bidIncrement: listing.bidIncrement, bids });
  listing.leadingClubId = determineLeader(bids);

  // Soft close extension (§18): only a leader/price change extends.
  const newDeadline = extendDeadline({
    listing,
    previousLeader,
    previousPrice,
    newLeader: listing.leadingClubId,
    newPrice: listing.currentPrice,
    now,
    seasonRolloverAt: opts.seasonRolloverAt,
  });
  if (newDeadline !== listing.deadline) {
    listing.deadline = newDeadline;
    listing.softClosed = true;
    listing.deadlineVersion = (listing.deadlineVersion ?? 0) + 1;
  }

  // §23: leading clubs reserve their full private maximum. Every club that is
  // NOT leading after this bid is immediately released (outbid beyond its
  // maximum, or displaced by a higher max).
  for (const bid of world.marketBids.filter((b) => b.listingId === listing.id)) {
    if (bid.clubId === listing.leadingClubId) {
      upsertReservation(world, { clubId: bid.clubId, listingId: listing.id, marketType: "TRANSFER", amount: bid.maxBid });
    } else {
      releaseReservation(world, bid.clubId, listing.id, "TRANSFER");
    }
  }

  return {
    ok: true,
    currentPrice: listing.currentPrice,
    leading: listing.leadingClubId === club.id,
    contractSeasons,
    contractSalary,
    ...(previousLeader !== null && previousLeader !== club.id && listing.leadingClubId !== previousLeader ? { outbidClubId: previousLeader } : {}),
  };
}

/** Public projection for one listing (never competing maximums, §15/§16). */
export function transferAuctionView(
  world: World,
  listing: TransferAuction,
  myClubId: number | null
) {
  const p = world.players.find((x) => x.id === listing.playerId);
  const myBid = myClubId !== null ? marketBidFor(world, listing.id, myClubId) : undefined;
  const contractDemandsBySeason = p
    ? contractDemandOptions(
        listing.salaryBaselineAtListing ?? p.salary,
        listing.playerOverallAtListing ?? p.overall,
        listing.playerAgeAtListing ?? p.age,
        world.mp.seasonDayIndex ?? world.dayIndex,
      )
    : {};
  return {
    id: listing.id,
    playerId: listing.playerId,
    playerName: p?.name ?? "",
    overall: p?.overall ?? 0,
    position: p?.position ?? 0,
    age: p?.age ?? 0,
    salary: p?.salary ?? 0,
    skills: p?.skills ?? { gol: 0, vel: 0, tec: 0, pas: 0, des: 0, arm: 0, fin: 0 },
    value: p?.value ?? 0,
    openingPrice: listing.openingPrice,
    currentPrice: listing.currentPrice,
    bidIncrement: listing.bidIncrement,
    bidderCount: world.marketBids.filter((b) => b.listingId === listing.id).length,
    sellerClubId: listing.sellerClubId,
    sellerName: world.clubs.find((c) => c.id === listing.sellerClubId)?.name ?? "",
    deadline: listing.deadline,
    originalDeadline: listing.originalDeadline,
    status: listing.status,
    completedAt: listing.completedAt,
    winningClubId: listing.winningClubId,
    finalPrice: listing.finalPrice,
    contractDemandsBySeason,
    // §15: only the requesting club's own maximum and leading state.
    myMaxBid: myBid?.maxBid ?? null,
    myContractSeasons: myBid?.contractSeasons ?? null,
    myContractSalary: myBid?.contractSalary ?? null,
    amILeading: listing.leadingClubId === myClubId,
  };
}

export { clamp };
