import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { calcSalary, generatePlayer } from "../src/game/player";
import { dismissYouthPlayer, promoteYouthPlayer, promotedYouthSalary, rolloverSeason } from "../src/game/season";
import type { Club, Player, World } from "../src/game/types";

function makeClub(): Club {
  return {
    id: 1,
    name: "Academy FC",
    shortName: "AFC",
    country: "BRA",
    reputation: 4,
    level: 20,
    cash: 10_000_000,
    stadiumName: "Academy Ground",
    stadiumCapacity: 40_000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    boardConfidence: 50,
    fanConfidence: 70,
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

function makeWorld(club: Club, players: Player[]): World {
  return {
    seed: 1,
    year: 2026,
    dayIndex: 0,
    dayOfWeek: 0,
    nextId: 1000,
    clubs: [club],
    players,
    competitions: [],
    fixtures: [],
    matches: [],
    news: [],
    auctions: [],
    loans: [],
    seasonAwards: [],
    records: [],
    managerHistory: [],
    ticketPrices: {},
    stadiumUpgrades: [],
    tvDeals: [],
    humanClubId: club.id,
    seasonSummary: null,
    rng: createRng(42),
    contractWarnings: [],
    liveMatch: null,
  };
}

describe("youth academy", () => {
  it("promotes manually and pays 80% of the fair senior salary", () => {
    const club = makeClub();
    const rng = createRng(7);
    const youth = generatePlayer(rng, club, { isYouth: true, id: 1 });
    youth.age = 20;
    const world = makeWorld(club, [youth]);
    const fair = calcSalary(club, youth.overall, youth.age, youth.isStar, youth.worldClass, false);

    expect(promoteYouthPlayer(world, youth).ok).toBe(true);
    expect(youth.isYouth).toBe(false);
    expect(youth.salary).toBe(promotedYouthSalary(club, youth));
    expect(youth.salary).toBe(Math.max(500, Math.round(fair * 0.8)));
    expect(world.news.at(-1)?.kind).toBe("academy");
  });

  it("ages youth every season and automatically promotes them at 21", () => {
    const club = makeClub();
    const youth = generatePlayer(createRng(9), club, { isYouth: true, id: 1 });
    youth.age = 20;
    const world = makeWorld(club, [youth]);

    rolloverSeason(world.rng, world);

    expect(youth.age).toBe(21);
    expect(youth.isYouth).toBe(false);
    expect(world.news.some((n) => n.text.includes("automatically promoted"))).toBe(true);
    expect(world.news.some((n) => n.kind === "academy")).toBe(true);
  });

  it("can release a youth player from the academy", () => {
    const club = makeClub();
    const youth = generatePlayer(createRng(11), club, { isYouth: true, id: 1 });
    const world = makeWorld(club, [youth]);

    expect(dismissYouthPlayer(world, youth).ok).toBe(true);
    expect(world.players).toHaveLength(0);
    expect(world.news.at(-1)?.text).toContain("released from the youth academy");
  });
});
