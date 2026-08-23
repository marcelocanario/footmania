import { gameConfig } from "../config";
import type { Club, FinancialIntervention, FinancialInterventionEntry, FreeAgentListing, Player, World } from "./types";
import { createRng, nextInt } from "./rng";
import { generateSeniorPlayer } from "./playerGeneration";
import { divisionForClub, lowestActiveTier } from "./multiplayer";
import { playerHasActiveListing } from "./market";
import { settleTransferAuction, cancelTransferAuction, recordTransaction, auctionOpeningRange, resolveOpeningPrice, releaseAllReservations } from "./market";
import { prepareFreeAgentListing } from "./freeAgents";
import { settlePlayerPayroll, resetPayrollPeriod } from "./payroll";
import { ensureClubSquadNumbers } from "./squadNumbers";

/**
 * Financial system (plans/5. financial-control.md).
 *
 * One simple derived value drives everything:
 *
 *   FinancialCushion = club.cash - activeBidCommitments - remainingSalaryCommitments
 *                    - contingent leading-bid salaries
 *
 * No future income is ever forecast. Humans may deliberately push their
 * cushion negative (warned, not blocked). Ephemeral filler-AI clubs are
 * financially inert (invariant #28): they hold no cash and never appear here.
 * When a human club stays cash-negative across a payroll cycle, a financial
 * intervention resolves outgoing auctions and system-liquidates players to
 * restore solvency, generating same-position replacement players from the
 * normal new-club generation distribution.
 */

export interface CommitmentTotals {
  /** Sum of durable active market reservations (binding bid commitments). */
  activeBidCommitments: number;
  /** Remaining salary the club must pay from the next unpaid payroll through season end. */
  remainingSalaryCommitments: number;
  /** Contingent salary of binding leading-bid acquisitions (§6). */
  contingentSalary: number;
  /** The club's financial cushion = cash - bids - salaries - contingent. */
  financialCushion: number;
  /** cash - activeBidCommitments: what can fund a new immediate expense (§9). */
  immediateAvailableCash: number;
}

/**
 * Salary charged by the authoritative payroll formula between two days.
 * Keeping this calculation here avoids replacing payroll's rounded cumulative
 * target with a separate annual-salary approximation.
 */
export function salaryCommitmentForPeriod(salary: number, startDay: number, endDay: number): number {
  const start = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(startDay)));
  const end = Math.max(start, Math.min(gameConfig.seasonDays, Math.trunc(endDay)));
  return Math.max(0, Math.round((salary * (end - start)) / gameConfig.seasonDays));
}

/** Salary still due for a player through a season/horizon endpoint. */
export function remainingSalaryCommitmentForPlayer(player: Player, throughDay = gameConfig.seasonDays): number {
  const start = Math.max(0, Math.min(gameConfig.seasonDays, Math.trunc(player.payrollPeriodStartDay)));
  const through = Math.max(start, Math.min(gameConfig.seasonDays, Math.trunc(throughDay)));
  const target = salaryCommitmentForPeriod(player.salary, start, through);
  return Math.max(0, target - Math.max(0, Math.round(player.payrollPaidAmount)));
}

/** Remaining season fraction used for a new acquisition at the current day. */
export function remainingSeasonFraction(world: World): number {
  const seasonDayIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  return Math.max(0, (gameConfig.seasonDays - seasonDayIndex) / gameConfig.seasonDays);
}

/**
 * Salaries the club is responsible for from the next unpaid payroll through
 * season end (financial-control §5). Includes owned active players and
 * loaned-in players (borrower pays 100% of wages); excludes loaned-out
 * players and free agents. Academy/youth players are included because active
 * payroll charges their salary just like senior payroll.
 */
export function remainingSalaryCommitments(world: World, club: Club): number {
  // Provisional clubs do not pay current-season salaries, but their warning
  // must include the funded season that starts when they activate (§7/§76).
  // Payroll state is frozen before activation, so that horizon starts at day 0.
  if (club.competitionState === "PROVISIONAL") {
    return world.players
      .filter((player) => player.clubId === club.id && player.loanId === null)
      .reduce((sum, player) => sum + salaryCommitmentForPeriod(player.salary, 0, gameConfig.seasonDays), 0);
  }
  if (club.competitionState !== "ACTIVE") return 0;

  const loanedInIds = new Set<number>();
  for (const loan of world.loans) {
    if (loan.recalled || loan.toClubId === null || loan.toClubId !== club.id) continue;
    loanedInIds.add(loan.playerId);
  }

  let total = 0;
  for (const player of world.players) {
    if (player.clubId !== club.id) continue;
    // Loaned-out players are outside this club's current wage responsibility
    // (§5/§28); loaned-in players are handled through the active loan map.
    if (player.loanId !== null && !loanedInIds.has(player.id)) continue;
    const loan = player.loanId === null ? undefined : world.loans.find((candidate) => candidate.id === player.loanId);
    const horizon = loan && loan.toClubId === club.id ? Math.min(gameConfig.seasonDays, loan.endDay) : gameConfig.seasonDays;
    total += remainingSalaryCommitmentForPlayer(player, horizon);
  }
  return Math.round(total);
}

/**
 * Contingent salary the club is committed to because it leads a binding
 * acquisition auction (financial-control §6). When the club is outbid the
 * reservation is released and this commitment disappears with it.
 */
export function contingentSalaryFromLeadingBids(world: World, club: Club): number {
  const activeIds = new Set(
    world.marketReservations
      .filter((r) => r.clubId === club.id && r.releasedAt === null)
      .map((r) => r.listingId)
  );
  const salaryStartDay = club.competitionState === "PROVISIONAL" ? 0 : (world.mp.seasonDayIndex ?? world.dayIndex);
  let total = 0;
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE" || listing.leadingClubId !== club.id || !activeIds.has(listing.id)) continue;
    const player = world.players.find((p) => p.id === listing.playerId);
    if (!player) continue;
    const bid = world.marketBids.find((candidate) => candidate.marketType === "TRANSFER" && candidate.listingId === listing.id && candidate.clubId === club.id);
    total += salaryCommitmentForPeriod(bid?.contractSalary ?? player.salary, salaryStartDay, gameConfig.seasonDays);
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || listing.leadingClubId !== club.id || !activeIds.has(listing.id)) continue;
    const bid = world.marketBids.find((candidate) => candidate.marketType === "FREE_AGENT" && candidate.listingId === listing.id && candidate.clubId === club.id);
    total += salaryCommitmentForPeriod(bid?.contractSalary ?? listing.salaryBaselineAtListing ?? 0, salaryStartDay, gameConfig.seasonDays);
  }
  return Math.round(total);
}

/** Sum of a club's active market reservations (their binding bid commitments). */
export function activeBidCommitments(world: World, club: Club): number {
  return world.marketReservations
    .filter((r) => r.clubId === club.id && r.releasedAt === null)
    .reduce((sum, r) => sum + r.amount, 0);
}

/**
 * The core derived financial metric (financial-control §2). No future income
 * is ever included.
 */
export function getFinancialCushion(world: World, club: Club): number {
  return club.cash - activeBidCommitments(world, club) - remainingSalaryCommitments(world, club) - contingentSalaryFromLeadingBids(world, club);
}

/** cash - activeBidCommitments: the ceiling for a new immediate expense (§9). */
export function getImmediateAvailableCash(world: World, club: Club): number {
  return club.cash - activeBidCommitments(world, club);
}

/** All commitment figures for a club (single pass for the UI / warnings). */
export function getCommitmentTotals(world: World, club: Club): CommitmentTotals {
  const bids = activeBidCommitments(world, club);
  const salaries = remainingSalaryCommitments(world, club);
  const contingent = contingentSalaryFromLeadingBids(world, club);
  return {
    activeBidCommitments: bids,
    remainingSalaryCommitments: salaries,
    contingentSalary: contingent,
    financialCushion: club.cash - bids - salaries - contingent,
    immediateAvailableCash: club.cash - bids,
  };
}

export type FinancialState = "SAFE" | "AT_RISK" | "NEGATIVE_CASH";

/** Human warning states (financial-control §17). */
export function financialState(world: World, club: Club): FinancialState {
  if (club.cash < 0) return "NEGATIVE_CASH";
  if (getFinancialCushion(world, club) < 0) return "AT_RISK";
  return "SAFE";
}

// ---------------------------------------------------------------------------
// System liquidation price (§32)
// ---------------------------------------------------------------------------

/**
 * The price the system pays when liquidating a player during a financial
 * intervention: the MINIMUM price that would be acceptable in a normal auction
 * (the opening-price floor, 60% of the base value). Reuses the transfer-market
 * authority so auction floors and recent-market anchors apply. Paying below
 * market keeps the intervention from being farmable as a full-value liquidity
 * pump. Never hard-coded (§32).
 */
export function systemLiquidationPrice(world: World, player: Player): number {
  const range = auctionOpeningRange(world, player);
  const resolved = resolveOpeningPrice(world, player, range.min);
  return resolved.ok ? resolved.openingPrice : range.min;
}

// ---------------------------------------------------------------------------
// Replacement generation (§37-§42)
// ---------------------------------------------------------------------------

export interface ReplacementContext {
  /** Season of the intervention (the season being played). */
  seasonId: number;
  /** Division the club currently plays in (drives the generation distribution). */
  currentDivision: number;
  highestDivisionReached: number;
  totalDivisions: number;
}

/**
 * Generate a same-position replacement player using the exact new-club
 * generation path (§37-§40). The seed folds in the stable intervention key + departed
 * player id + position so a retry reproduces the identical player (§41). The
 * replacement is tagged with the intervention season so it cannot be
 * system-liquidated again during the same season (§31). Does NOT push into
 * world.players until the caller persists it (preview-first, §22/§42).
 */
export function makeReplacementPlayer(
  world: World,
  club: Club,
  departedPlayer: Player,
  ctx: ReplacementContext,
  interventionSeed: number
): Player {
  const seed = fnv1a(`${interventionSeed}|${departedPlayer.id}|${departedPlayer.position}`);
  const rng = createRng(seed);
  const player = generateSeniorPlayer({
    id: world.nextId++,
    clubId: club.id,
    country: club.country,
    position: departedPlayer.position,
    isYouth: false,
    currentDivision: ctx.currentDivision,
    highestDivisionReached: ctx.highestDivisionReached,
    totalDivisions: ctx.totalDivisions,
    seasonId: ctx.seasonId,
    generationType: "replacement",
    seed: seed >>> 0,
    slot: nextInt(rng, 1_000_000),
  });
  player.financialInterventionGeneratedSeasonId = ctx.seasonId;
  resetPayrollPeriod(player, world.dayIndex);
  return player;
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Intervention candidate pool (§30/§31)
// ---------------------------------------------------------------------------

function interventionCandidatePool(world: World, club: Club): Player[] {
  const loanedInIds = new Set<number>();
  const loanedOutIds = new Set<number>();
  for (const loan of world.loans) {
    if (loan.recalled) continue;
    if (loan.toClubId !== null) {
      if (loan.toClubId === club.id) loanedInIds.add(loan.playerId);
      if (loan.fromClubId === club.id) loanedOutIds.add(loan.playerId);
    }
  }
  return world.players.filter((p) => {
    if (p.clubId !== club.id) return false;
    if (p.isYouth) return false;
    // Loaned-in and loaned-out players are never system-liquidatable (§28).
    if (loanedInIds.has(p.id)) return false;
    if (loanedOutIds.has(p.id)) return false;
    if (p.loanId !== null) return false;
    if (playerHasActiveListing(world, p)) return false;
    // Infinite-money protection (§31): intervention replacements are not
    // eligible for another system liquidation during the same season.
    if (p.financialInterventionGeneratedSeasonId === world.mp.seasonId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Subset selection (§45-§48)
// ---------------------------------------------------------------------------

export interface LiquidationCandidate {
  player: Player;
  /** System liquidation price Pi. */
  price: number;
  /** Remaining salary commitment Wi removed when the player leaves. */
  salaryRelief: number;
  /** Remaining salary commitment Gi of the preview replacement. */
  replacementSalary: number;
  /** Pi + Wi - Gi (§44). */
  effectiveRecovery: number;
  /** Preview replacement (in-memory only until the player is selected). */
  previewReplacement: Player | null;
}

/**
 * Exact meet-in-the-middle subset search (§47). Finds the subset of candidates
 * whose effective recovery is >= required while minimizing overshoot; ties are
 * broken by fewest players, then deterministic ordering (§46). O(2^(N/2)).
 */
export function selectLiquidationSubset(
  candidates: { player: Player; effectiveRecovery: number }[],
  required: number
): number[] {
  const n = candidates.length;
  if (n === 0) return [];
  if (required <= 0) return [];

  const allPositive = candidates.every((c) => c.effectiveRecovery > 0);
  if (allPositive) {
    const sum = candidates.reduce((a, c) => a + c.effectiveRecovery, 0);
    if (sum < required) {
      // Even the full positive set cannot cover the shortfall (§49): select
      // everything and report the shortfall to the caller.
      return candidates.map((_, i) => i);
    }
  }

  const mid = Math.floor(n / 2);
  const left = candidates.slice(0, mid);
  const right = candidates.slice(mid);

  type Subset = { mask: number; recovery: number; count: number };
  const leftSets: Subset[] = [];
  for (let mask = 0; mask < 1 << left.length; mask++) {
    let recovery = 0;
    let count = 0;
    for (let i = 0; i < left.length; i++) {
      if (mask & (1 << i)) {
        recovery += left[i].effectiveRecovery;
        count++;
      }
    }
    leftSets.push({ mask, recovery, count });
  }
  const rightSets: Subset[] = [];
  for (let mask = 0; mask < 1 << right.length; mask++) {
    let recovery = 0;
    let count = 0;
    for (let i = 0; i < right.length; i++) {
      if (mask & (1 << i)) {
        recovery += right[i].effectiveRecovery;
        count++;
      }
    }
    rightSets.push({ mask, recovery, count });
  }

  // For each right recovery, keep the fewest-player (and lowest-mask) subset so
  // the §46 tie-break is honoured.
  const bestRight = new Map<number, { recovery: number; count: number; mask: number }>();
  for (const s of rightSets) {
    const existing = bestRight.get(s.recovery);
    if (!existing || s.count < existing.count || (s.count === existing.count && s.mask < existing.mask)) {
      bestRight.set(s.recovery, s);
    }
  }
  const rightRecoveries = [...bestRight.keys()].sort((a, b) => a - b);

  let best: { maskL: number; maskR: number; recovery: number; overshoot: number; count: number } | null = null;
  for (const s of leftSets) {
    const need = required - s.recovery;
    if (need <= 0) {
      const candidate = { maskL: s.mask, maskR: 0, recovery: s.recovery, overshoot: s.recovery - required, count: s.count };
      if (!best || better(candidate, best)) best = candidate;
      continue;
    }
    // Smallest right recovery >= need (minimal overshoot).
    let lo = 0;
    let hi = rightRecoveries.length - 1;
    let found: number | null = null;
    while (lo <= hi) {
      const mid2 = (lo + hi) >> 1;
      if (rightRecoveries[mid2] >= need) {
        found = rightRecoveries[mid2];
        hi = mid2 - 1;
      } else {
        lo = mid2 + 1;
      }
    }
    if (found === null) continue;
    const r = bestRight.get(found)!;
    const candidate = {
      maskL: s.mask,
      maskR: r.mask,
      recovery: s.recovery + r.recovery,
      overshoot: s.recovery + r.recovery - required,
      count: s.count + r.count,
    };
    if (!best || better(candidate, best)) best = candidate;
  }

  if (!best) return [];
  const selected: number[] = [];
  for (let i = 0; i < left.length; i++) {
    if (best.maskL & (1 << i)) selected.push(i);
  }
  for (let j = 0; j < right.length; j++) {
    if (best.maskR & (1 << j)) selected.push(mid + j);
  }
  return selected;
}

function better(a: { overshoot: number; count: number; maskL: number; maskR: number }, b: { overshoot: number; count: number; maskL: number; maskR: number }): boolean {
  if (a.overshoot !== b.overshoot) return a.overshoot < b.overshoot;
  if (a.count !== b.count) return a.count < b.count;
  return a.maskL * 2 + a.maskR < b.maskL * 2 + b.maskR;
}

// ---------------------------------------------------------------------------
// Financial intervention execution (§50-§54)
// ---------------------------------------------------------------------------

/**
 * Run the full financial intervention for a club (financial-control §50).
 * Mutates only the in-memory world; the caller is responsible for the global
 * lock + Save.revision transaction. Idempotent per (clubId, seasonId,
 * payrollCycleId) via world.financialInterventions (§52).
 */
export function runFinancialIntervention(
  world: World,
  club: Club,
  opts: { seasonId?: number; payrollCycleId?: number; now?: number } = {}
): { ok: true; intervention: FinancialIntervention } | { ok: false; error: string } {
  if (club.competitionState !== "ACTIVE") return { ok: false, error: "Only active clubs can enter financial intervention" };
  const seasonId = opts.seasonId ?? world.mp.seasonId;
  const payrollCycleId = opts.payrollCycleId ?? world.dayIndex;
  const now = opts.now ?? Date.now();

  // Idempotency: one intervention per payroll cycle (§52).
  const already = world.financialInterventions.find(
    (intervention) => intervention.clubId === club.id && intervention.seasonId === seasonId && intervention.payrollCycleId === payrollCycleId
  );
  if (already) return { ok: false, error: "Financial intervention already executed for this payroll cycle" };

  const entries: FinancialInterventionEntry[] = [];
  const cashBefore = club.cash;
  const commitmentsBefore = activeBidCommitments(world, club) + remainingSalaryCommitments(world, club) + contingentSalaryFromLeadingBids(world, club);
  const cushionBefore = getFinancialCushion(world, club);

  const replacementCtx: ReplacementContext = {
    seasonId,
    currentDivision: divisionForClub(world, club.id),
    highestDivisionReached: club.highestDivision,
    totalDivisions: Math.max(1, lowestActiveTier(world, seasonId)),
  };
  // Keep the audit row's entity id unique, but derive replacement randomness
  // from the idempotency key rather than the mutable next-id cursor. If an
  // in-memory retry happens after a domain error, the same key still produces
  // the same replacement profiles (§41/§52).
  const interventionId = world.nextId++;
  const interventionSeed = fnv1a(`${club.id}|${seasonId}|${payrollCycleId}`);

  // --- 1. Resolve/cancel outgoing auctions (§23-§26) ---
  let forcedAuctionRevenue = 0;
  const forcedAuctionSettlements: FinancialInterventionEntry[] = [];
  for (const listing of [...world.transferAuctions]) {
    if (listing.status !== "ACTIVE" || listing.sellerClubId !== club.id) continue;
    const bids = world.marketBids.filter((b) => b.listingId === listing.id);
    if (bids.length === 0) {
      // No bids → cancel immediately; the player returns to the candidate pool.
      cancelTransferAuction(world, listing);
      entries.push({ playerId: listing.playerId, kind: "FORCED_AUCTION_CANCELLED", price: null, replacementPlayerId: null });
      continue;
    }
    // Valid bid → settle immediately at the current proxy clearing price
    // (never the leader's private maximum) (§25/§26). Force-close bypasses
    // the deadline check without mutating the listing.
    const settled = settleTransferAuction(world, listing, now, { forceClose: true });
    if (settled.ok) {
      forcedAuctionRevenue += settled.finalPrice ?? 0;
      const entry: FinancialInterventionEntry = { playerId: listing.playerId, kind: "FORCED_AUCTION", price: settled.finalPrice, replacementPlayerId: null };
      entries.push(entry);
      forcedAuctionSettlements.push(entry);
    } else {
      // Fail closed: cancel rather than leave a broken listing (§22).
      releaseAllReservations(world, listing.id, "TRANSFER");
      listing.status = "CANCELLED";
      listing.cancelledAt = now;
      const player = world.players.find((candidate) => candidate.id === listing.playerId);
      if (player) player.onSale = false;
      entries.push({ playerId: listing.playerId, kind: "FORCED_AUCTION_CANCELLED", price: null, replacementPlayerId: null });
    }
  }

  // Unclaimed outgoing loan listings have no cash value; cancel them so their
  // players can re-enter the candidate pool (§29). Claimed/active loans are
  // excluded (§28).
  for (const loan of world.loans) {
    if (loan.recalled || loan.fromClubId !== club.id || loan.toClubId !== null) continue;
    loan.recalled = true;
    const player = world.players.find((p) => p.id === loan.playerId);
    if (player && player.loanId === loan.id) player.loanId = null;
  }

  // Capture current-player salaries after auction reconciliation but before
  // adding the replacements required by forced departures.
  const salaryBeforeForcedReplacements = remainingSalaryCommitments(world, club);

  // Forced auction settlements removed players: each gets a same-position
  // replacement (§37). A no-bid cancellation does not remove the player and
  // therefore must not create an extra replacement.
  const forcedReplacements: Player[] = [];
  for (const entry of forcedAuctionSettlements) {
    const departed = world.players.find((p) => p.id === entry.playerId);
    if (!departed) continue;
    const replacement = makeReplacementPlayer(world, club, departed, replacementCtx, interventionSeed);
    world.players.push(replacement);
    forcedReplacements.push(replacement);
    entry.replacementPlayerId = replacement.id;
  }

  // --- 2. Recalculate cash and commitments (§27) ---
  const C = club.cash;
  const B = activeBidCommitments(world, club);
  // Calculate current-player salaries before adding forced replacements so R
  // is counted exactly once in the recovery target (§43).
  const S = salaryBeforeForcedReplacements;
  const contingent = contingentSalaryFromLeadingBids(world, club);
  const R = forcedReplacements.reduce((sum, r) => sum + remainingSalaryCommitmentForPlayer(r), 0);

  // Required recovery D (§43).
  const D = Math.max(0, B + S + contingent + R - C);

  let systemLiquidationRevenue = 0;
  let unableToFullyRecover = false;

  if (D > 0) {
    // --- 3. Build the system-liquidation candidate pool (§30) ---
    const pool = interventionCandidatePool(world, club);
    const candidates: LiquidationCandidate[] = pool.map((player) => {
      const price = systemLiquidationPrice(world, player);
      const salaryRelief = remainingSalaryCommitmentForPlayer(player);
      return { player, price, salaryRelief, replacementSalary: 0, effectiveRecovery: 0, previewReplacement: null };
    });

    // --- 4. Preview one same-position replacement per candidate (§37) and
    // ---    compute EffectiveRecovery (§44) ---
    for (const candidate of candidates) {
      const preview = makeReplacementPlayer(world, club, candidate.player, replacementCtx, interventionSeed);
      candidate.previewReplacement = preview;
      candidate.replacementSalary = remainingSalaryCommitmentForPlayer(preview);
      candidate.effectiveRecovery = candidate.price + candidate.salaryRelief - candidate.replacementSalary;
    }

    // --- 5. Never select a player whose sale makes recovery worse (§48) ---
    const viable = candidates.filter((c) => c.effectiveRecovery > 0);
    const selectedIndices = selectLiquidationSubset(viable.map((c) => ({ player: c.player, effectiveRecovery: c.effectiveRecovery })), D);
    const preparedListings = new Map<number, FreeAgentListing>();
    for (const idx of selectedIndices) {
      const candidate = viable[idx];
      if (!candidate) continue;
      const prepared = prepareFreeAgentListing(world, candidate.player, {
        now,
        blockedClubId: club.id,
        allowOwnedPlayer: true,
      });
      if (!prepared.ok) {
        // Candidates were filtered from the same eligibility rules. Throw
        // before any selected player is changed so the caller's save
        // transaction fails closed (§22/§51).
        throw new Error(`Financial intervention could not prepare a free-agent listing: ${prepared.error}`);
      }
      preparedListings.set(candidate.player.id, prepared.listing);
    }

    let effectiveRecovered = 0;
    for (const idx of selectedIndices) {
      const candidate = viable[idx];
      if (!candidate) continue;
      const player = candidate.player;
      const preview = candidate.previewReplacement;

      // System liquidation: the club receives the normal opening price, the
      // player leaves and becomes a normal free agent (§33/§34).
      settlePlayerPayroll(world, player);
      club.cash += candidate.price;
      club.ledger.income.push({ code: 15, amount: candidate.price, day: world.dayIndex, label: `Financial intervention: ${player.name}` });
      player.clubId = null;
      player.onSale = false;
      player.tacPos = -1;
      player.starter = false;
      resetPayrollPeriod(player, world.dayIndex);

      // Persist the already-previewed replacement (§22: replacement first).
      if (preview) {
        preview.clubId = club.id;
        world.players.push(preview);
        // Replacement joins with a number no squadmate wears.
        ensureClubSquadNumbers(world, club.id);
      }
      effectiveRecovered += candidate.effectiveRecovery;

      // The resulting free-agent listing blocks the former club (§35).
      const listing = preparedListings.get(player.id);
      if (!listing) throw new Error(`Financial intervention lost the prepared free-agent listing for player ${player.id}`);
      world.freeAgentListings.push(listing);
      world.news.push({
        dayIndex: world.dayIndex,
        text: `${player.name} left ${club.name} due to unpaid wages and is now a free agent`,
        kind: "finance",
        clubId: club.id,
      });

      recordTransaction(world, {
        playerId: player.id,
        listingId: listing.id,
        type: "FREE_AGENT_SIGNING",
        fromClubId: club.id,
        toClubId: null,
        price: candidate.price,
        seasonId,
        seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
        seasonDayIndex: world.mp.seasonDayIndex ?? world.dayIndex,
        contractSeasons: null,
        contractSalary: null,
        timestamp: now,
      });

      entries.push({ playerId: player.id, kind: "SYSTEM_LIQUIDATION", price: candidate.price, replacementPlayerId: preview?.id ?? null });
      systemLiquidationRevenue += candidate.price;
    }

    // Discard the preview replacements of candidates that were NOT selected
    // (they must not leak into the persisted world, §51 no partial state).
    for (const candidate of candidates) {
      if (candidate.previewReplacement && !selectedIndices.includes(viable.indexOf(candidate))) {
        // The preview was never pushed into world.players, so nothing to undo.
        void candidate;
      }
    }

    // If even the full positive set cannot cover the shortfall, keep the club
    // in distress but never invent money or recursively liquidate new
    // replacements (§49).
    if (effectiveRecovered < D) {
      unableToFullyRecover = true;
      world.news.push({
        dayIndex: world.dayIndex,
        text: `${club.name} remains in financial difficulty despite the forced sale of players`,
        kind: "finance",
        clubId: club.id,
      });
    }
  }

  // --- 6. Final cushion (§21) ---
  const cashAfter = club.cash;
  const commitmentsAfter = activeBidCommitments(world, club) + remainingSalaryCommitments(world, club) + contingentSalaryFromLeadingBids(world, club);
  const cushionAfter = getFinancialCushion(world, club);

  const intervention: FinancialIntervention = {
    id: interventionId,
    clubId: club.id,
    seasonId,
    payrollCycleId,
    cashBefore,
    commitmentsBefore,
    cushionBefore,
    forcedAuctionRevenue,
    systemLiquidationRevenue,
    cashAfter,
    commitmentsAfter,
    cushionAfter,
    createdAt: now,
    entries,
    unableToFullyRecover,
  };
  world.financialInterventions.push(intervention);

  const departedEntries = entries.filter((entry) => entry.kind === "FORCED_AUCTION" || entry.kind === "SYSTEM_LIQUIDATION");
  if (departedEntries.length > 0) {
    const departedNames = departedEntries
      .slice(0, 3)
      .map((entry) => world.players.find((p) => p.id === entry.playerId)?.name ?? "a player");
    world.news.push({
      dayIndex: world.dayIndex,
      text: `Financial problems force players to leave: ${departedNames.join(", ")} left ${club.name} after the club failed to meet its obligations`,
      kind: "finance",
      clubId: club.id,
    });
  }

  return { ok: true, intervention };
}
