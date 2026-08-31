import { MARKET_CONFIG, gameConfig, scaleReferenceSeasonFlow } from "../config";
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
import { seniorRosterFullError, isEphemeralAI } from "./club";
import { createRng, nextDouble } from "./rng";
import { DEVELOPMENT } from "./constants";
import { calculateBaseSalary, calculateProfessionalContractSalary, contractDaysForTerm, contractDemandOptions, calculateReleaseClause, remainingSeasonFractionForDay, remainingSeasons } from "./economy";
import { recordTerminalDeletion } from "./population";
import { ensureClubSquadNumbers } from "./squadNumbers";
import { NEWS_SUBJECTS, publishNews } from "./news";
import { msg } from "../i18n/catalog";

/**
 * Free-agent market (transfer-market-overhaul Phase 7, §41-§54).
 *
 * The system lists unowned players automatically when they become free agents
 * (contract expiry / release). Bidding reuses the shared proxy-bid engine but
 * is presented as a signing competition: clubs bid only on the signing fee,
 * the winner pays the SYSTEM (money leaves the economy, §44), and the player
 * signs the bidder's accepted salary and contract duration derived from the
 * listing baseline (§46). There is no player-value cap for free agents — only
 * immediate cash (§43). Unsold listings relist at progressively lower opening multipliers
 * (§54).
 */

/**
 * Generate the frozen salary baseline (§46.1) and default contract-duration
 * projection (§46.2) for a free agent, deterministically from visible data and
 * the listing stage.
 */
export function generateFreeAgentTerms(
  world: World,
  player: Player,
  version = 0
): { salary: number; contractDays: number } {
  void world;
  void version;
  const salary = marketSalaryForPlayer(player);
  const seasons = contractSeasonsForAge(player.age, version);
  return { salary, contractDays: contractDaysForTerm(seasons) };
}

/**
 * Frozen salary baseline for a free agent (§46.1, review B2): the SAME
 * deterministic first-contract formula used at generation
 * (`calculateBaseSalary(overall, age)`), clamped by the global salary floor.
 * It deliberately does NOT sample the current population's salaries: the
 * previous population-kernel baseline created a positive feedback loop (new
 * signings raised the medians that price the next signings), creeping wages
 * upward season over season. The formula is pinned to visible data
 * (overall + age) and cannot drift.
 */
export function marketSalaryForPlayer(player: Player): number {
  return Math.max(scaleReferenceSeasonFlow(gameConfig.salaryFloor), roundToSensibleIncrement(calculateBaseSalary(player.overall, player.age)));
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
  opts: { now?: number; relistStage?: number; previousListingId?: number | null; blockedClubId?: number | null; salaryBaselineAtListing?: number; unclaimedSince?: number } = {}
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
  opts: { now?: number; relistStage?: number; previousListingId?: number | null; blockedClubId?: number | null; allowOwnedPlayer?: boolean; salaryBaselineAtListing?: number; unclaimedSince?: number } = {}
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
  const salaryBaselineAtListing = opts.salaryBaselineAtListing ?? marketSalaryForPlayer(player);
  const deadline = now + MARKET_CONFIG.freeAgents.durationHours * 60 * 60 * 1000;

  const listing: FreeAgentListing = {
    id: world.nextId++,
    playerId: player.id,
    playerValueAtListing: player.value,
    openingPrice,
    bidIncrement: Math.max(1, roundToSensibleIncrement(player.value * MARKET_CONFIG.transferAuction.bidIncrementRate)),
    salaryBaselineAtListing,
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
    unclaimedSince: opts.unclaimedSince ?? now,
    softClosed: false,
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
    contractSeasons?: number;
    now?: number;
    seasonRolloverAt?: number;
  }
): { ok: true; currentPrice: number; leading: boolean; contractSeasons: number; contractSalary: number; outbidClubId?: number } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const { listing, club, player } = opts;
  // Invariant #28: ephemeral filler-AI clubs never sign free agents.
  if (isEphemeralAI(club)) return { ok: false, error: "AI clubs cannot sign free agents" };
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
  // Single senior-roster cap: a full squad cannot enter new binding commitments.
  const rosterFull = seniorRosterFullError(world, club.id);
  if (rosterFull) return { ok: false, error: rosterFull };
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
  const requestedContractSeasons = opts.contractSeasons;
  const contractSeasons = existing?.contractSeasons ?? requestedContractSeasons ?? 1;
  if (contractSeasons < 1 || contractSeasons > gameConfig.maxContractSeasons || !Number.isInteger(contractSeasons)) {
    return { ok: false, error: `Contract term must be between 1 and ${gameConfig.maxContractSeasons} seasons` };
  }
  if (existing?.contractSeasons !== undefined && requestedContractSeasons !== undefined && existing.contractSeasons !== requestedContractSeasons) {
    return { ok: false, error: "Contract term cannot be changed after the first bid" };
  }
  // A free-agent signing is a NEW market contract: the baseline is the market
  // salary implied by his current OVR and age. An expired high salary does not
  // follow the player into free agency, so a player who rejected a renewal may
  // legitimately end up asking for less here.
  const calculatedContractSalary = calculateProfessionalContractSalary({
    currentOverall: player.overall,
    currentAge: player.age,
    futureCompleteSeasons: contractSeasons,
    currentSeasonFraction: remainingSeasonFractionForDay(world.mp.seasonDayIndex ?? world.dayIndex),
  });
  const contractSalary = existing?.contractSalary ?? calculatedContractSalary;
  if (existing) {
    existing.maxBid = maxBid;
    existing.updatedAt = now;
    existing.contractSeasons ??= contractSeasons;
    existing.contractSalary ??= contractSalary;
    existing.contractDemandAtSubmission ??= existing.contractSalary;
  } else {
    world.marketBids.push({
      id: world.nextId++,
      marketType: "FREE_AGENT",
      listingId: listing.id,
      clubId: club.id,
      maxBid,
      contractSeasons,
      contractSalary,
      contractDemandAtSubmission: contractSalary,
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
  }

  for (const bid of world.marketBids.filter((b) => b.listingId === listing.id)) {
    if (bid.clubId === listing.leadingClubId) {
      upsertReservation(world, { clubId: bid.clubId, listingId: listing.id, marketType: "FREE_AGENT", amount: bid.maxBid });
    } else {
      releaseReservation(world, bid.clubId, listing.id, "FREE_AGENT");
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
/**
 * Settle a due free-agent listing. The winner pays the SYSTEM (money leaves
 * the economy, §44); the player signs the predefined salary/contract generated
 * accepted with the winning bid (§46). Atomic inside the caller's lock + transaction.
 */
export function settleFreeAgentListing(
  world: World,
  listing: FreeAgentListing,
  now: number
): { ok: true; winnerClubId: number | null; finalPrice: number | null } | { ok: false; error: string; terminal?: boolean } {
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
  const winningBid = world.marketBids.find((bid) => bid.marketType === "FREE_AGENT" && bid.listingId === listing.id && bid.clubId === winner.id);
  const contractSeasons = winningBid?.contractSeasons ?? 1;
  const contractSalary = winningBid?.contractSalary ?? listing.salaryBaselineAtListing ?? player.salary;
  const finalPrice = calculateCurrentPrice({ openingPrice: listing.openingPrice, bidIncrement: listing.bidIncrement, bids });
  // A leading free-agent bid is a binding commitment. Payroll may have pushed
  // the winner cash-negative since the bid was placed; the settlement remains
  // valid (§20). Only a missing/insufficient reservation is an invalid state.
  const reservation = world.marketReservations.find(
    (candidate) => candidate.clubId === winner.id && candidate.listingId === listing.id && candidate.marketType === "FREE_AGENT" && candidate.releasedAt === null,
  );
  if (!reservation || reservation.amount < finalPrice) {
    return { ok: false, error: "Winning bid reservation is missing or insufficient", terminal: true };
  }
  // Defensive single-roster-cap re-check at settlement (see settleTransferAuction).
  const rosterFull = seniorRosterFullError(world, winner.id);
  if (rosterFull) return { ok: false, error: rosterFull, terminal: true };

  // Winner pays the system: cash leaves the economy, no club is credited (§44).
  settlePlayerPayroll(world, player);
  winner.cash -= finalPrice;
  winner.ledger.expense.push({ code: 1, amount: finalPrice, day: world.dayIndex, label: `Signing fee: ${player.name}` });

  // Apply the winning bidder's accepted contract terms and move ownership.
  player.clubId = winner.id;
  player.starter = false;
  player.starter = false;
  player.onSale = false;
  player.salary = contractSalary;
  player.contractDays = contractDaysForTerm(contractSeasons);
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
  resetPayrollPeriod(player, world.dayIndex);
  // The signing club may already wear the player's old number.
  ensureClubSquadNumbers(world, winner.id);

  recordTransaction(world, {
    playerId: player.id,
    listingId: listing.id,
    type: "FREE_AGENT_SIGNING",
    fromClubId: null,
    toClubId: winner.id,
    price: finalPrice,
    seasonId: world.mp.seasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    seasonDayIndex: world.mp.seasonDayIndex ?? world.dayIndex,
    contractSeasons,
    contractSalary,
    timestamp: now,
  });

  releaseAllReservations(world, listing.id, "FREE_AGENT");
  listing.status = "COMPLETED";
  listing.completedAt = now;
  listing.winningClubId = winner.id;
  listing.finalPrice = finalPrice;

  publishNews(world, {
    kind: "market",
    subject: NEWS_SUBJECTS.transfers,
    clubId: winner.id,
    headline: "news.headline.freeAgent",
    entries: [{
      key: `free-agent:${listing.id}`,
      label: player.name,
      detail: msg("news.detail.freeAgentSigned", { winner: winner.name, player: player.name, price: finalPrice }),
    }],
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
    if (processDueFreeAgentListing(world, listing, now).kind === "SETTLED") settled += 1;
  }
  return settled;
}

/** Process all due free-agent listings once; status transitions make retries safe. */
export function processDueFreeAgentListings(world: World, now: number): DueFreeAgentResult[] {
  const due = world.freeAgentListings.filter((listing) => listing.status === "ACTIVE" && listing.deadline <= now);
  return due.map((listing) => processDueFreeAgentListing(world, listing, now));
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
    salaryBaselineAtListing: listing.salaryBaselineAtListing,
    unclaimedSince: listing.unclaimedSince ?? listing.createdAt,
  });
  return created.ok ? created.listing.id : null;
}

export type DueFreeAgentResult =
  | { kind: "SETTLED"; listingId: number; winnerClubId: number | null; finalPrice: number | null }
  | { kind: "RELISTED"; listingId: number; newListingId: number }
  | { kind: "DELETED"; playerId: number; listingIds: number[] }
  | { kind: "FAILED"; listingId: number; error: string; terminal?: boolean };

/** Remove an unclaimed player and every live free-agent market reference. */
export function deleteUnclaimedFreeAgent(world: World, playerId: number, now: number): number[] {
  const listingIds = world.freeAgentListings.filter((listing) => listing.playerId === playerId).map((listing) => listing.id);
  for (const listing of world.freeAgentListings.filter((candidate) => listingIds.includes(candidate.id))) {
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    listing.status = "CANCELLED";
    listing.completedAt = now;
  }
  const listingIdSet = new Set(listingIds);
  world.marketBids = world.marketBids.filter((bid) => !(bid.marketType === "FREE_AGENT" && listingIdSet.has(bid.listingId)));
  world.marketReservations = world.marketReservations.filter((reservation) => !(reservation.marketType === "FREE_AGENT" && listingIdSet.has(reservation.listingId)));
  world.freeAgentListings = world.freeAgentListings.filter((listing) => listing.playerId !== playerId);
  world.players = world.players.filter((player) => player.id !== playerId);
  // Terminal deletion is a real population sink. Increment the pending counter
  // in the SAME transaction that performs the deletion, exactly once; the
  // seasonal intake is what converts it into a replacement recruit.
  recordTerminalDeletion(world);
  return listingIds;
}

/** Process one due listing for both the durable scheduler and worker fallback. */
export function processDueFreeAgentListing(world: World, listing: FreeAgentListing, now: number, opts: { forceClose?: boolean } = {}): DueFreeAgentResult {
  if (listing.status !== "ACTIVE" || (!opts.forceClose && listing.deadline > now)) return { kind: "FAILED", listingId: listing.id, error: "Listing is not due" };
  const bids = world.marketBids.filter((bid) => bid.marketType === "FREE_AGENT" && bid.listingId === listing.id);
  if (bids.length > 0) {
    const settled = settleFreeAgentListing(world, listing, now);
    return settled.ok
      ? { kind: "SETTLED", listingId: listing.id, winnerClubId: settled.winnerClubId, finalPrice: settled.finalPrice }
      : { kind: "FAILED", listingId: listing.id, error: settled.error, terminal: settled.terminal };
  }

  const unclaimedSince = listing.unclaimedSince ?? listing.createdAt;
  const retentionMs = gameConfig.freeAgentRetentionDays * 24 * 60 * 60 * 1000;
  if (now - unclaimedSince >= retentionMs) {
    const playerId = listing.playerId;
    const listingIds = deleteUnclaimedFreeAgent(world, playerId, now);
    return { kind: "DELETED", playerId, listingIds };
  }

  listing.status = "CANCELLED";
  listing.completedAt = now;
  const newListingId = relistFreeAgent(world, listing, now);
  return newListingId === null
    ? { kind: "FAILED", listingId: listing.id, error: "Could not relist free agent" }
    : { kind: "RELISTED", listingId: listing.id, newListingId };
}

/**
 * Expire + relist all due no-bid free-agent listings (§54). Returns the number
 * of listings that were expired and relisted.
 */
export function relistDueFreeAgents(world: World, now: number): number {
  let count = 0;
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || listing.deadline > now) continue;
    if (processDueFreeAgentListing(world, listing, now).kind === "RELISTED") count += 1;
  }
  return count;
}

/** Public projection for one free-agent listing (never competing maximums, §15). */
export function freeAgentListingView(world: World, listing: FreeAgentListing, myClubId: number | null) {
  const p = world.players.find((x) => x.id === listing.playerId);
  const myBid = myClubId !== null ? marketBidFor(world, listing.id, myClubId) : undefined;
  const salaryBaseline = listing.salaryBaselineAtListing ?? p?.salary ?? 0;
  return {
    id: listing.id,
    playerId: listing.playerId,
    playerName: p?.name ?? "",
    overall: p?.overall ?? 0,
    position: p?.position ?? 0,
    age: p?.age ?? 0,
    salary: salaryBaseline,
    contractDays: contractDaysForTerm(1),
    salaryBaseline,
    contractDemandsBySeason: p
      ? contractDemandOptions(p.overall, p.age, world.mp.seasonDayIndex ?? world.dayIndex)
      : {},
    skills: p?.skills ?? { gol: 0, pace: 0, tec: 0, pas: 0, des: 0, playmaking: 0, fin: 0 },
    value: listing.playerValueAtListing,
    openingPrice: listing.openingPrice,
    currentPrice: listing.currentPrice,
    bidIncrement: listing.bidIncrement,
    bidderCount: world.marketBids.filter((b) => b.listingId === listing.id).length,
    deadline: listing.deadline,
    relistStage: listing.relistStage,
    status: listing.status,
    myMaxBid: myBid?.maxBid ?? null,
    myContractSeasons: myBid?.contractSeasons ?? null,
    myContractSalary: myBid?.contractSalary ?? null,
    amILeading: listing.leadingClubId === myClubId,
  };
}
