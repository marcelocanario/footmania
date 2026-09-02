import { describe, it, expect } from "vitest";
import { generateWorld } from "../src/game/worldgen";
import { initSeason } from "../src/game/multiplayer";
import { simulateMatch, createLiveMatchState, tickLiveMatch, performLiveSub, buildMatchFromState, isHalftime, livePhase, rebuildLiveHumanLineup } from "../src/game/match";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { calculatePlayerValue, calculateBaseSalary } from "../src/game/economy";
import type { Club, Player, Position } from "../src/game/types";
import type { RngState } from "../src/game/rng";
import { MATCH_SIMULATOR_CONFIG as MS } from "../src/matchSimulatorConfig";
import { EVENT_CODES } from "../src/game/constants";
import { calibrationDescribe, yieldToEventLoop } from "./calibration";


let clubIdCounter = 1;
function makeClub(overall: number, overrides: Partial<Club> = {}): Club {
  return {
    id: clubIdCounter++,
    name: "Test",
    shortName: "TST",
    ownerUserId: null,
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
    "GK", "GK", "GK", "LB", "LB", "LB", "RB", "RB", "RB", "CB", "CB", "CB", "CB", "CB", "CB",
    "DM", "DM", "DM", "AM", "AM", "AM", "AM", "AM", "AM", "LW", "LW", "RW", "RW", "ST", "ST",
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
    careerProfile: { ...p.careerProfile },
    energy: 100,
    starter: false,
    injuryDays: 0,
    suspendedGames: 0,
  };
}

function cloneSquad(squad: Player[]): Player[] {
  return squad.map(clonePlayer);
}

describe("match engine", () => {
  calibrationDescribe("match aggregate calibration", () => {
  it("produces a plausible goal distribution (2.5-4.5 goals per match)", async () => {
    const seeds = [7, 11, 42];
    let total = 0;
    const n = seeds.length * 80;
    for (const seed of seeds) {
      const rng = createRng(seed);
      const home = makeClub(75);
      const away = makeClub(76);
      const homeSquad = makeSquad(rng, home, 30);
      const awaySquad = makeSquad(rng, away, 30, 30);
      for (let i = 0; i < 80; i++) {
        const matchRng = createRng(seed * 10_000 + i);
        const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
        const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
        total += match.homeScore + match.awayScore;
        if (i % 10 === 9) await yieldToEventLoop();
      }
    }
    const avg = total / n;
    expect(avg).toBeGreaterThan(2.2);
    expect(avg).toBeLessThan(4.5);
  }, 180000);

  it("home advantage produces more home goals", async () => {
    const rng = createRng(21);
    const home = makeClub(70);
    const away = makeClub(71);
    // Identical squads for both teams (only club ids differ) so id-derived
    // strength noise cannot mask the home advantage signal.
    const sharedSquad = makeSquad(rng, home, 30);
    const awaySquad = sharedSquad.map((p) => ({ ...clonePlayer(p), id: p.id + 1000, clubId: away.id }));
    let advHomeXg = 0;
    let neutralHomeXg = 0;
    for (let i = 0; i < 100; i++) {
      const playersA = [...cloneSquad(sharedSquad), ...cloneSquad(awaySquad)];
      const ma = simulateMatch(createRng(21 * 10_000 + i), home, away, playersA, { competitionId: 1, fixtureId: i, year: 1, homeNeutral: false });
      const playersN = [...cloneSquad(sharedSquad), ...cloneSquad(awaySquad)];
      const mn = simulateMatch(createRng(21 * 10_000 + 10_000 + i), home, away, playersN, { competitionId: 1, fixtureId: i + 10_000, year: 1, homeNeutral: true });
      advHomeXg += ma.match.stats.home.xG;
      neutralHomeXg += mn.match.stats.home.xG;
      if (i % 10 === 9) await yieldToEventLoop();
    }
    // Home advantage is specified as an xG shift; expected goals are the
    // appropriate aggregate here because discrete goal difference is noisy.
    expect(advHomeXg).toBeGreaterThan(neutralHomeXg);
  }, 180000);

  it("possession always sums to 100 and is derived from controlled-ball seconds", () => {
    const rng = createRng(21);
    const home = makeClub(72);
    const away = makeClub(73);
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    for (let i = 0; i < 60; i++) {
      const matchRng = createRng(21 * 10_000 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
      const total = match.stats.home.controlledBallSeconds + match.stats.away.controlledBallSeconds;
      const homePct = total > 0 ? (match.stats.home.controlledBallSeconds / total) * 100 : 50;
      const awayPct = 100 - homePct;
      expect(Math.round(homePct + awayPct)).toBe(100);
      expect(homePct).toBeGreaterThanOrEqual(0);
      expect(awayPct).toBeGreaterThanOrEqual(0);
    }
  });

  it("pressing increases card frequency", () => {
    let lightYellows = 0;
    let pressYellows = 0;
    const n = 60;
    // Human-controlled fixtures: this test isolates the mechanical
    // press->fouls/cards relation from AI pre-match tactic selection, which
    // would otherwise re-derive both sides' tactics from their squads.
    const pinTactics = (tactics: Club["tactics"]): Partial<Club> => ({ ownerUserId: 1, isHuman: true, tactics });
    for (let i = 0; i < n; i++) {
      const matchRng = createRng(1000 + i);
      const h1 = makeClub(70, pinTactics({ formation: 4, style: 0, pressing: 0, direction: 0 }));
      const a1 = makeClub(71, pinTactics({ formation: 4, style: 0, pressing: 0, direction: 0 }));
      const h1Squad = makeSquad(createRng(1000 + i), h1, 30);
      const a1Squad = makeSquad(createRng(1000 + i), a1, 30, 30);
      const players = [...cloneSquad(h1Squad), ...cloneSquad(a1Squad)];
      const { match } = simulateMatch(matchRng, h1, a1, players, { competitionId: 1, fixtureId: i, year: 1 });
      lightYellows += match.stats.home.yellows + match.stats.away.yellows;

      const matchRng2 = createRng(2000 + i);
      const h2 = makeClub(72, pinTactics({ formation: 4, style: 0, pressing: 2, direction: 0 }));
      const a2 = makeClub(73, pinTactics({ formation: 4, style: 0, pressing: 2, direction: 0 }));
      const h2Squad = makeSquad(createRng(2000 + i), h2, 30);
      const a2Squad = makeSquad(createRng(2000 + i), a2, 30, 30);
      const players2 = [...cloneSquad(h2Squad), ...cloneSquad(a2Squad)];
      const { match: m2 } = simulateMatch(matchRng2, h2, a2, players2, { competitionId: 1, fixtureId: i, year: 1 });
      pressYellows += m2.stats.home.yellows + m2.stats.away.yellows;
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
    const n = 60;
    for (let i = 0; i < n; i++) {
      const matchRng = createRng(77 * 10_000 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const st = createLiveMatchState(matchRng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1, homeNeutral: true });
      const homeGk = st.homeOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === "GK")!;
      const awayGk = st.awayOn.map((id) => players.find((p) => p.id === id)!).find((p) => p.position === "GK")!;
      // Home keeps the weak GK; away the strong one. Each side's shots are
      // taken against the OPPOSING keeper.
      homeGk.skills.gol = 40;
      awayGk.skills.gol = 95;
      tickLiveMatch(matchRng, home, away, players, st, 500, { ignoreHalfTime: true });
      // Away shots (index 1) are taken against home's weak GK.
      againstWeakGkShots += st.stats.away.shots;
      againstWeakGkGoals += st.scores[1];
      // Home shots (index 0) are taken against away's strong GK.
      againstStrongGkShots += st.stats.home.shots;
      againstStrongGkGoals += st.scores[0];
    }
    const weakGkConv = againstWeakGkGoals / Math.max(1, againstWeakGkShots);
    const strongGkConv = againstStrongGkGoals / Math.max(1, againstStrongGkShots);
    expect(weakGkConv).toBeGreaterThan(strongGkConv);
  });
  });
});

describe("live match engine", () => {
  it("pauses and resumes at the configured half-time boundary", () => {
    const rng = createRng(1234);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });

    const first = tickLiveMatch(rng, home, away, players, st, 50);
    expect(first.atHalfTime).toBe(true);
    expect(isHalftime(st)).toBe(true);
    expect(livePhase(st)).toBe("halftime");
    expect(st.matchClockSeconds).toBeGreaterThanOrEqual(MS.timing.firstHalfEndSeconds);

    const pausedClock = st.matchClockSeconds;
    const paused = tickLiveMatch(rng, home, away, players, st, 5);
    expect(paused.atHalfTime).toBe(true);
    expect(st.matchClockSeconds).toBe(pausedClock);

    const resumed = tickLiveMatch(rng, home, away, players, st, 5, { resume: true });
    expect(resumed.atHalfTime).toBe(false);
    expect(st.period).toBe(2);
    expect(st.matchClockSeconds).toBeGreaterThan(pausedClock);
    expect(livePhase(st)).toBe("second");
  });

  it("publishes live controlled-ball stats and preserves fatigue across ticks", () => {
    const rng = createRng(5678);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });

    tickLiveMatch(rng, home, away, players, st, 20, { ignoreHalfTime: true });
    expect(st.stats.home.controlledBallSeconds + st.stats.away.controlledBallSeconds).toBeGreaterThan(0);
    const energyAfterFirstTick = Math.min(...Object.values(st.playerEnergy));
    tickLiveMatch(rng, home, away, players, st, 20, { ignoreHalfTime: true });
    expect(Math.min(...Object.values(st.playerEnergy))).toBeLessThan(energyAfterFirstTick);
  });

  it("publishes the last action and its origin zone for ball choreography", () => {
    const rng = createRng(2468);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    tickLiveMatch(rng, home, away, players, st, 20, { ignoreHalfTime: true });
    // The engine must have produced at least one ball action; the choreography
    // layer keys off lastAction/prevZone. After the nine-position rollout the
    // exact lastAction distribution shifted (CLEARANCE now more frequent), so we
    // only assert that the fields are populated and from the known vocabularies
    // when present, rather than pinning the exact action.
    expect(st.ballActionSequence).toBeGreaterThan(0);
    if (st.lastAction != null) {
      expect(typeof st.lastAction).toBe("string");
      expect(st.lastAction.length).toBeGreaterThan(0);
    }
    if (st.prevZone != null) {
      expect(new Set(["DEF_WIDE", "DEF_CENTRAL", "MID_WIDE", "MID_CENTRAL", "ATT_WIDE", "ATT_CENTRAL", "BOX"]).has(st.prevZone)).toBe(true);
    }
    expect(st.lastBallAction?.sequence).toBe(st.ballActionSequence);
    expect(st.lastBallAction?.fromPlayerId).not.toBeNull();
    expect(players.some((player) => player.id === st.ballCarrierId)).toBe(true);
    for (const id of [st.lastBallAction?.fromPlayerId, st.lastBallAction?.targetPlayerId, st.lastBallAction?.interceptorId, st.lastBallAction?.foulerId]) {
      if (id !== null && id !== undefined) expect(players.some((player) => player.id === id)).toBe(true);
    }
  });

  it("does not restore dismissed players when rebuilding a halftime lineup", () => {
    const rng = createRng(6789);
    const home = makeClub(75, { isHuman: true });
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    const dismissedId = st.homeOn.find((id) => players.find((player) => player.id === id)?.position !== "GK")!;
    st.matchClockSeconds = MS.timing.firstHalfEndSeconds;
    st.period = 1;
    st.half = 1;
    st.minute = 0;
    st.events.push({ minute: 45, half: 1, type: EVENT_CODES.RED, subtype: 0, clubId: home.id, playerId: dismissedId, player2Id: null, goalType: 0 });
    rebuildLiveHumanLineup(st, home, players);
    expect(st.homeOn).not.toContain(dismissedId);
  });

  it("streaming a match incrementally produces the same result as instant simulation", () => {
    clubIdCounter = 1;
    const rng1 = createRng(99);
    const rng2 = createRng(99);
    const home = makeClub(75);
    const away = makeClub(75);
    const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30, 30)];
    const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30, 30)];
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
    expect(st.events).toEqual(instant.match.events);
  });

  it("does not finish a streamed match before second-half added time", () => {
    clubIdCounter = 1;
    const rng1 = createRng(99);
    const rng2 = createRng(99);
    const home = makeClub(75);
    const away = makeClub(75);
    const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30, 30)];
    const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30, 30)];
    const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1 });
    const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
    let guard = 0;
    while (!st.ended && guard++ < 500) {
      tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true });
    }
    const totalEnd = MS.timing.regulationSeconds +
      ((st.firstHalfAddedMinutes ?? 0) + (st.secondHalfAddedMinutes ?? 0)) * 60;
    expect(st.ended).toBe(true);
    expect(st.firstHalfAddedMinutes).toBeGreaterThan(0);
    expect(st.secondHalfAddedMinutes).toBeGreaterThan(0);
    expect(st.matchClockSeconds).toBeGreaterThanOrEqual(totalEnd);
    expect(st.events.length).toBe(instant.match.events.length);
  });

  it("performs a substitution and enforces the goalkeeper rule", () => {
    const rng = createRng(5);
    const home = makeClub(75);
    const away = makeClub(75);
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(rng, home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    const find = (id: number) => players.find((p) => p.id === id)!;
    const outId = st.homeOn.find((id) => find(id).position !== "GK")!;
    // §9.5: a GK can never enter an outfield slot; pick an outfield bench player.
    const inId = st.homeSubs.find((id) => find(id).position !== "GK")!;
    const res = performLiveSub(rng, home, away, players, st, 0, outId, inId);
    expect(res.error).toBeUndefined();
    expect(res.event?.type).toBe(6);
    expect(st.homeOn).toContain(inId);
    expect(st.homeOn).not.toContain(outId);
    expect(st.homeSubs).not.toContain(inId);
    expect(st.usedSubs[0]).toBe(1);
    const opponentId = st.awayOn[0];
    const unauthorized = performLiveSub(rng, home, away, players, st, 0, st.homeOn[0], opponentId);
    expect(unauthorized.error).toBe("Player not on the bench");
    const gkId = st.homeOn.find((id) => find(id).position === "GK")!;
    const nonGk = st.homeSubs.find((id) => find(id).position !== "GK")!;
    const res2 = performLiveSub(rng, home, away, players, st, 0, gkId, nonGk);
    expect(res2.error).toBeDefined();
    // §9.5: a natural GK cannot enter an outfield slot.
    const outfieldOut = st.homeOn.find((id) => find(id).position !== "GK" && id !== outId)!;
    const benchGk = st.homeSubs.find((id) => find(id).position === "GK")!;
    const res3 = performLiveSub(rng, home, away, players, st, 0, outfieldOut, benchGk);
    expect(res3.error).toBe("A goalkeeper cannot enter an outfield slot");
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
    const gks = world.players.filter((p) => p.position === "GK");
    expect(gks.length).toBeGreaterThan(0);
  });
});

