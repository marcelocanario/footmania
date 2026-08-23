import { describe, expect, it } from "vitest";
import { calculateEloChange, applyMatchElo } from "../src/game/elo";
import { emptyStandingsRow, standingsTiebreak } from "../src/game/league";
import type { Match } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

describe("human club Elo", () => {
  it("accounts for home advantage and is zero-sum", () => {
    const change = calculateEloChange(1500, 1500, 1, 0);
    expect(change.expectedHome).toBeGreaterThan(0.5);
    expect(change.deltaHome + change.deltaAway).toBeCloseTo(0, 12);
  });

  it("rewards an underdog draw and does not process a match twice", () => {
    const home = makeClub({ id: 1, eloRating: 1400 });
    const away = makeClub({ id: 2, ownerUserId: 2, eloRating: 1600 });
    const world = makeWorld([home, away], []);
    const match = {
      id: 10,
      fixtureId: 10,
      competitionId: 1,
      homeClubId: home.id,
      awayClubId: away.id,
      homeScore: 0,
      awayScore: 0,
      penaltyWinnerId: null,
      attendance: 0,
      gateRevenue: 0,
      events: [],
      stats: { home: {}, away: {} },
      minuteEvents: [],
      homeWasHuman: true,
      awayWasHuman: true,
      eloProcessed: false,
    } as unknown as Match;

    expect(applyMatchElo(world, match)).toBe(true);
    expect(home.eloRating).toBeGreaterThan(1400);
    expect(away.eloRating).toBeLessThan(1600);
    expect(world.clubEloEvents).toHaveLength(2);
    const homeAfter = home.eloRating;
    expect(applyMatchElo(world, match)).toBe(false);
    expect(home.eloRating).toBe(homeAfter);
    expect(world.clubEloEvents).toHaveLength(2);
  });

  it("does not rate a match involving an AI club", () => {
    const home = makeClub({ id: 1, eloRating: 1500 });
    const away = makeClub({ id: 2, ownerUserId: null, isHuman: false, eloRating: 1500 });
    const world = makeWorld([home, away], []);
    const match = { homeClubId: home.id, awayClubId: away.id, homeScore: 4, awayScore: 0, homeWasHuman: true, awayWasHuman: false, eloProcessed: false } as unknown as Match;

    expect(applyMatchElo(world, match)).toBe(false);
    expect(home.eloRating).toBe(1500);
    expect(away.eloRating).toBe(1500);
    expect(world.clubEloEvents ?? []).toHaveLength(0);
  });

  it("does not use insertion order for a complete standings tie", () => {
    const rows = standingsTiebreak([emptyStandingsRow(20), emptyStandingsRow(10)]);
    expect(rows.map((row) => row.clubId)).toEqual([10, 20]);
  });

  it("uses Elo before clubId for a complete sporting tie", () => {
    const rows = standingsTiebreak([emptyStandingsRow(20), emptyStandingsRow(10)], new Map([[10, 1400], [20, 1600]]));
    expect(rows.map((row) => row.clubId)).toEqual([20, 10]);
  });
});
