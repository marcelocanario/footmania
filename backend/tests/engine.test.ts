import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import { simulateMatch, createLiveMatchState, tickLiveMatch, performLiveSub, buildMatchFromState, matchRating, midfieldStrength, defenseStrength, attackStrength } from "../src/game/match";
import { divisionTicketTier } from "../src/game/club";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { calculatePlayerValue, calculateBaseSalary } from "../src/game/economy";
import type { Club, Player, Position } from "../src/game/types";
import type { RatingContext } from "../src/game/match";
import type { RngState } from "../src/game/rng";

let clubIdCounter = 1;
function makeClub(overall: number, overrides: Partial<Club> = {}): Club {
  return {
    id: clubIdCounter++,
    name: "Test",
    shortName: "TST",
    ownerUserId: null,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    // Top-division benchmark: equal strong teams. Overall is ignored — quality
    // derives from the division (player-generation §14).
    highestDivision: 1,
    cash: 10000000,
    stadiumName: "St",
    stadiumCapacity: 40000,
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

function makeSquad(rng: RngState, club: Club, count: number, offset = 0) {
  const players = [];
  // Balanced positions (3 GK, 6 FB, 6 CB, 9 MF, 6 FW per 30) so every squad
  // can always field a legal 11 for any formation.
  const balanced: Position[] = [
    0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4,
  ];
  for (let i = 0; i < count; i++) {
    const p = generatePlayer(rng, club, { id: offset + i + 1, position: balanced[i % balanced.length] });
    players.push(p);
  }
  return players;
}

// The canonical generator derives each player deterministically from stable IDs
// (player-generation §47), so rebuilding a squad from the shared stream yields
// the same objects every time. Simulation mutates them (energy, tacPos, ...),
// so every match must run on fresh copies of a fixed squad — mirroring a real
// league where squads persist between fixtures.
function clonePlayer(p: Player): Player {
  return {
    ...p,
    skills: { ...p.skills },
    skillAcc: [...p.skillAcc],
    recentMinutes: [...p.recentMinutes],
    developmentProfile: { ...p.developmentProfile },
    energy: 100,
    tacPos: -1,
    starter: false,
    injuryDays: 0,
    suspendedGames: 0,
  };
}

function cloneSquad(squad: Player[]): Player[] {
  return squad.map(clonePlayer);
}

function leagueCtx(home: Club, away: Club): RatingContext {
  const rep = (club: Club) => divisionTicketTier(club.highestDivision ?? 1);
  return { kind: "league", homeRep: rep(home), awayRep: rep(away), awayClubId: away.id };
}

describe("match engine", () => {
  // NOTE: the goal-rate calibration below reflects the division-driven player
  // generator (plans/4. player-generation.md) where equal-strength squads sit
  // around the weakest-division mean. The match simulator is slated for a full
  // revamp; these bands are regression targets, not a design requirement.
  it("produces a plausible goal distribution (2.6-3.4 goals per match)", () => {
    const seeds = [7, 11, 42, 99];
    let total = 0;
    const n = seeds.length * 400;
    for (const seed of seeds) {
      const rng = createRng(seed);
      const home = makeClub(75);
      const away = makeClub(76);
      const homeSquad = makeSquad(rng, home, 30);
      const awaySquad = makeSquad(rng, away, 30, 30);
      for (let i = 0; i < 400; i++) {
        const matchRng = createRng(seed * 10_000 + i);
        const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
        const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1, reps: { homeRep: 4, awayRep: 4 } });
        total += match.homeScore + match.awayScore;
      }
    }
    const avg = total / n;
    expect(avg).toBeGreaterThan(2.6);
    expect(avg).toBeLessThan(3.4);
  });

  it("home advantage produces more home wins", () => {
    const seeds = [5, 13, 21, 99];
    let homeWins = 0;
    let awayWins = 0;
    let draws = 0;
    for (const seed of seeds) {
      const rng = createRng(seed);
      const clubA = makeClub(70);
      const clubB = makeClub(71);
      const aSquad = makeSquad(rng, clubA, 30);
      // Keep the teams equal in player quality while retaining distinct club
      // IDs, so this test measures home advantage rather than roster noise.
      const bSquad = aSquad.map((player) => ({ ...clonePlayer(player), id: player.id + 1000, clubId: clubB.id }));
      // Each pair is played twice with home/away roles swapped so the
      // generator's deterministic club-id strength noise cannot masquerade as
      // home advantage (player-generation §47 derives quality from stable IDs).
      for (const [home, away, homeSquad, awaySquad] of [
        [clubA, clubB, aSquad, bSquad],
        [clubB, clubA, bSquad, aSquad],
      ] as const) {
        for (let i = 0; i < 300; i++) {
          // Use independent match draws for the two fixtures; reusing one
          // stream can make this stochastic regression hinge on one mirrored
          // sequence rather than the aggregate home-field effect.
          const matchRng = createRng(seed * 10_000 + i + (home === clubB ? 1000 : 0));
          const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
          const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1, reps: { homeRep: 4, awayRep: 4 } });
          if (match.homeScore > match.awayScore) homeWins++;
          if (match.awayScore > match.homeScore) awayWins++;
          if (match.homeScore === match.awayScore) draws++;
        }
      }
    }
    expect(homeWins).toBeGreaterThan(awayWins);
    expect(draws).toBeLessThan(homeWins + awayWins);
  });

  it("possession always sums to 100 and is tracked per minute", () => {
    const rng = createRng(21);
    const home = makeClub(72);
    const away = makeClub(73);
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    for (let i = 0; i < 60; i++) {
      const matchRng = createRng(21 * 10_000 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1, reps: { homeRep: 4, awayRep: 4 } });
      expect(match.stats.possession[0] + match.stats.possession[1]).toBe(100);
      expect(match.stats.possession[0]).toBeGreaterThanOrEqual(0);
      expect(match.stats.possession[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it("pressing raises midfield strength and increases card frequency", () => {
    const rng = createRng(5);
    const lightClub = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
    const pressClub = makeClub(71, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
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
      const matchRng = createRng(1000 + i);
      const h1 = makeClub(70, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
      const a1 = makeClub(71, { tactics: { formation: 4, style: 0, pressing: 0, direction: 0 } });
      const h1Squad = makeSquad(createRng(1000 + i), h1, 30);
      const a1Squad = makeSquad(createRng(1000 + i), a1, 30, 30);
      const players = [...cloneSquad(h1Squad), ...cloneSquad(a1Squad)];
      const { match } = simulateMatch(matchRng, h1, a1, players, { competitionId: 1, fixtureId: i, year: 1, reps: { homeRep: 4, awayRep: 4 } });
      lightYellows += match.stats.yellows[0] + match.stats.yellows[1];

      const matchRng2 = createRng(2000 + i);
      const h2 = makeClub(72, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
      const a2 = makeClub(73, { tactics: { formation: 4, style: 0, pressing: 2, direction: 0 } });
      const h2Squad = makeSquad(createRng(2000 + i), h2, 30);
      const a2Squad = makeSquad(createRng(2000 + i), a2, 30, 30);
      const players2 = [...cloneSquad(h2Squad), ...cloneSquad(a2Squad)];
      const { match: m2 } = simulateMatch(matchRng2, h2, a2, players2, { competitionId: 1, fixtureId: i, year: 1, reps: { homeRep: 4, awayRep: 4 } });
      pressYellows += m2.stats.yellows[0] + m2.stats.yellows[1];
    }
    expect(pressYellows).toBeGreaterThan(lightYellows);
  });

  it("a stronger goalkeeper lowers on-target conversion", () => {
    const rng = createRng(77);
    // Both sides share one club identity so the deterministic id-based RNG
    // produces equal-strength squads; only the GK skill differs.
    const home = makeClub(70);
    const away = { ...home, id: home.id + 1 } as Club;
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    let againstWeakGkGoals = 0;
    let againstWeakGkShots = 0;
    let againstStrongGkGoals = 0;
    let againstStrongGkShots = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const matchRng = createRng(77 * 10_000 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const st = createLiveMatchState(matchRng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1, homeNeutral: true });
      const homeGk = st.homeOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === 0)!;
      const awayGk = st.awayOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === 0)!;
      // Home keeps the weak GK; away the strong one. Each side's shots are
      // taken against the OPPOSING keeper.
      homeGk.skills.gol = 40;
      awayGk.skills.gol = 95;
      tickLiveMatch(matchRng, home, away, players, st, 500, { ignoreHalfTime: true, reps: { homeRep: 4, awayRep: 4 } });
      // Away shots (index 1) are taken against home's weak GK.
      againstWeakGkShots += st.stats.shots[1];
      againstWeakGkGoals += st.scores[1];
      // Home shots (index 0) are taken against away's strong GK.
      againstStrongGkShots += st.stats.shots[0];
      againstStrongGkGoals += st.scores[0];
    }
    const weakGkConv = againstWeakGkGoals / Math.max(1, againstWeakGkShots);
    const strongGkConv = againstStrongGkGoals / Math.max(1, againstStrongGkShots);
    expect(weakGkConv).toBeGreaterThan(strongGkConv);
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
    const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1, reps: { homeRep: 4, awayRep: 4 } });
    const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
    let guard = 0;
    while (!st.ended && guard++ < 500) {
      tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true, reps: { homeRep: 4, awayRep: 4 } });
    }
    expect(st.ended).toBe(true);
    const match = buildMatchFromState(st, home, away, players2, { homeRep: 4, awayRep: 4 });
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
    const res = performLiveSub(rng, home, away, players, st, 0, outId, inId, { homeRep: 4, awayRep: 4 });
    expect(res.error).toBeUndefined();
    expect(res.event?.type).toBe(6);
    expect(st.homeOn).toContain(inId);
    expect(st.homeOn).not.toContain(outId);
    expect(st.homeSubs).not.toContain(inId);
    expect(st.usedSubs[0]).toBe(1);
    const gkId = st.homeOn.find((id) => find(id).position === 0)!;
    const nonGk = st.homeSubs.find((id) => find(id).position !== 0)!;
    const res2 = performLiveSub(rng, home, away, players, st, 0, gkId, nonGk, { homeRep: 4, awayRep: 4 });
    expect(res2.error).toBeDefined();
    const bad = performLiveSub(rng, home, away, players, st, 0, 99999, inId, { homeRep: 4, awayRep: 4 });
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
      while (!st.ended && guard++ < 500) tickLiveMatch(rng, home, away, players, st, 5, { ignoreHalfTime: true, reps: { homeRep: 4, awayRep: 4 } });
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
    const lowVal = calculatePlayerValue(low.overall, low.age, 3);
    const highVal = calculatePlayerValue(high.overall, high.age, 3);
    expect(highVal).toBeGreaterThan(lowVal);
    expect(lowVal).toBeGreaterThan(500);
    const lowSal = calculateBaseSalary(low.overall, low.age);
    const highSal = calculateBaseSalary(high.overall, high.age);
    expect(highSal).toBeGreaterThan(lowSal);
    expect(lowSal).toBeGreaterThanOrEqual(500);
    expect(calculatePlayerValue(90, 25, 1)).toBeLessThan(calculatePlayerValue(90, 25, 5));
    expect(calculateBaseSalary(50, 24)).toBe(calculateBaseSalary(50, 24));
  });

  it("world generation produces sensible overalls", () => {
    const world = generateWorld(77);
    initSeason(world, { year: 2026, month: 1 }, 1);
    const overalls = world.players.map((p) => p.overall);
    const avg = overalls.reduce((s, x) => s + x, 0) / overalls.length;
    expect(avg).toBeGreaterThan(15);
    expect(avg).toBeLessThan(90);
    const max = Math.max(...overalls);
    expect(max).toBeLessThanOrEqual(100);
    const min = Math.min(...overalls);
    expect(min).toBeGreaterThanOrEqual(1);
    const seniors = world.players.filter((p) => !p.isYouth);
    const seniorAvg = seniors.reduce((s, p) => s + p.overall, 0) / seniors.length;
    expect(seniorAvg).toBeGreaterThan(15);
    expect(seniorAvg).toBeLessThan(80);
    const gks = world.players.filter((p) => p.position === 0);
    expect(gks.length).toBeGreaterThan(0);
  });
});

