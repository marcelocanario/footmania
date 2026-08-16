import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { simulateMatch, createLiveMatchState, tickLiveMatch, performLiveSub, buildMatchFromState, matchRating, midfieldStrength, defenseStrength, attackStrength } from "../src/game/match";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { calcValue, calcSalary } from "../src/game/player";
import type { Club, Player } from "../src/game/types";
import type { RatingContext } from "../src/game/match";
import type { RngState } from "../src/game/rng";

function makeClub(overall: number, overrides: Partial<Club> = {}): Club {
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
    ...overrides,
  };
}

function makeSquad(rng: RngState, club: Club, count: number, offset = 0) {
  const players = [];
  for (let i = 0; i < count; i++) {
    const p = generatePlayer(rng, club, { id: offset + i + 1 });
    players.push(p);
  }
  return players;
}

function leagueCtx(home: Club, away: Club): RatingContext {
  return { kind: "league", homeRep: home.reputation, awayRep: away.reputation, awayClubId: away.id };
}

describe("match engine", () => {
  it("produces a plausible goal distribution (2.3-2.8 goals per match)", () => {
    const seeds = [7, 11, 42, 99];
    let total = 0;
    const n = seeds.length * 400;
    for (const seed of seeds) {
      const rng = createRng(seed);
      const home = makeClub(75);
      const away = makeClub(75);
      for (let i = 0; i < 400; i++) {
        const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
        const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
        total += match.homeScore + match.awayScore;
      }
    }
    const avg = total / n;
    expect(avg).toBeGreaterThan(2.3);
    expect(avg).toBeLessThan(2.8);
  });

  it("home advantage produces more home wins", () => {
    const seeds = [7, 11, 42, 99];
    let homeWins = 0;
    let awayWins = 0;
    let draws = 0;
    for (const seed of seeds) {
      const rng = createRng(seed);
      const home = makeClub(70);
      const away = makeClub(70);
      for (let i = 0; i < 600; i++) {
        const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
        const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
        if (match.homeScore > match.awayScore) homeWins++;
        if (match.awayScore > match.homeScore) awayWins++;
        if (match.homeScore === match.awayScore) draws++;
      }
    }
    expect(homeWins).toBeGreaterThan(awayWins);
    expect(draws).toBeLessThan(homeWins + awayWins);
  });

  it("possession always sums to 100 and is tracked per minute", () => {
    const rng = createRng(21);
    const home = makeClub(72);
    const away = makeClub(72);
    for (let i = 0; i < 60; i++) {
      const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
      const { match } = simulateMatch(rng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
      expect(match.stats.possession[0] + match.stats.possession[1]).toBe(100);
      expect(match.stats.possession[0]).toBeGreaterThanOrEqual(0);
      expect(match.stats.possession[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it("pressing raises midfield strength and increases card frequency", () => {
    const rng = createRng(5);
    const lightClub = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
    const pressClub = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
    const squad = makeSquad(rng, lightClub, 30);
    const ctx = leagueCtx(lightClub, pressClub);
    for (const p of squad) {
      if (p.tacPos < 0) p.tacPos = 14;
    }
    const light = midfieldStrength(squad, lightClub, ctx);
    const press = midfieldStrength(squad, pressClub, ctx);
    expect(press).toBeGreaterThan(light);

    let lightYellows = 0;
    let pressYellows = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const rng2 = createRng(1000 + i);
      const h1 = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
      const a1 = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
      const players = [...makeSquad(rng2, h1, 30), ...makeSquad(rng2, a1, 30, 30)];
      const { match } = simulateMatch(rng2, h1, a1, players, { competitionId: 1, fixtureId: i, year: 1 });
      lightYellows += match.stats.yellows[0] + match.stats.yellows[1];

      const rng3 = createRng(2000 + i);
      const h2 = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
      const a2 = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
      const players2 = [...makeSquad(rng3, h2, 30), ...makeSquad(rng3, a2, 30, 30)];
      const { match: m2 } = simulateMatch(rng3, h2, a2, players2, { competitionId: 1, fixtureId: i, year: 1 });
      pressYellows += m2.stats.yellows[0] + m2.stats.yellows[1];
    }
    expect(pressYellows).toBeGreaterThan(lightYellows);
  });

  it("a stronger goalkeeper lowers on-target conversion", () => {
    const rng = createRng(77);
    const home = makeClub(70);
    const away = makeClub(70);
    let weakGkGoals = 0;
    let weakGkShots = 0;
    let strongGkGoals = 0;
    let strongGkShots = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
      const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1, homeNeutral: true });
      const homeGk = st.homeOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === 0)!;
      const awayGk = st.awayOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === 0)!;
      homeGk.skills.gol = 40;
      awayGk.skills.gol = 95;
      tickLiveMatch(rng, home, away, players, st, 500, { ignoreHalfTime: true });
      weakGkShots += st.stats.shots[0];
      weakGkGoals += st.scores[0];
      strongGkShots += st.stats.shots[1];
      strongGkGoals += st.scores[1];
    }
    const weakConv = weakGkGoals / Math.max(1, weakGkShots);
    const strongConv = strongGkGoals / Math.max(1, strongGkShots);
    expect(weakConv).toBeGreaterThan(strongConv);
  });

  it("sending a defender off lowers the conceding team's sector strength", () => {
    const rng = createRng(9);
    const club = makeClub(75);
    const squad = makeSquad(rng, club, 30);
    const ctx = leagueCtx(club, club);
    const xi = squad.slice(0, 11);
    const formation = [1, 22, 24, 11, 13, 14, 16, 2, 9, 3, 5];
    for (let i = 0; i < 11; i++) xi[i].tacPos = formation[i];
    const before = defenseStrength(xi, ctx);
    const cb = xi.find((p) => p.tacPos === 3)!;
    xi.splice(xi.indexOf(cb), 1);
    const after = defenseStrength(xi, ctx);
    expect(after).toBeLessThan(before);
  });

  it("match ratings follow the position-specific Brasfoot weights", () => {
    const rng = createRng(3);
    const club = makeClub(75);
    const p = generatePlayer(rng, club, { id: 1, position: 4 });
    p.tacPos = 18;
    p.skills = { gol: 1, vel: 80, tec: 80, pas: 40, des: 20, arm: 30, fin: 80 };
    const ctx = leagueCtx(club, club);
    const r = matchRating(p, ctx);
    const expected = (Math.round(80 * 0.25) + Math.round(80 * 0.15) + Math.round(40 * 0.15) + Math.round(30 * 0.05) + Math.round(80 * 0.4)) / 10;
    expect(r).toBeCloseTo(expected, 5);
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
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
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
      const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
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
