import { describe, expect, it } from "vitest";
import { calculateTierBudget } from "../src/game/budget";
import { calculateDivisionPrize } from "../src/game/season";
import { applyMatchToPlayers } from "../src/game/match";
import { EVENT_CODES } from "../src/game/constants";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Match } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

describe("division prize finance", () => {
  it("uses the higher-minus-current budget and finishing position share", () => {
    expect(calculateDivisionPrize(100_000, 80_000, 3, 8)).toBe(15_000);
    expect(calculateDivisionPrize(100_000, 80_000, 1, 8)).toBe(20_000);
    expect(calculateDivisionPrize(100_000, 80_000, 8, 8)).toBe(2_500);
  });

  it("does not award a prize outside the division", () => {
    expect(calculateDivisionPrize(100_000, 80_000, 0, 8)).toBe(0);
    expect(calculateDivisionPrize(100_000, 80_000, 9, 8)).toBe(0);
    expect(calculateDivisionPrize(80_000, 100_000, 1, 8)).toBe(0);
  });

  it("extrapolates the configured budget curve for hypothetical division 0", () => {
    expect(calculateTierBudget(100_000, 0.8, 0.5, 1)).toBe(100_000);
    expect(calculateTierBudget(100_000, 0.8, 0.5, 0)).toBeGreaterThan(100_000);
  });
});

describe("red-card finance", () => {
  it("keeps disciplinary effects without paying a tribunal fine", () => {
    const club = makeClub({ id: 1, cash: 100_000 });
    const player = generatePlayer(createRng(7), club, { id: 1 });
    player.salary = 100_000;
    const world = makeWorld([club], [player]);
    const match = {
      events: [{ minute: 20, half: 1, type: EVENT_CODES.RED, subtype: 0, clubId: club.id, playerId: player.id, player2Id: null, goalType: 0 }],
    } as Match;

    applyMatchToPlayers(match, world);

    expect(player.reds).toBe(1);
    expect(player.suspendedGames).toBeGreaterThan(0);
    expect(club.cash).toBe(100_000);
    expect(club.ledger.income).toHaveLength(0);
    expect(world.news[0]?.text).not.toContain("fine");
  });
});
