import { describe, expect, it } from "vitest";
import { loanFitsContract } from "../src/game/season";
import {
  cancelLoanListing,
  claimLoan,
  claimableInSeconds,
  offerPlayerForLoan,
  reconcileLoansAtRollover,
  returnLoanedPlayer,
} from "../src/game/loans";
import { MARKET_CONFIG } from "../src/config";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

describe("loan contract duration", () => {
  it("allows a loan that ends on or before the owning contract expiry", () => {
    expect(loanFitsContract(20, 30, 10)).toBe(true);
    expect(loanFitsContract(20, 30, 11)).toBe(true);
  });

  it("rejects a loan that outlasts the owning contract", () => {
    expect(loanFitsContract(20, 30, 9)).toBe(false);
    expect(loanFitsContract(20, 20, 10)).toBe(false);
  });
});

function makeClubFn(id: number, overrides: Partial<Club> = {}): Club {
  return makeClub({ id, isHuman: true, cash: 100_000_000, ...overrides });
}

function loanWorld(): { world: World; owner: Club; player: Player } {
  const rng = createRng(1);
  const owner = makeClubFn(1);
  const player = generatePlayer(rng, owner, { id: 1, isYouth: false });
  const world = makeWorld([owner], [player], { dayIndex: 5 });
  return { world, owner, player };
}

describe("public loan exposure (§57)", () => {
  it("lists a player with a claimableAt = listedAt + exposure, not immediately claimable", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const result = offerPlayerForLoan(world, owner, player, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = now + MARKET_CONFIG.loans.exposureMinutes * 60_000;
    expect(result.loan.claimableAt).toBe(expected);
    expect(claimableInSeconds(result.loan, now)).toBeGreaterThan(0);
    expect(claimableInSeconds(result.loan, expected)).toBe(0);
    expect(player.loanId).toBe(result.loan.id);
  });

  it("rejects offering a youth player or a player already listed", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    expect(offerPlayerForLoan(world, owner, player, { now }).ok).toBe(true);
    expect(offerPlayerForLoan(world, owner, player, { now }).ok).toBe(false); // already listed
  });
});

describe("atomic FCFS claim (§58/§59)", () => {
  it("rejects a claim before the exposure period elapses", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = makeClubFn(2);
    world.clubs.push(borrower);
    const result = claimLoan(world, borrower, offered.loan, { now: now + 1_000 });
    expect(result.ok).toBe(false);
    expect(offered.loan.toClubId).toBeNull();
  });

  it("claims first-come, first-served after exposure", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = makeClubFn(2);
    world.clubs.push(borrower);
    const after = offered.loan.claimableAt + 1;
    const result = claimLoan(world, borrower, offered.loan, { now: after });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(offered.loan.toClubId).toBe(borrower.id);
    expect(player.clubId).toBe(borrower.id);
    // Second claimant is rejected (already claimed).
    const borrower2 = makeClubFn(3);
    world.clubs.push(borrower2);
    expect(claimLoan(world, borrower2, offered.loan, { now: after + 1 }).ok).toBe(false);
  });

  it("rejects the owner claiming their own listing", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const result = claimLoan(world, owner, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(result.ok).toBe(false);
  });
});

describe("pre-claim-only cancellation (§57/§101.38)", () => {
  it("allows the lender to cancel an unclaimed listing", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const result = cancelLoanListing(world, owner, offered.loan);
    expect(result.ok).toBe(true);
    expect(offered.loan.recalled).toBe(true);
    expect(player.loanId).toBeNull();
  });

  it("rejects recalling a claimed loan", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = makeClubFn(2);
    world.clubs.push(borrower);
    const claimed = claimLoan(world, borrower, offered.loan, { now: offered.loan.claimableAt + 1 });
    expect(claimed.ok).toBe(true);
    const cancel = cancelLoanListing(world, owner, offered.loan);
    expect(cancel.ok).toBe(false);
    expect(offered.loan.recalled).toBe(false);
  });
});

describe("season-end return (§56)", () => {
  it("returns the player to the owner at season end", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    const borrower = makeClubFn(2);
    world.clubs.push(borrower);
    claimLoan(world, borrower, offered.loan, { now: offered.loan.claimableAt + 1 });

    returnLoanedPlayer(world, offered.loan);
    expect(player.clubId).toBe(owner.id);
    expect(player.loanId).toBeNull();
    expect(offered.loan.recalled).toBe(true);
  });

  it("reconciles unclaimed listings and active loans at rollover (§17)", () => {
    const { world, owner, player } = loanWorld();
    const now = 1_700_000_000_000;
    const offered = offerPlayerForLoan(world, owner, player, { now });
    if (!offered.ok) throw new Error(offered.error);
    // Second loan world for the claimed case.
    const { world: w2, owner: o2, player: p2 } = loanWorld();
    const offered2 = offerPlayerForLoan(w2, o2, p2, { now });
    if (!offered2.ok) throw new Error(offered2.error);
    const borrower = makeClubFn(2);
    w2.clubs.push(borrower);
    claimLoan(w2, borrower, offered2.loan, { now: offered2.loan.claimableAt + 1 });

    const n1 = reconcileLoansAtRollover(world);
    expect(n1).toBe(1);
    expect(offered.loan.recalled).toBe(true);
    const n2 = reconcileLoansAtRollover(w2);
    expect(n2).toBe(1);
    expect(p2.clubId).toBe(o2.id);
  });
});
