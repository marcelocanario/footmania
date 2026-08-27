import type { PlayerView } from "../api/client";

/**
 * Availability of every transfer-related action for a squad player, derived
 * from the same conditions the backend enforces. These only control the
 * disabled state + tooltip — the server remains authoritative and every
 * client-visible rule mirrors a server rule.
 */
export function squadActionState(p: PlayerView, club: { finance?: { immediateAvailableCash?: number } | null } | null | undefined) {
  const senior = !p.isYouth;
  const onLoan = p.onLoan;
  const onLoanOut = p.onLoanOut;
  const onSale = p.onSale;
  const listed = p.loanId !== null || onSale;
  const releaseCash = p.isYouth ? 0 : (p.releaseClause ?? 0);
  const cash = club?.finance?.immediateAvailableCash ?? 0;

  const renew = {
    disabled: !senior || onLoan || onLoanOut || onSale,
    reason: !senior
      ? "Academy players are promoted, not renewed."
      : onLoan
        ? "This player is on loan from another club."
        : onLoanOut
          ? "This player is loaned out — recall him first."
          : onSale
            ? "This player is already listed for sale."
            : undefined,
  };
  const promote = {
    disabled: !p.isYouth || onLoanOut || listed,
    reason: onLoanOut
      ? "This player is loaned out."
      : listed
        ? "This player is already listed on the market."
        : undefined,
  };
  const loan = {
    disabled: !senior || onLoan || onSale,
    reason: !senior
      ? "Academy players cannot be loaned."
      : onLoan
        ? "This player is on loan from another club."
        : onSale
          ? "This player is already listed for sale."
          : undefined,
  };
  const recall = { disabled: !senior || !onLoanOut, reason: onLoanOut ? undefined : "Nothing to recall — this player is with you." };
  const release = {
    disabled: !senior || onLoan || onLoanOut || onSale || releaseCash > cash,
    reason: !senior
      ? "Academy players are released from the academy instead."
      : onLoan
        ? "This player is on loan from another club."
        : onLoanOut
          ? "This player is loaned out — recall him first."
          : onSale
            ? "This player is already listed for sale."
            : releaseCash > cash
              ? "The club cannot afford the release clause after binding bid reservations"
              : undefined,
  };
  const dismiss = { disabled: !p.isYouth || onLoan, reason: onLoan ? "This player is on loan from another club." : undefined };

  return { senior, onLoan, onLoanOut, onSale, listed, renew, promote, loan, recall, release, dismiss };
}
