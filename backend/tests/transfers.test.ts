import { describe, it, expect } from "vitest";
import { releasePlayer } from "../src/game/transfers";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { Club } from "../src/game/types";
import { gameConfig } from "../src/config";
import { makeWorld } from "./helpers";

function makeClub(id: number, overrides: Partial<Club> = {}): Club {
  return {
    id,
    name: `Club ${id}`,
    shortName: `C${id}`,
    ownerUserId: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 10_000_000,
    stadiumName: "St",
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}

describe("releasePlayer", () => {
  it("pays the release clause and moves a senior player to free agency", () => {
    const club = makeClub(1, { cash: 5_000_000, isHuman: true });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1 });
    player.releaseClause = 1_000_000;
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(1_000_000);
    expect(club.cash).toBe(4_000_000 - Math.round(player.salary * 5 / gameConfig.seasonDays));
    expect(club.ledger.expense.filter((e) => e.code === 2 && e.label.includes(player.name))).toHaveLength(1);
    expect(player.clubId).toBeNull();
    expect(player.onSale).toBe(false);
    const releaseNews = world.news.find((n) => n.body?.k === "news.releasePaid");
    const params = (releaseNews?.body as { p?: { player?: string; cost?: number } } | undefined)?.p;
    expect(params?.player).toBe(player.name);
    // Money params are raw integers — the client formats them (never a "$X" string).
    expect(params?.cost).toBe(1_000_000);
  });

  it("rejects a release the club cannot afford", () => {
    const club = makeClub(1, { cash: 100_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1 });
    player.releaseClause = 1_000_000;
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(false);
    expect(player.clubId).toBe(club.id);
    expect(club.cash).toBe(100_000);
  });

  it("releases youth players for free", () => {
    const club = makeClub(1, { cash: 0 });
    const rng = createRng(9);
    const player = generatePlayer(rng, club, { id: 1, isYouth: true });
    const world = makeWorld([club], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(0);
    expect(player.clubId).toBeNull();
  });

  it("rejects a player who does not belong to the club", () => {
    const club = makeClub(1);
    const other = makeClub(2);
    const rng = createRng(9);
    const player = generatePlayer(rng, other, { id: 1 });
    const world = makeWorld([club, other], [player], { dayIndex: 5 });

    const result = releasePlayer(world, player, club);
    expect(result.ok).toBe(false);
    expect(player.clubId).toBe(other.id);
  });

  it("does not release a player who is on loan to the club", () => {
    const owner = makeClub(1);
    const receiving = makeClub(2, { cash: 100_000 });
    const rng = createRng(9);
    const player = generatePlayer(rng, owner, { id: 1 });
    player.clubId = receiving.id;
    player.loanId = 10;
    player.releaseClause = 1_000_000;
    const world = makeWorld([owner, receiving], [player], { dayIndex: 5 });
    world.loans.push({ id: 10, playerId: player.id, fromClubId: owner.id, toClubId: receiving.id, startDay: 1, endDay: 20, recalled: false, listedAt: 1, claimableAt: 1 });

    const result = releasePlayer(world, player, receiving);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("A player with an active market listing cannot be released");
    expect(player.clubId).toBe(receiving.id);
    expect(player.loanId).toBe(10);
    expect(world.loans[0].recalled).toBe(false);
    expect(world.news).toHaveLength(0);
  });
});
