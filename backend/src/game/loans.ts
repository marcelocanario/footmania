import { MARKET_CONFIG, gameConfig } from "../config";
import type { Club, Loan, Player, World } from "./types";
import { resetPayrollPeriod, settlePlayerPayroll } from "./payroll";
import { seasonEndDay, loanFitsContract } from "./season";
import { playerHasActiveListing, recordTransaction } from "./market";
import { seniorRosterFullError, isEphemeralAI } from "./club";
import { newClubSellLockError } from "./league";
import { getImmediateAvailableCash } from "./finance";

/**
 * Loan market (transfer-market-overhaul Phase 9, §55-§63).
 *
 * Loans are a separate first-come, first-served market with a lender-chosen
 * fee (§55): the listing owner picks a fee between the configured min/max
 * fractions of the player's value, and the borrower pays it at claim time.
 * Listing a player starts a PUBLIC exposure period; the player becomes
 * claimable only after it elapses (§57). Claims are atomic server-side FCFS
 * (§58) and validated for eligibility (§59) plus the shared senior-roster cap
 * and the borrowed-player cap. Cancellation is pre-claim only (§57/§101.38).
 * The borrower pays 100% of the salary during the loan (§56). There are no
 * purchase options (§63).
 *
 * Season bounds (review C7): a loan always ends with the current season, and
 * the market freezes after the last league game day — no new listings, no
 * claims — until the next pre-season opens.
 */

/** True once the season's last league game day has passed (post-match/interseason). */
export function loanMarketFrozen(world: World): boolean {
  const seasonDay = world.mp.seasonDayIndex ?? world.dayIndex;
  return seasonDay > gameConfig.lastLeagueMatchDayIndex;
}

/** Active loans claimed by a club (the borrowed-player cap population). */
export function activeLoanedInCount(world: World, clubId: number): number {
  return world.loans.filter((l) => !l.recalled && l.toClubId === clubId).length;
}

/** Error string when the club is at/over the borrowed-player cap, else null. */
export function borrowedCapError(world: World, clubId: number): string | null {
  return activeLoanedInCount(world, clubId) >= MARKET_CONFIG.loans.maxLoanedInPerClub
    ? `You already have the maximum of ${MARKET_CONFIG.loans.maxLoanedInPerClub} borrowed players`
    : null;
}

/**
 * Offer a player for loan. Creates a public listing that becomes claimable
 * after the configured exposure period (§57). The owner chooses the claim fee
 * as a fraction of the player's value within the configured band; it defaults
 * to the minimum.
 */
export function offerPlayerForLoan(
  world: World,
  club: Club,
  player: Player,
  opts: { now?: number; startDay?: number; feeRatio?: number } = {}
): { ok: true; loan: Loan } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  // Invariant #28: ephemeral filler-AI clubs never list players for loan.
  if (isEphemeralAI(club)) return { ok: false, error: "AI clubs cannot list players for loan" };
  if (loanMarketFrozen(world)) return { ok: false, error: "The loan market is closed until next season" };
  if (player.clubId !== club.id) return { ok: false, error: "Player not in squad" };
  if (player.isYouth) return { ok: false, error: "Youth players cannot be listed for loan" };
  // New-club outbound lock: buying/releasing stay open, loaning out does not.
  const sellLock = newClubSellLockError(world, club.id);
  if (sellLock) return { ok: false, error: sellLock };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "Player already has an active market listing" };
  }
  if (world.loans.some((l) => l.playerId === player.id && !l.recalled && l.toClubId === null)) {
    return { ok: false, error: "Player already has an active loan listing" };
  }

  const { feeMinValueRatio, feeMaxValueRatio } = MARKET_CONFIG.loans;
  const requestedRatio = opts.feeRatio ?? feeMinValueRatio;
  if (!Number.isFinite(requestedRatio) || requestedRatio < feeMinValueRatio || requestedRatio > feeMaxValueRatio) {
    return {
      ok: false,
      error: `Loan fee must be between ${Math.round(feeMinValueRatio * 100)}% and ${Math.round(feeMaxValueRatio * 100)}% of the player's value`,
    };
  }
  // Absolute snapshot at listing time so later value drift cannot move the fee.
  const feeAmount = Math.max(1, Math.round(player.value * requestedRatio));

  const startDay = opts.startDay ?? world.dayIndex;
  const endDay = seasonEndDay(startDay, gameConfig.seasonDays - (startDay % gameConfig.seasonDays));
  if (!loanFitsContract(startDay, endDay, player.contractDays)) {
    return { ok: false, error: "Loan duration exceeds the player's remaining contract" };
  }

  const exposureMs = MARKET_CONFIG.loans.exposureMinutes * 60 * 1000;
  const loan: Loan = {
    id: world.nextId++,
    playerId: player.id,
    fromClubId: club.id,
    toClubId: null,
    startDay,
    endDay,
    feeAmount,
    recalled: false,
    listedAt: now,
    claimableAt: now + exposureMs,
  };
  world.loans.push(loan);
  world.mp.loanEndAbsoluteGameDays ??= {};
  world.mp.loanEndAbsoluteGameDays[String(loan.id)] = (world.mp.absoluteGameDay ?? world.dayIndex) + (endDay - startDay);
  player.loanId = loan.id;
  return { ok: true, loan };
}

/** Seconds remaining until a listing becomes claimable (0 when already so). */
export function claimableInSeconds(loan: Loan, now: number): number {
  return Math.max(0, Math.ceil((loan.claimableAt - now) / 1000));
}

/**
 * Claim a loan listing first-come, first-served (§58/§59). Only valid after
 * the public exposure period elapses; the first valid server-side claim wins.
 */
export function claimLoan(
  world: World,
  club: Club,
  loan: Loan,
  opts: { now?: number } = {}
): { ok: true; loan: Loan } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  if (loan.recalled) return { ok: false, error: "Loan listing was cancelled" };
  if (loan.toClubId !== null) return { ok: false, error: "Loan is no longer available" };
  if (loan.fromClubId === club.id) return { ok: false, error: "Cannot claim your own loan listing" };
  // Invariant #28: ephemeral filler-AI clubs never claim loan listings.
  if (isEphemeralAI(club)) return { ok: false, error: "AI clubs cannot claim loans" };
  if (loanMarketFrozen(world)) return { ok: false, error: "The loan market is closed until next season" };
  if (now < loan.claimableAt) {
    const secs = claimableInSeconds(loan, now);
    return { ok: false, error: `Loan becomes claimable in ${secs}s` };
  }
  const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
  const absoluteEnd = world.mp.loanEndAbsoluteGameDays?.[String(loan.id)] ?? loan.endDay;
  if (absoluteEnd <= currentAbsolute) return { ok: false, error: "Loan listing has expired" };
  // Shared senior-roster cap: a full squad cannot borrow another player.
  const rosterFull = seniorRosterFullError(world, club.id);
  if (rosterFull) return { ok: false, error: rosterFull };
  // Borrowed-player cap (§59): bound how many loaned players one club can hold.
  const borrowedCap = borrowedCapError(world, club.id);
  if (borrowedCap) return { ok: false, error: borrowedCap };
  const player = world.players.find((p) => p.id === loan.playerId);
  if (!player) return { ok: false, error: "Player not found" };
  if (player.loanId !== null && player.loanId !== loan.id) return { ok: false, error: "Player is already on loan" };
  if (!loanFitsContract(world.dayIndex, loan.endDay, player.contractDays)) {
    return { ok: false, error: "Loan duration exceeds the player's remaining contract" };
  }

  // §55/§9: the lender-chosen fee is a binding immediate obligation paid by
  // the borrower to the lender at claim time. It requires actual unreserved
  // cash — binding bid reservations are not spendable.
  const feeAmount = Math.max(0, Math.round(loan.feeAmount ?? 0));
  if (feeAmount > getImmediateAvailableCash(world, club)) {
    return { ok: false, error: "You cannot afford the loan fee with your unreserved cash" };
  }

  // Atomic claim: within the caller's lock + transaction this is the only
  // mutation of this listing, so FCFS is guaranteed (§58).
  // Settle the lender's accrued wages before ownership moves, then start the
  // borrower's payroll clock at the claim day. This keeps the financial
  // commitment horizon aligned with who actually owes the wages.
  settlePlayerPayroll(world, player);
  resetPayrollPeriod(player, world.dayIndex);
  if (feeAmount > 0) {
    const lender = world.clubs.find((candidate) => candidate.id === loan.fromClubId);
    club.cash -= feeAmount;
    club.ledger.expense.push({ code: 16, amount: feeAmount, day: world.dayIndex, label: `Loan fee: ${player.name}` });
    if (lender && !isEphemeralAI(lender)) {
      // Invariant #28: ephemeral AI clubs hold no cash. A claim of a legacy
      // AI-owned listing burns the fee instead of crediting the filler.
      lender.cash += feeAmount;
      lender.ledger.income.push({ code: 16, amount: feeAmount, day: world.dayIndex, label: `Loan fee received: ${player.name}` });
    }
    recordTransaction(world, {
      playerId: player.id,
      listingId: null,
      type: "LOAN",
      fromClubId: loan.fromClubId,
      toClubId: club.id,
      price: feeAmount,
      seasonId: world.mp.seasonId,
      seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
      seasonDayIndex: world.mp.seasonDayIndex ?? world.dayIndex,
      contractSeasons: null,
      contractSalary: null,
      timestamp: now,
    });
  }
  loan.toClubId = club.id;
  player.clubId = club.id;
  player.loanId = loan.id;
  player.tacPos = -1;
  return { ok: true, loan };
}

/**
 * Cancel an UNCLAIMED loan listing (pre-claim only, §57/§101.38). A listing
 * that has already been claimed cannot be recalled.
 */
export function cancelLoanListing(
  world: World,
  club: Club,
  loan: Loan
): { ok: true } | { ok: false; error: string } {
  if (loan.fromClubId !== club.id) return { ok: false, error: "Only the owning club can cancel this listing" };
  if (loan.toClubId !== null) return { ok: false, error: "A claimed loan cannot be recalled" };
  loan.recalled = true;
  const player = world.players.find((p) => p.id === loan.playerId);
  if (player && player.loanId === loan.id) player.loanId = null;
  return { ok: true };
}

/**
 * End a loan at season end / contract expiry (§56): the player returns to the
 * owner. Used by the season cycle.
 */
export function returnLoanedPlayer(world: World, loan: Loan): void {
  const p = world.players.find((x) => x.id === loan.playerId);
  if (p) {
    if (p.clubId !== loan.fromClubId) settlePlayerPayroll(world, p);
    p.clubId = loan.fromClubId;
    p.loanId = null;
    p.tacPos = -1;
  }
  loan.recalled = true;
}

/**
 * Revoke every UNCLAIMED loan listing (review C7). Runs at
 * SEASON_RESULTS_FINALIZE: the last league game day has passed and the market
 * is frozen, so pending listings are withdrawn while claimed loans keep
 * running until the rollover reconcile returns their players. Idempotent via
 * `recalled`. Returns the number of listings revoked.
 */
export function revokeUnclaimedLoans(world: World): number {
  let revoked = 0;
  for (const loan of world.loans) {
    if (loan.recalled || loan.toClubId !== null) continue;
    loan.recalled = true;
    const p = world.players.find((x) => x.id === loan.playerId);
    if (p && p.loanId === loan.id) p.loanId = null;
    revoked += 1;
  }
  return revoked;
}

/**
 * Reconcile loans at season rollover (§17). Unclaimed listings are cancelled;
 * active loans end and the player returns to the owner. Returns the number of
 * loans resolved.
 */
export function reconcileLoansAtRollover(world: World): number {
  const revoked = revokeUnclaimedLoans(world);
  let resolved = revoked;
  for (const loan of world.loans) {
    if (loan.recalled) continue;
    // Active loan: return the player to the owner.
    returnLoanedPlayer(world, loan);
    resolved += 1;
  }
  return resolved;
}
