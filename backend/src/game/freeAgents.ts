import { MARKET_CONFIG, gameConfig } from "../config";
import type { Club, FreeAgentListing, Player, World } from "./types";
import {
  calculateCurrentPrice,
  determineLeader,
  extendDeadline,
  marketBidFor,
  playerHasActiveListing,
  recordTransaction,
  releaseAllReservations,
  releaseReservation,
  roundToSensibleIncrement,
  upsertReservation,
} from "./market";
import { settlePlayerPayroll, resetPayrollPeriod } from "./payroll";
import { createRng, nextDouble, normal } from "./rng";
import { DEVELOPMENT } from "./constants";

/**
 * Free-agent market (transfer-market-overhaul Phase 7, §41-§54).
 *
 * The system lists unowned players automatically when they become free agents
 * (contract expiry / release). Bidding reuses the shared proxy-bid engine but
 * is presented as a signing competition: clubs bid only on the signing fee,
 * the winner pays the SYSTEM (money leaves the economy, §44), and the player
 * signs the predefined salary + contract duration generated at listing time
 * (§46). There is no player-value cap for free agents — only immediate cash
 * (§43). Unsold listings relist at progressively lower opening multipliers
 * (§54).
 */

/**
 * Generate the fixed salary demand (§46.1) and contract-duration demand (§46.2)
 * for a free agent, deterministically from visible data and the listing stage.
 */
export function generateFreeAgentTerms(
  world: World,
  player: Player,
  version = 0
): { salary: number; contractDays: number } {
  const salary = marketSalaryForPlayer(world, player, version);
  const seasons = contractSeasonsForAge(player.age, version);
  return { salary, contractDays: seasons * gameConfig.seasonDays };
}

/**
 * Weighted median in log-salary space of comparable contracted senior players
 * (§46.1). Uses a Gaussian kernel on ln(value) distance; widens the bandwidth
 * until the effective sample size reaches the configured target.
 */
export function marketSalaryForPlayer(world: World, player: Player, version = 0): number {
  const cfg = MARKET_CONFIG.freeAgents;
  const Vp = Math.max(1, player.value);
  const comparables = world.players.filter(
    (p) => p.clubId !== null && !p.isYouth && p.value > 0 && p.salary > 0 && p.id !== player.id
  );
  if (comparables.length === 0) {
    return Math.max(gameConfig.salaryFloor, roundToSensibleIncrement(player.value * 0.08));
  }

  let h = cfg.salaryKernelBandwidthLogValue;
  let salaries: number[] = [];
  let weights: number[] = [];
  let neff = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    salaries = [];
    weights = [];
    for (const c of comparables) {
      const di = Math.log(Math.max(1, c.value) / Vp);
      const wi = Math.exp(-(di * di) / (2 * h * h));
      salaries.push(Math.log(c.salary));
      weights.push(wi);
    }
    const sumW = weights.reduce((a, b) => a + b, 0);
    const sumW2 = weights.reduce((a, b) => a + b * b, 0);
    neff = sumW > 0 ? (sumW * sumW) / Math.max(1e-9, sumW2) : 0;
    if (neff >= cfg.salaryEffectiveSampleTarget) break;
    h *= 1.5;
  }

  // Weighted median in log-salary space.
  const pairs = salaries.map((s, i) => ({ s, w: weights[i] }));
  pairs.sort((a, b) => a.s - b.s);
  const totalW = pairs.reduce((a, b) => a + b.w, 0);
  let acc = 0;
  let medianLog = pairs[0]?.s ?? 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= totalW / 2) {
      medianLog = p.s;
      break;
    }
  }

  // Deterministic negotiation noise: Z ~ N(0,1) seeded by playerId+version.
  const rng = createRng(player.id * 31 + version * 7 + 1);
  let z = normal(rng, 0, 1);
  z = Math.max(-cfg.salaryNoiseZClamp, Math.min(cfg.salaryNoiseZClamp, z));
  const noise = Math.exp(cfg.salaryNoiseSigma * z);
  const marketSalary = Math.exp(medianLog) * noise;

  // Clamp to the weighted 5th-95th salary band of the same population.
  const sortedSalaries = comparables.map((c) => c.salary).sort((a, b) => a - b);
  const pct = (q: number) => sortedSalaries[Math.min(sortedSalaries.length - 1, Math.floor(q * sortedSalaries.length))] ?? 0;
  const floor = pct(cfg.salaryPercentileFloor);
  const ceil = pct(cfg.salaryPercentileCeiling);
  return Math.max(gameConfig.salaryFloor, roundToSensibleIncrement(Math.max(floor, Math.min(ceil, marketSalary))));
}

/**
 * Contract duration from the global population decline age curve (§46.2).
 * Deterministic stochastic rounding; clamped to contractMinSeasons..
 * contractMaxSeasons.
 */
export function contractSeasonsForAge(age: number, version = 0): number {
  const cfg = MARKET_CONFIG.freeAgents;
  const Dmin = cfg.contractMinSeasons;
  const Dmax = cfg.contractMaxSeasons;
  const mu = DEVELOPMENT.declineAge.mean;
  const sigma = DEVELOPMENT.declineAge.stdDev;
  const Amid = mu + cfg.contractAgeMidpointOffset;
  const k = cfg.contractAgeScaleSigmaMultiplier * sigma;
  const Dmean = Dmin + (Dmax - Dmin) / (1 + Math.exp((age - Amid) / Math.max(0.01, k)));
  const f = Dmean - Math.floor(Dmean);
  const rng = createRng(age * 1013 + version * 17 + 3);
  const seasons = nextDouble(rng) < f ? Math.ceil(Dmean) : Math.floor(Dmean);
  return Math.max(Dmin, Math.min(Dmax, seasons));
}

/**
 * Create a free-agent listing for an unowned player. Opening price = small
 * fraction of value (§42/§54). Deterministic salary/contract terms are
 * generated and frozen on the listing (§46).
 */
export function createFreeAgentListing(
  world: World,
  player: Player,
  opts: { now?: number; relistStage?: number; previousListingId?: number | null; blockedClubId?: number | null } = {}
): { ok: true; listing: FreeAgentListing } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  if (player.clubId !== null) return { ok: false, error: "Player is not a free agent" };
  const prepared = prepareFreeAgentListing(world, player, { ...opts, now });
  if (!prepared.ok) return prepared;
  world.freeAgentListings.push(prepared.listing);
  return prepared;
}

/**
 * Prepare a listing without publishing it. The intervention engine uses this
 * as a preflight step so every required listing is known to be valid before
 * it starts mutating players/cash; the caller must push the returned listing
 * exactly once after the player becomes a free agent.
 */
export function prepareFreeAgentListing(
  world: World,
  player: Player,
  opts: { now?: number; relistStage?: number; previousListingId?: number | null; blockedClubId?: number | null; allowOwnedPlayer?: boolean } = {}
): { ok: true; listing: FreeAgentListing } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  if (!opts.allowOwnedPlayer && player.clubId !== null) return { ok: false, error: "Player is not a free agent" };
  if (player.isYouth) return { ok: false, error: "Youth players cannot be free-agent listed" };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "This player already has an active market listing" };
  }

  const stage = opts.relistStage ?? 0;
  const multipliers = MARKET_CONFIG.freeAgents.relistMultipliers;
  const startMultiplier = stage >= multipliers.length ? multipliers[multipliers.length - 1] : multipliers[stage];
  const openingPrice = Math.max(1, roundToSensibleIncrement(player.value * startMultiplier));
  const terms = generateFreeAgentTerms(world, player, stage);
  const deadline = now + MARKET_CONFIG.freeAgents.durationHours * 60 * 60 * 1000;

  const listing: FreeAgentListing = {
    id: world.nextId++,
    playerId: player.id,
    playerValueAtListing: player.value,
    openingPrice,
    bidIncrement: Math.max(1, roundToSensibleIncrement(player.value * MARKET_CONFIG.transferAuction.bidIncrementRate)),
    demandedSalary: terms.salary,
    demandedContractDays: terms.contractDays,
    currentPrice: openingPrice,
    leadingClubId: null,
    relistStage: stage,
    createdAt: now,
    deadline,
    status: "ACTIVE",
    completedAt: null,
    winningClubId: null,
    finalPrice: null,
    previousListingId: opts.previousListingId ?? null,
    blockedClubId: opts.blockedClubId ?? null,
    softClosed: false,
    softCloseExtensions: 0,
  };
  return { ok: true, listing };
}

/**
 * Submit/increase a private maximum signing-fee bid on a free-agent listing.
 * Reuses the proxy engine; NO player-value cap (§43) — only immediate cash.
 */
export function applyFreeAgentBid(
  world: World,
  opts: {
    listing: FreeAgentListing;
    club: Club;
    player: Player;
    proposedMaximum: number;
    immediateAvailableCash: number;
    now?: number;
    seasonRolloverAt?: number;
  }
): { ok: true; currentPrice: number; leading: boolean } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const { listing, club, player } = opts;
  const existing = marketBidFor(world, listing.id, club.id);
  const existingReservation = existing
    ? world.marketReservations.find(
        (reservation) =>
          reservation.clubId === club.id &&
          reservation.listingId === listing.id &&
          reservation.marketType === "FREE_AGENT" &&
          reservation.releasedAt === null,
      )
    : undefined;

  if (listing.status !== "ACTIVE") return { ok: false, error: "Listing is not active" };
  if (now >= listing.deadline) return { ok: false, error: "Listing has closed" };
  if (player.id !== listing.playerId || player.clubId !== null || player.isYouth) {
    return { ok: false, error: "Player is no longer available as a free agent" };
  }
  if (!Number.isFinite(opts.proposedMaximum) || opts.proposedMaximum <= 0) {
    return { ok: false, error: "Maximum bid must be positive" };
  }
  // §19: irreversible commitments may only be increased.
  if (existing && opts.proposedMaximum < existing.maxBid) {
    return { ok: false, error: "Maximum bids are commitments and cannot be decreased" };
  }
  if (existing === undefined && opts.proposedMaximum < listing.openingPrice) {
    return { ok: false, error: "Maximum must be at least the opening price" };
  }
  // §35: the former club of a system-liquidated player cannot bid on the
  // resulting free-agent listing (financial-control §35/§36).
  if (listing.blockedClubId === club.id) {
    return { ok: false, error: "Your club is not allowed to bid on this listing" };
  }
  // §11/§9: free agents have no player-value cap; the only financial ceiling is
  // the hard immediate-cash rule (unreserved actual cash). Humans may make the
  // cushion negative; AI applies its own stricter guardrail at the strategy layer.
  const availableForMaximum = opts.immediateAvailableCash + (existingReservation?.amount ?? 0);
  if (opts.proposedMaximum > availableForMaximum) {
    return { ok: false, error: "Maximum exceeds your immediately available cash" };
  }

  const maxBid = Math.round(opts.proposedMaximum);
  if (existing) {
    existing.maxBid = maxBid;
    existing.updatedAt = now;
  } else {
    world.marketBids.push({
      id: world.nextId++,
      marketType: "FREE_AGENT",
      listingId: listing.id,
      clubId: club.id,
      maxBid,
      capMultiplierAtSubmission: undefined,
      maximumAllowedByRuleAtSubmission: undefined,
      buyerDivisionAtSubmission: undefined,
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

  const newDeadline = extendDeadline({
    listing: listing as unknown as Parameters<typeof extendDeadline>[0]["listing"],
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
    listing.softCloseExtensions += 1;
  }

  for (const bid of world.marketBids.filter((b) => b.listingId === listing.id)) {
    if (bid.clubId === listing.leadingClubId) {
      upsertReservation(world, { clubId: bid.clubId, listingId: listing.id, marketType: "FREE_AGENT", amount: bid.maxBid });
    } else {
      releaseReservation(world, bid.clubId, listing.id, "FREE_AGENT");
    }
  }

  return { ok: true, currentPrice: listing.currentPrice, leading: listing.leadingClubId === club.id };
}
/**
 * Settle a due free-agent listing. The winner pays the SYSTEM (money leaves
 * the economy, §44); the player signs the predefined salary/contract generated
 * at listing time (§46). Atomic inside the caller's lock + transaction.
 */
export function settleFreeAgentListing(
  world: World,
  listing: FreeAgentListing,
  now: number
): { ok: true; winnerClubId: number | null; finalPrice: number | null } | { ok: false; error: string } {
  if (listing.status !== "ACTIVE") return { ok: false, error: "Listing is not active" };
  if (now < listing.deadline) return { ok: false, error: "Listing has not closed yet" };

  const bids = world.marketBids
    .filter((b) => b.listingId === listing.id)
    .map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: b.initialPriorityAt }));
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player || player.clubId !== null || player.isYouth) return { ok: false, error: "Player is no longer available as a free agent" };

  // No bids: the listing expires for relisting (§54) rather than settling.
  if (bids.length === 0) {
    listing.status = "CANCELLED";
    listing.completedAt = now;
    return { ok: true, winnerClubId: null, finalPrice: null };
  }

  const winnerId = determineLeader(bids);
  if (winnerId === null) return { ok: false, error: "No winner could be determined" };
  const winner = world.clubs.find((c) => c.id === winnerId);
  if (!winner) return { ok: false, error: "Winning club not found" };
  const finalPrice = calculateCurrentPrice({ openingPrice: listing.openingPrice, bidIncrement: listing.bidIncrement, bids });
  // A leading free-agent bid is a binding commitment. Payroll may have pushed
  // the winner cash-negative since the bid was placed; the settlement remains
  // valid (§20). Only a missing/insufficient reservation is an invalid state.
  const reservation = world.marketReservations.find(
    (candidate) => candidate.clubId === winner.id && candidate.listingId === listing.id && candidate.marketType === "FREE_AGENT" && candidate.releasedAt === null,
  );
  if (!reservation || reservation.amount < finalPrice) {
    return { ok: false, error: "Winning bid reservation is missing or insufficient" };
  }

  // Winner pays the system: cash leaves the economy, no club is credited (§44).
  settlePlayerPayroll(world, player);
  winner.cash -= finalPrice;
  winner.ledger.expense.push({ code: 1, amount: finalPrice, day: world.dayIndex, label: `Signing fee: ${player.name}` });

  // Apply the predefined contract terms (§46) and move ownership.
  player.clubId = winner.id;
  player.tacPos = -1;
  player.starter = false;
  player.onSale = false;
  player.salary = listing.demandedSalary;
  player.contractDays = listing.demandedContractDays;
  player.releaseClause = 0;
  resetPayrollPeriod(player, world.dayIndex);

  recordTransaction(world, {
    playerId: player.id,
    listingId: listing.id,
    type: "FREE_AGENT_SIGNING",
    fromClubId: null,
    toClubId: winner.id,
    price: finalPrice,
    seasonId: world.mp.seasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    matchday: world.dayIndex,
    timestamp: now,
  });

  releaseAllReservations(world, listing.id, "FREE_AGENT");
  listing.status = "COMPLETED";
  listing.completedAt = now;
  listing.winningClubId = winner.id;
  listing.finalPrice = finalPrice;

  world.news.push({
    dayIndex: world.dayIndex,
    text: `${winner.name} signed ${player.name} as a free agent for ${formatMoney(finalPrice)}`,
    kind: "market",
    clubId: winner.id,
  });
  return { ok: true, winnerClubId: winner.id, finalPrice };
}

/**
 * Settle every due free-agent listing (§22 worker path). Returns count settled.
 */
export function settleDueFreeAgentListings(world: World, now: number): number {
  let settled = 0;
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || listing.deadline > now) continue;
    const result = settleFreeAgentListing(world, listing, now);
    if (result.ok) {
      settled += 1;
    } else {
      // Never leave a due listing retrying forever after a stale/corrupt
      // reservation or player reference. No ownership/payment mutation has
      // occurred on the failed path, so cancelling is the safe boundary.
      releaseAllReservations(world, listing.id, "FREE_AGENT");
      listing.status = "CANCELLED";
      listing.completedAt = now;
    }
  }
  return settled;
}

/**
 * Relist a cancelled (no-bid) free-agent listing at the next lower opening
 * multiplier (§54). Returns the new listing id or null when already active.
 */
export function relistFreeAgent(world: World, listing: FreeAgentListing, now: number): number | null {
  if (listing.status !== "CANCELLED" && listing.status !== "COMPLETED") return null;
  const player = world.players.find((p) => p.id === listing.playerId);
  if (!player || player.clubId !== null) return null;
  // Completed signings are final; only no-bid cancellations relist.
  if (listing.status === "COMPLETED") return null;
  const created = createFreeAgentListing(world, player, {
    now,
    relistStage: listing.relistStage + 1,
    previousListingId: listing.id,
    blockedClubId: listing.blockedClubId,
  });
  return created.ok ? created.listing.id : null;
}

/**
 * Expire + relist all due no-bid free-agent listings (§54). Returns the number
 * of listings that were expired and relisted.
 */
export function relistDueFreeAgents(world: World, now: number): number {
  let count = 0;
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || listing.deadline > now) continue;
    const bids = world.marketBids.filter((b) => b.listingId === listing.id).length;
    if (bids > 0) continue; // has bids → settlement path handles it
    const expired = settleFreeAgentListing(world, listing, now); // no bids → CANCELLED
    if (!expired.ok) continue;
    if (relistFreeAgent(world, listing, now) !== null) count += 1;
  }
  return count;
}

/** Public projection for one free-agent listing (never competing maximums, §15). */
export function freeAgentListingView(world: World, listing: FreeAgentListing, myClubId: number | null) {
  const p = world.players.find((x) => x.id === listing.playerId);
  const myBid = myClubId !== null ? marketBidFor(world, listing.id, myClubId) : undefined;
  return {
    id: listing.id,
    playerId: listing.playerId,
    playerName: p?.name ?? "",
    overall: p?.overall ?? 0,
    position: p?.position ?? 0,
    age: p?.age ?? 0,
    salary: listing.demandedSalary,
    contractDays: listing.demandedContractDays,
    skills: p?.skills ?? { gol: 0, vel: 0, tec: 0, pas: 0, des: 0, arm: 0, fin: 0 },
    value: listing.playerValueAtListing,
    openingPrice: listing.openingPrice,
    currentPrice: listing.currentPrice,
    bidIncrement: listing.bidIncrement,
    bidderCount: world.marketBids.filter((b) => b.listingId === listing.id).length,
    deadline: listing.deadline,
    relistStage: listing.relistStage,
    status: listing.status,
    myMaxBid: myBid?.maxBid ?? null,
    amILeading: listing.leadingClubId === myClubId,
  };
}

/** Compact currency formatter for news text. */
function formatMoney(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}
