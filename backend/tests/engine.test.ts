import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { simulateMatch, createLiveMatchState, tickLiveMatch, performLiveSub, buildMatchFromState } from "../src/game/match";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { calcValue, calcSalary } from "../src/game/player";
import type { Club } from "../src/game/types";

function makeClub(overall: number): Club {
  return {
    id: 1,
    name: "Test",
    shortName: "TST",
    stateCode: "SP",
    division: 1,
    reputation: 4,
    level: 20,
    cash: 10000000,
    loanBalance: 0,
    stadiumName: "St",
    stadiumCapacity: 40000,
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    boardConfidence: 50,
    fanConfidence: 70,
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

function makeSquad(rng: ReturnType<typeof createRng>, club: Club, count: number) {
  const players = [];
  for (let i = 0; i < count; i++) {
    const p = generatePlayer(rng, club, { id: i + 1 });
    players.push(p);
  }
  return players;
}

describe("match engine", () => {
  it("produces a plausible goal distribution", () => {
    const rng = createRng(7);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30)];
    let total = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: i });
      total += match.homeScore + match.awayScore;
    }
    const avg = total / n;
    expect(avg).toBeGreaterThan(1.5);
    expect(avg).toBeLessThan(4.5);
  });

  it("home advantage produces more home wins", () => {
    const rng = createRng(11);
    const home = makeClub(70);
    const away = makeClub(70);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30)];
    let homeWins = 0;
    let awayWins = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: i });
      if (match.homeScore > match.awayScore) homeWins++;
      if (match.awayScore > match.homeScore) awayWins++;
    }
    expect(homeWins).toBeGreaterThan(awayWins);
  });
});

describe("live match engine", () => {
  it("streaming a match incrementally produces the same result as instant simulation", () => {
    const rng1 = createRng(99);
    const rng2 = createRng(99);
    const home = makeClub(75);
    const away = makeClub(75);
    const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30)];
    const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30)];
    const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1 });
    const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
    let guard = 0;
    while (!st.ended && guard++ < 500) {
      tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true });
    }
    expect(st.ended).toBe(true);
    const match = buildMatchFromState(st, home, away, players2);
    expect(match.homeScore).toBe(instant.match.homeScore);
    expect(match.awayScore).toBe(instant.match.awayScore);
    expect(st.events.length).toBe(instant.match.events.length);
  });

  it("performs a substitution and enforces the goalkeeper rule", () => {
    const rng = createRng(5);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    const find = (id: number) => players.find((p) => p.id === id)!;
    const outId = st.homeOn.find((id) => find(id).tacPos !== 1)!;
    const inId = st.homeSubs[0];
    const res = performLiveSub(rng, home, away, players, st, 0, outId, inId);
    expect(res.error).toBeUndefined();
    expect(res.event?.type).toBe(6);
    expect(st.homeOn).toContain(inId);
    expect(st.homeOn).not.toContain(outId);
    expect(st.homeSubs).not.toContain(inId);
    expect(st.usedSubs[0]).toBe(1);
    const gkId = st.homeOn.find((id) => find(id).position === 0)!;
    const nonGk = st.homeSubs.find((id) => find(id).position !== 0)!;
    const res2 = performLiveSub(rng, home, away, players, st, 0, gkId, nonGk);
    expect(res2.error).toBeDefined();
    const bad = performLiveSub(rng, home, away, players, st, 0, 99999, inId);
    expect(bad.error).toBeDefined();
  });

  it("decider fixtures go to extra time and a shootout on a draw; regular matches end at 90", () => {
    for (let seed = 0; seed < 40; seed++) {
      const rng = createRng(seed);
      const home = makeClub(72);
      const away = makeClub(72);
      const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30)];
      const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1, decider: seed % 2 === 0 });
      let guard = 0;
      while (!st.ended && guard++ < 500) tickLiveMatch(rng, home, away, players, st, 5, { ignoreHalfTime: true });
      expect(st.ended).toBe(true);
      if (st.decider) {
        if (st.scores[0] === st.scores[1]) {
          expect(st.shootout).toBeDefined();
          expect(st.shootout!.scores[0] === st.shootout!.scores[1]).toBe(false);
          expect(st.extraTimePlayed).toBe(true);
        } else {
          expect(st.shootout).toBeUndefined();
        }
      } else {
        expect(st.extraTimePlayed).toBe(false);
        expect(st.shootout).toBeUndefined();
      }
    }
  });
});

describe("player economy", () => {
  it("value and salary are bounded and ordered by overall", () => {
    const rng = createRng(3);
    const club = makeClub(70);
    const low = generatePlayer(rng, club, { id: 1 });
    const high = generatePlayer(rng, club, { id: 2 });
    low.overall = 50;
    high.overall = 90;
    low.age = 24;
    high.age = 24;
    const lowVal = calcValue(club, low.overall, low.age, low.tier, false, false, false);
    const highVal = calcValue(club, high.overall, high.age, high.tier, false, false, false);
    expect(highVal).toBeGreaterThan(lowVal);
    expect(lowVal).toBeGreaterThan(500);
    const lowSal = calcSalary(club, low.overall, low.age, false, false, false);
    const highSal = calcSalary(club, high.overall, high.age, false, false, false);
    expect(highSal).toBeGreaterThan(lowSal);
    expect(lowSal).toBeGreaterThanOrEqual(500);
  });

  it("world generation produces sensible overalls", () => {
    const world = generateWorld(77);
    const overalls = world.players.map((p) => p.overall);
    const avg = overalls.reduce((s, x) => s + x, 0) / overalls.length;
    expect(avg).toBeGreaterThan(15);
    expect(avg).toBeLessThan(90);
    const max = Math.max(...overalls);
    expect(max).toBeLessThanOrEqual(100);
    const min = Math.min(...overalls);
    expect(min).toBeGreaterThanOrEqual(1);
    const d1Seniors = world.players.filter((p) => {
      const club = world.clubs.find((c) => c.id === p.clubId);
      return club && club.division === 1 && !p.isYouth;
    });
    const d1Avg = d1Seniors.reduce((s, p) => s + p.overall, 0) / d1Seniors.length;
    expect(d1Avg).toBeGreaterThan(30);
    expect(d1Avg).toBeLessThan(80);
    const gks = world.players.filter((p) => p.position === 0);
    expect(gks.length).toBeGreaterThan(0);
  });
});
