import { describe, expect, it } from "vitest";
import { createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { advanceLiveMatches, startLiveMatch } from "../src/game/world";
import { createRng } from "../src/game/rng";
import type { Player } from "../src/game/types";
import { makeWorld, makeClub } from "./helpers";
import { clonePlayers, goldenClub, goldenSquad, goldenTactics } from "./matchGolden";

function squads(): Player[] {
  return clonePlayers([...goldenSquad(1, 1, 31111, 1000), ...goldenSquad(2, 4, 32222, 2000)]);
}

describe("admin resolve-now (forceFinish)", () => {
  it("finishes a live match immediately regardless of wall-clock elapsed time", () => {
    const players = squads();
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const world = makeWorld([home, away], players);
    const fixture = {
      id: 42,
      competitionId: 1,
      round: 0,
      homeClubId: home.id,
      awayClubId: away.id,
      dayIndex: 0,
      played: false,
    };
    world.fixtures.push(fixture);
    startLiveMatch(world, fixture, Date.now());

    // No wall-clock time has passed since kickoff, so a normal advance would
    // leave the match frozen at 0'. forceFinish must simulate to full time.
    const finished = advanceLiveMatches(world, Date.now() + 1000, { forceFinish: true });

    expect(finished).toHaveLength(1);
    expect(finished[0].fixtureId).toBe(fixture.id);
    expect(finished[0].events.some((event) => event.type === 12)).toBe(true); // FULL_TIME whistle
    expect(world.liveMatches).toHaveLength(0);
    expect(world.fixtures.find((candidate) => candidate.id === fixture.id)?.played).toBe(true);
  });

  it("does not finalize a non-resolved live match on a normal advance", () => {
    const players = squads();
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const world = makeWorld([home, away], players);
    const st = createLiveMatchState(createRng(777005), home, away, players, {
      matchId: 700005,
      competitionId: 1,
      fixtureId: 700005,
      homeNeutral: true,
    });
    world.liveMatches.push(st);

    const finished = advanceLiveMatches(world, Date.now() + 1000);

    expect(finished).toHaveLength(0);
    expect(st.ended).toBe(false);
    expect(world.liveMatches).toHaveLength(1);
  });

  it("finalizes immediately even when the live state is mid-first-half", () => {
    const players = squads();
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const world = makeWorld([home, away], players);
    const rng = createRng(777006);
    const st = createLiveMatchState(rng, home, away, players, {
      matchId: 700006,
      competitionId: 1,
      fixtureId: 700006,
      homeNeutral: true,
    });
    world.liveMatches.push(st);
    tickLiveMatch(rng, home, away, players, st, 20, { resume: true });
    expect(st.ended).toBe(false);
    expect(st.matchClockSeconds).toBeGreaterThan(0);

    const finished = advanceLiveMatches(world, Date.now() + 1000, { forceFinish: true });

    expect(finished).toHaveLength(1);
    expect(world.liveMatches).toHaveLength(0);
  });

  it("leaves the previous live state gone and the fixture played", () => {
    const players = squads();
    const home = goldenClub(1, goldenTactics(0));
    const away = goldenClub(2, goldenTactics(2));
    const world = makeWorld([home, away], players);
    const fixture = {
      id: 43,
      competitionId: 1,
      round: 0,
      homeClubId: home.id,
      awayClubId: away.id,
      dayIndex: 0,
      played: false,
    };
    world.fixtures.push(fixture);
    startLiveMatch(world, fixture, Date.now());

    advanceLiveMatches(world, Date.now() + 1, { forceFinish: true });

    expect(world.liveMatches).toHaveLength(0);
    expect(world.fixtures.find((candidate) => candidate.id === fixture.id)?.played).toBe(true);
  });
});
