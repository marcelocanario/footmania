import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { advance, finalizeLiveMatch } from "../src/game/world";
import { buildLineup } from "../src/game/club";
import { tickLiveMatch } from "../src/game/match";

describe("worldgen", () => {
  it("generates a complete world", () => {
    const world = generateWorld(12345);
    expect(world.clubs.length).toBe(52);
    expect(world.players.length).toBeGreaterThan(1000);
    expect(world.competitions.length).toBe(4);
    const d1 = world.competitions.find((c) => c.kind === "league" && c.division === 1)!;
    const d2 = world.competitions.find((c) => c.kind === "league" && c.division === 2)!;
    expect(Object.keys(d1.standings).length).toBe(20);
    expect(Object.keys(d2.standings).length).toBe(20);
    expect(world.fixtures.filter((f) => f.competitionId === d1.id).length).toBe(380);
    const state = world.competitions.find((c) => c.kind === "state")!;
    expect(state.config.groups.length).toBe(4);
  });

  it("every club can build a legal 11", () => {
    const world = generateWorld(999);
    for (const club of world.clubs) {
      const lineup = buildLineup(club, world.players);
      if (club.division <= 2) {
        expect(lineup?.starters.length, `${club.name} starters`).toBe(11);
      }
    }
  });

  it("advances the season through matches", () => {
    const world = generateWorld(4242);
    world.humanClubId = world.clubs[0].id;
    let days = 0;
    while (days < 40) {
      const res = advance(world);
      days++;
      if (res.playedMatches.length > 0 || res.matchPending) break;
    }
    expect(world.dayIndex).toBeGreaterThan(0);
    let guard = 0;
    while (world.liveMatch && guard++ < 5) {
      const st = world.liveMatch;
      const home = world.clubs.find((c) => c.id === st.homeClubId)!;
      const away = world.clubs.find((c) => c.id === st.awayClubId)!;
      tickLiveMatch(world.rng, home, away, world.players, st, 200, { ignoreHalfTime: true });
      finalizeLiveMatch(world);
    }
    const played = world.matches.length;
    expect(played).toBeGreaterThan(0);
    const playedFixtureCount = world.fixtures.filter((f) => f.played).length;
    expect(playedFixtureCount).toBe(played);
  });
});
