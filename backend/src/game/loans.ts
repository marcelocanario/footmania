import { MARKET_CONFIG, gameConfig } from "../config";
import type { Club, Loan, Player, World } from "./types";
import { settlePlayerPayroll } from "./payroll";
import { seasonEndDay, loanFitsContract } from "./season";
import { playerHasActiveListing, safeMarketBudget } from "./market";

/**
 * Loan market (transfer-market-overhaul Phase 9, §55-§63).
 *
 * Loans are a separate first-come, first-served market with no fee (§55).
 * Listing a player starts a PUBLIC exposure period; the player becomes
 * claimable only after it elapses (§57). Claims are atomic server-side FCFS
 * (§58) and validated for eligibility (§59). Cancellation is pre-claim only
 * (§57/§101.38). The borrower pays 100% of the salary during the loan (§56).
 * There are no purchase options (§63).
 */

/**
 * Offer a player for loan. Creates a public listing that becomes claimable
 * after the configured exposure period (§57). Zero fee (§55).
 */
export function offerPlayerForLoan(
  world: World,
  club: Club,
  player: Player,
  opts: { now?: number; startDay?: number } = {}
): { ok: true; loan: Loan } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  if (player.clubId !== club.id) return { ok: false, error: "Player not in squad" };
  if (player.isYouth) return { ok: false, error: "Youth players cannot be listed for loan" };
  if (playerHasActiveListing(world, player)) {
    return { ok: false, error: "Player already has an active market listing" };
  }
  if (world.loans.some((l) => l.playerId === player.id && !l.recalled && l.toClubId === null)) {
    return { ok: false, error: "Player already has an active loan listing" };
  }

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
    recalled: false,
    listedAt: now,
    claimableAt: now + exposureMs,
  };
  world.loans.push(loan);
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
  if (now < loan.claimableAt) {
    const secs = claimableInSeconds(loan, now);
    return { ok: false, error: `Loan becomes claimable in ${secs}s` };
  }
  const player = world.players.find((p) => p.id === loan.playerId);
  if (!player) return { ok: false, error: "Player not found" };
  if (player.loanId !== null && player.loanId !== loan.id) return { ok: false, error: "Player is already on loan" };
  if (!loanFitsContract(world.dayIndex, loan.endDay, player.contractDays)) {
    return { ok: false, error: "Loan duration exceeds the player's remaining contract" };
  }
  // §56: borrower pays 100% of the salary; affordability check uses the same
  // shared safe-budget validator as auction/free-agent bids (§24/§102.10), not
  // a naive `cash >= salary` comparison that ignores other committed payroll.
  const budget = safeMarketBudget(world, club, { acquisitionSalary: player.salary });
  if (budget <= 0) return { ok: false, error: "Club cannot afford the player's salary" };

  // Atomic claim: within the caller's lock + transaction this is the only
  // mutation of this listing, so FCFS is guaranteed (§58).
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
 * Reconcile loans at season rollover (§17). Unclaimed listings are cancelled;
 * active loans end and the player returns to the owner. Returns the number of
 * loans resolved.
 */
export function reconcileLoansAtRollover(world: World): number {
  let resolved = 0;
  for (const loan of world.loans) {
    if (loan.recalled) continue;
    if (loan.toClubId === null) {
      // Unclaimed listing: cancel and clear the player's loanId.
      loan.recalled = true;
      const p = world.players.find((x) => x.id === loan.playerId);
      if (p && p.loanId === loan.id) p.loanId = null;
    } else {
      // Active loan: return the player to the owner.
      returnLoanedPlayer(world, loan);
    }
    resolved += 1;
  }
  return resolved;
}
