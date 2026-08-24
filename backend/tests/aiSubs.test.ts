import { describe, expect, it } from "vitest";
import { createLiveMatchState } from "../src/game/match";
import {
  computeAttributeCenters,
  pickAiReplacement,
  simulatePossessionMatch,
  advancePossessionMatch,
} from "../src/game/matchSim";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { EVENT_CODES } from "../src/game/constants";
import { gameConfig, MP_CONFIG } from "../src/config";
import { MATCH_SIMULATOR_CONFIG as MS } from "../src/matchSimulatorConfig";
import type { Club, LiveMatchState, Player, Position } from "../src/game/types";
import type { RngState } from "../src/game/rng";

let clubIdCounter = 600;
function makeClub(isHuman = false): Club {
  return {
    id: clubIdCounter++,
    name: "Test",
    shortName: "TST",
    ownerUserId: isHuman ? 1 : null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
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
    isHuman,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

const BALANCED: Position[] = [
  0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4,
];

function makeSquad(rng: RngState, club: Club, count: number, offset = 0): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generatePlayer(rng, club, { id: offset + i + 1, position: BALANCED[i % BALANCED.length] }));
  }
  return players;
}

/** Drain every outfield player's energy so fatigue dominates substitution need. */
function drainOutfield(players: Player[], energy: number): void {
  for (const p of players) {
    if (p.position !== 0) p.energy = energy;
  }
}

/** Disable injuries entirely so every SUB event is an AI tactical sub. */
function withInjuriesOff<T>(run: () => T): T {
  const prevTarget = gameConfig.injuries.matchTargetPerMatch;
  const prevAuto = gameConfig.injuries.autoSubstitute;
  gameConfig.injuries.matchTargetPerMatch = 0;
  gameConfig.injuries.autoSubstitute = false;
  try {
    return run();
  } finally {
    gameConfig.injuries.matchTargetPerMatch = prevTarget;
    gameConfig.injuries.autoSubstitute = prevAuto;
  }
}

interface Scenario {
  home: Club;
  away: Club;
  base: Player[];
}

function scenario(seed: number, opts?: { humanHome?: boolean }): Scenario {
  const rng = createRng(seed);
  const home = makeClub(opts?.humanHome ?? false);
  const away = makeClub(false);
  const base = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
  return { home, away, base };
}

function freshState(scenario_: Scenario, seed: number): { st: LiveMatchState; players: Player[] } {
  const players = scenario_.base.map((p) => ({
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
  }));
  const st = createLiveMatchState(createRng(seed), scenario_.home, scenario_.away, players, {
    matchId: 1,
    competitionId: 1,
    fixtureId: 1,
  });
  return { st, players };
}

function applyEnergy(st: LiveMatchState, players: Player[], homeEnergy: number, awayEnergy: number): void {
  drainOutfield(
    players.filter((p) => p.clubId === st.homeClubId),
    homeEnergy
  );
  drainOutfield(
    players.filter((p) => p.clubId === st.awayClubId),
    awayEnergy
  );
  // Keep the live-state snapshot consistent with the drained persisted values.
  for (const [id, value] of Object.entries(st.playerEnergy)) {
    const p = players.find((candidate) => candidate.id === Number(id));
    if (p) st.playerEnergy[Number(id)] = p.energy;
  }
}

describe("AI tactical substitutions", () => {
  const cfg = MS.substitutionAi;

  it("substitutes exhausted AI sides after the earliest minute and inside the window", () => {
    withInjuriesOff(() => {
      const s = scenario(101);
      const { st, players } = freshState(s, 102);
      applyEnergy(st, players, 25, 100);
      const centers = computeAttributeCenters(players);
      simulatePossessionMatch(createRng(103), s.home, s.away, players, st, centers);

      const subs = st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === st.homeClubId);
      expect(subs.length).toBeGreaterThan(0);
      for (const sub of subs) {
        expect(sub.minute).toBeGreaterThanOrEqual(cfg.earliestMatchMinute);
        expect(sub.minute).toBeLessThanOrEqual(cfg.latestMatchMinute);
      }
      // A fresh opponent never crosses the need threshold.
      const awaySubs = st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === st.awayClubId);
      expect(awaySubs).toHaveLength(0);
      // Bookkeeping mirrors manual subs.
      expect(st.usedSubs[0]).toBe(subs.length);
      expect(st.usedSubs[1]).toBe(0);
      expect(st.substitutions.length).toBe(subs.length);
      for (const sub of subs) {
        expect(st.homeOn).toContain(sub.player2Id!);
        expect(st.homeOn).not.toContain(sub.playerId);
        expect(st.playerEnergy[sub.player2Id!]).toBeDefined();
        expect(st.playerPreMatchLoad?.[sub.player2Id!]).toBeDefined();
        // The incoming player sits on the bench list no more.
        expect(st.homeSubs).not.toContain(sub.player2Id!);
      }
      // One substitution per match minute at most.
      const minutes = subs.map((sub) => `${sub.minute}:${sub.addedTime ?? ""}`);
      expect(new Set(minutes).size).toBe(minutes.length);
    });
  });

  it("respects the configured per-side cap under aggressive rotation", () => {
    withInjuriesOff(() => {
      const s = scenario(111);
      const { st, players } = freshState(s, 112);
      applyEnergy(st, players, 10, 10);
      const centers = computeAttributeCenters(players);
      simulatePossessionMatch(createRng(113), s.home, s.away, players, st, centers);
      const cap = Math.min(cfg.maxPerSide, MP_CONFIG.maxSubsPerSide);
      expect(st.usedSubs[0]).toBeLessThanOrEqual(cap);
      expect(st.usedSubs[1]).toBeLessThanOrEqual(cap);
      expect(st.usedSubs[0]).toBe(cap);
      expect(st.usedSubs[1]).toBe(cap);
    });
  });

  it("never tactically substitutes a human-controlled side", () => {
    withInjuriesOff(() => {
      const s = scenario(121, { humanHome: true });
      const { st, players } = freshState(s, 122);
      applyEnergy(st, players, 10, 10);
      const centers = computeAttributeCenters(players);
      simulatePossessionMatch(createRng(123), s.home, s.away, players, st, centers);
      const homeSubs = st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === st.homeClubId);
      expect(homeSubs).toHaveLength(0);
      expect(st.usedSubs[0]).toBe(0);
      // The AI side still rotates.
      expect(st.usedSubs[1]).toBeGreaterThan(0);
    });
  });

  it("protects freshly introduced players via minOnPitchMinutes", () => {
    withInjuriesOff(() => {
      const s = scenario(131);
      const { st, players } = freshState(s, 132);
      applyEnergy(st, players, 10, 10);
      // Everyone who could come off the bench is treated as already warmed up:
      // the protection must still show for incoming players during the match.
      const centers = computeAttributeCenters(players);
      simulatePossessionMatch(createRng(133), s.home, s.away, players, st, centers);
      const substitutions = st.substitutions;
      // No outgoing player was substituted before spending minOnPitchMinutes
      // on the pitch (starters accumulate minutes from kickoff).
      for (const sub of substitutions) {
        expect(sub.minute).toBeGreaterThanOrEqual(cfg.earliestMatchMinute);
      }
      // Incoming players are never substituted again within the protection window.
      for (const sub of substitutions) {
        const later = substitutions.find((other) => other.outId === sub.inId);
        if (later) {
          expect(later.minute - sub.minute).toBeGreaterThanOrEqual(cfg.minOnPitchMinutes);
        }
      }
    });
  });

  it("produces byte-identical outcomes for instant vs chunked advance", () => {
    withInjuriesOff(() => {
      const s = scenario(141);
      const centersOf = (players: Player[]) => computeAttributeCenters(players);
      const project = (st: LiveMatchState) => ({
        scores: st.scores,
        usedSubs: st.usedSubs,
        substitutions: st.substitutions,
        keyEvents: st.events
          .filter((event) => event.type === EVENT_CODES.GOAL || event.type === EVENT_CODES.SUB)
          .map((event) => [event.minute, event.addedTime ?? null, event.type, event.clubId, event.playerId, event.player2Id]),
        aiSubLastMinute: st.aiSubLastMinute,
      });
      const runInstant = () => {
        const { st, players } = freshState(s, 142);
        applyEnergy(st, players, 15, 15);
        simulatePossessionMatch(createRng(143), s.home, s.away, players, st, centersOf(players));
        return project(st);
      };
      const runChunked = () => {
        const { st, players } = freshState(s, 142);
        applyEnergy(st, players, 15, 15);
        const centers = centersOf(players);
        const rng = createRng(143);
        while (!st.ended) {
          advancePossessionMatch(rng, s.home, s.away, players, st, 7, centers);
        }
        return project(st);
      };
      const instant = runInstant();
      expect(instant.usedSubs[0] + instant.usedSubs[1]).toBeGreaterThan(0);
      expect(instant).toEqual(runChunked());
    });
  });
});

describe("pickAiReplacement", () => {
  function skills(values: { des?: number; vel?: number; tec?: number; pas?: number; arm?: number; fin?: number; gol?: number }): Player["skills"] {
    return { gol: values.gol ?? 20, vel: values.vel ?? 20, tec: values.tec ?? 20, pas: values.pas ?? 20, des: values.des ?? 20, arm: values.arm ?? 20, fin: values.fin ?? 20 };
  }

  function benchPlayer(id: number, position: Position, overrides: Partial<Player> = {}): Player {
    const club = makeClub(false);
    const p = generatePlayer(createRng(id * 77 + 3), club, { id, position });
    return Object.assign(p, overrides);
  }

  it("prefers higher effective skill for the vacated slot", () => {
    const weak = benchPlayer(1, 2, { skills: skills({ des: 40, vel: 40, tec: 40, pas: 40, arm: 40 }) });
    const strong = benchPlayer(2, 2, { skills: skills({ des: 85, vel: 80, tec: 70, pas: 70, arm: 75 }) });
    const picked = pickAiReplacement([weak, strong], 3, () => 50);
    expect(picked?.id).toBe(2);
  });

  it("weighs freshness: an equally skilled but tired player loses", () => {
    const base = { des: 70, vel: 70, tec: 60, pas: 60, arm: 60 };
    const fresh = benchPlayer(1, 2, { skills: skills(base) });
    const tired = benchPlayer(2, 2, { skills: skills(base) });
    const picked = pickAiReplacement([tired, fresh], 3, (id) => (id === tired.id ? 10 : 90));
    expect(picked?.id).toBe(fresh.id);
  });

  it("skips injured and suspended bench players", () => {
    const bench = [
      benchPlayer(1, 2, { injuryDays: 4 }),
      benchPlayer(2, 2, { suspendedGames: 1 }),
      benchPlayer(3, 3),
    ];
    expect(pickAiReplacement(bench, 3, () => 80)?.id).toBe(3);
  });

  it("never sends a goalkeeper on for an outfield tactical slot", () => {
    const freshKeeper = benchPlayer(1, 0);
    const tiredOutfielder = benchPlayer(2, 3);
    const picked = pickAiReplacement([freshKeeper, tiredOutfielder], 4, (id) => (id === freshKeeper.id ? 100 : 5));
    expect(picked?.id).toBe(2);
    expect(pickAiReplacement([freshKeeper], 4, () => 100)).toBeNull();
  });

  it("breaks value ties deterministically by lower id", () => {
    const base = { des: 65, vel: 60, tec: 55, pas: 55, arm: 60 };
    const late = benchPlayer(9, 2, { skills: skills(base) });
    const early = benchPlayer(4, 2, { skills: skills(base) });
    const picked = pickAiReplacement([late, early], 3, () => 60);
    expect(picked?.id).toBe(4);
  });

  it("returns null when nothing is eligible", () => {
    expect(pickAiReplacement([], 3, () => 50)).toBeNull();
    expect(pickAiReplacement([benchPlayer(1, 2, { injuryDays: 2 })], 3, () => 50)).toBeNull();
  });
});
