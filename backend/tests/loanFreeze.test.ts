import { describe, expect, it } from "vitest";
import {
  claimLoan,
  loanMarketFrozen,
  offerPlayerForLoan,
  reconcileLoansAtRollover,
  revokeUnclaimedLoans,
} from "../src/game/loans";
import { gameConfig } from "../src/config";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club, Player, World } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

function loanWorld(dayIndex: number): { world: World; owner: Club; player: Player; borrower: Club } {
  const owner = makeClub({ id: 1, isHuman: true });
  const borrower = makeClub({ id: 2, isHuman: true });
  const player = generatePlayer(createRng(9), owner, { id: 1, isYouth: false });
  player.contractDays = gameConfig.seasonDays * 3;
  player.value = 5_000_000;
  const world = makeWorld([owner, borrower], [player], { dayIndex });
  return { world, owner, player, borrower };
}

describe("loan market season bounds (review C7)", () => {
  it("stays open during the active phase", () => {
    const { world } = loanWorld(5);
    expect(loanMarketFrozen(world)).toBe(false);
    expect(offerPlayerForLoan(world, world.clubs[0], world.players[0], { now: Date.now() }).ok).toBe(true);
  });

  it("freezes after the last league game day: no new listings and no claims", () => {
    // The first post-match day: the last league round has been played.
    const frozenDay = gameConfig.lastLeagueMatchDayIndex + 1;
    const { world, owner, borrower } = loanWorld(frozenDay);
    expect(loanMarketFrozen(world)).toBe(true);

    const listedBefore = offerPlayerForLoan(world, owner, world.players[0], { now: Date.now() });
    expect(listedBefore.ok).toBe(false);
    if (!listedBefore.ok) expect(listedBefore.error).toContain("closed until next season");

    // A listing posted on the final matchday can no longer be claimed either.
    const activeWorld = loanWorld(gameConfig.lastLeagueMatchDayIndex);
    const offered = offerPlayerForLoan(activeWorld.world, owner, activeWorld.player, { now: Date.now() });
    if (!offered.ok) throw new Error(offered.error);
    activeWorld.world.mp.seasonDayIndex = frozenDay;
    const claimed = claimLoan(activeWorld.world, borrower, offered.loan, { now: Date.now() });
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.error).toContain("closed until next season");
  });

  it("revokes every unclaimed listing when results are finalized at rollover start", () => {
    const { world, owner, player } = loanWorld(gameConfig.lastLeagueMatchDayIndex - 3);
    const offered = offerPlayerForLoan(world, owner, player, { now: Date.now() });
    if (!offered.ok) throw new Error(offered.error);

    // SEASON_RESULTS_FINALIZE calls revokeUnclaimedLoans (the same production
    // transition the rollover service runs).
    expect(revokeUnclaimedLoans(world)).toBe(1);
    expect(offered.loan.recalled).toBe(true);
    expect(player.loanId).toBeNull();

    // Re-running the revoke pass is harmless.
    expect(revokeUnclaimedLoans(world)).toBe(0);
    expect(world.loans.every((l) => l.recalled)).toBe(true);
  });

  it("still returns claimed loans to their owners at the rollover reconcile", () => {
    const { world, owner, borrower, player } = loanWorld(10);
    const offered = offerPlayerForLoan(world, owner, player, { now: Date.now() });
    if (!offered.ok) throw new Error(offered.error);
    offered.loan.claimableAt = Date.now() - 1;
    const claimed = claimLoan(world, borrower, offered.loan, { now: Date.now() });
    expect(claimed.ok).toBe(true);
    expect(player.clubId).toBe(borrower.id);

    expect(reconcileLoansAtRollover(world)).toBe(1);
    expect(player.clubId).toBe(owner.id);
    expect(player.loanId).toBeNull();
  });
});
