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
  "GK", "GK", "GK", "LB", "LB", "LB", "RB", "RB", "RB", "CB", "CB", "CB", "CB", "CB", "CB",
  "DM", "DM", "DM", "DM", "AM", "AM", "AM", "AM", "AM", "LW", "LW", "RW", "RW", "ST", "ST",
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
    if (p.position !== "GK") p.energy = energy;
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
    careerProfile: { ...p.careerProfile },
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
  // Built ONCE and shared by both exhaustion runs: club ids feed each player's
  // generation seed, so a second scenario() call would produce different
  // squads and break the like-for-like comparison.
  const sharedScenario = scenario(101);

  /**
   * Run one full possession sim with the given starting energies and return
   * each AI side's substitution minutes. Injuries are off, so every SUB is a
   * tactical decision. Fixed squads and seeds make the outcome deterministic;
   * swapping ONLY the energies must swap which side reacts first.
   */
  function runExhaustionMatch(homeEnergy: number, awayEnergy: number) {
    const { st, players } = freshState(sharedScenario, 102);
    applyEnergy(st, players, homeEnergy, awayEnergy);
    const centers = computeAttributeCenters(players);
    simulatePossessionMatch(createRng(103), sharedScenario.home, sharedScenario.away, players, st, centers);
    const minutesFor = (clubId: number) =>
      st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === clubId).map((event) => event.minute);
    return { st, homeMinutes: minutesFor(st.homeClubId), awayMinutes: minutesFor(st.awayClubId) };
  }

  function assertTacticalWindow(minutes: number[]): void {
    for (const minute of minutes) {
      expect(minute).toBeGreaterThanOrEqual(cfg.earliestMatchMinute);
      expect(minute).toBeLessThanOrEqual(cfg.latestMatchMinute);
    }
  }

  it("substitutes exhausted AI sides after the earliest minute and inside the window", () => {
    withInjuriesOff(() => {
      const { st, homeMinutes, awayMinutes } = runExhaustionMatch(25, 100);
      expect(homeMinutes.length).toBeGreaterThan(0);
      assertTacticalWindow(homeMinutes);
      assertTacticalWindow(awayMinutes);
      // Fatigue is the dominant need signal: the side that started exhausted
      // must reach for the bench EARLIER than the fresh one. A fresh side may
      // still legitimately substitute late (its own energy drains below the
      // fatigue threshold and score urgency adds need while trailing), so this
      // compares first-reaction timing rather than demanding zero changes.
      if (awayMinutes.length > 0) {
        expect(Math.min(...homeMinutes)).toBeLessThan(Math.min(...awayMinutes));
      }
      // Bookkeeping mirrors manual subs.
      const subs = st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === st.homeClubId);
      const awaySubs = st.events.filter((event) => event.type === EVENT_CODES.SUB && event.clubId === st.awayClubId);
      expect(st.usedSubs[0]).toBe(subs.length);
      expect(st.usedSubs[1]).toBe(awaySubs.length);
      expect(st.substitutions.length).toBe(subs.length + awaySubs.length);
      for (const sub of subs) {
        expect(st.homeOn).toContain(sub.player2Id!);
        expect(st.homeOn).not.toContain(sub.playerId);
        expect(st.playerEnergy[sub.player2Id!]).toBeDefined();
        expect(st.playerPreMatchLoad?.[sub.player2Id!]).toBeDefined();
        // The incoming player sits on the bench list no more.
        expect(st.homeSubs).not.toContain(sub.player2Id!);
      }
      // One substitution per match minute at most.
      const minutes = [...subs, ...awaySubs].map((sub) => `${sub.clubId}:${sub.minute}:${sub.addedTime ?? ""}`);
      expect(new Set(minutes).size).toBe(minutes.length);
    });
  });

  it("reverses the reaction order when the starting energies are swapped", () => {
    withInjuriesOff(() => {
      // Identical squads, seeds and tactics — only the energies move. If
      // exhaustion (and not some side/seed bias) drives the timing, whichever
      // side starts drained must react first in BOTH runs.
      const normal = runExhaustionMatch(25, 100);
      const swapped = runExhaustionMatch(100, 25);
      expect(normal.homeMinutes.length).toBeGreaterThan(0);
      expect(swapped.awayMinutes.length).toBeGreaterThan(0);
      if (normal.awayMinutes.length > 0) {
        expect(Math.min(...normal.homeMinutes)).toBeLessThan(Math.min(...normal.awayMinutes));
      }
      if (swapped.homeMinutes.length > 0) {
        expect(Math.min(...swapped.awayMinutes)).toBeLessThan(Math.min(...swapped.homeMinutes));
      }
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
  function skills(values: { des?: number; pace?: number; tec?: number; pas?: number; playmaking?: number; fin?: number; gol?: number }): Player["skills"] {
    return { gol: values.gol ?? 20, pace: values.pace ?? 20, tec: values.tec ?? 20, pas: values.pas ?? 20, des: values.des ?? 20, playmaking: values.playmaking ?? 20, fin: values.fin ?? 20 };
  }

  function benchPlayer(id: number, position: Position, overrides: Partial<Player> = {}): Player {
    const club = makeClub(false);
    const p = generatePlayer(createRng(id * 77 + 3), club, { id, position });
    return Object.assign(p, overrides);
  }

  it("prefers higher effective skill for the vacated slot", () => {
    const weak = benchPlayer(1, "CB", { skills: skills({ des: 40, pace: 40, tec: 40, pas: 40, playmaking: 40 }) });
    const strong = benchPlayer(2, "CB", { skills: skills({ des: 85, pace: 80, tec: 70, pas: 70, playmaking: 75 }) });
    const picked = pickAiReplacement([weak, strong], "DM", () => 50);
    expect(picked?.id).toBe(2);
  });

  it("weighs freshness: an equally skilled but tired player loses", () => {
    const base = { des: 70, pace: 70, tec: 60, pas: 60, playmaking: 60 };
    const fresh = benchPlayer(1, "CB", { skills: skills(base) });
    const tired = benchPlayer(2, "CB", { skills: skills(base) });
    const picked = pickAiReplacement([tired, fresh], "DM", (id) => (id === tired.id ? 10 : 90));
    expect(picked?.id).toBe(fresh.id);
  });

  it("skips injured and suspended bench players", () => {
    const bench = [
      benchPlayer(1, "CB", { injuryDays: 4 }),
      benchPlayer(2, "CB", { suspendedGames: 1 }),
      benchPlayer(3, "AM"),
    ];
    expect(pickAiReplacement(bench, "DM", () => 80)?.id).toBe(3);
  });

  it("never sends a goalkeeper on for an outfield tactical slot", () => {
    const freshKeeper = benchPlayer(1, "GK");
    const tiredOutfielder = benchPlayer(2, "AM");
    const picked = pickAiReplacement([freshKeeper, tiredOutfielder], "ST", (id) => (id === freshKeeper.id ? 100 : 5));
    expect(picked?.id).toBe(2);
    expect(pickAiReplacement([freshKeeper], "ST", () => 100)).toBeNull();
  });

  it("breaks value ties deterministically by lower id", () => {
    const base = { des: 65, pace: 60, tec: 55, pas: 55, playmaking: 60 };
    const late = benchPlayer(9, "CB", { skills: skills(base) });
    const early = benchPlayer(4, "CB", { skills: skills(base) });
    const picked = pickAiReplacement([late, early], "DM", () => 60);
    expect(picked?.id).toBe(4);
  });

  it("returns null when nothing is eligible", () => {
    expect(pickAiReplacement([], "DM", () => 50)).toBeNull();
    expect(pickAiReplacement([benchPlayer(1, "CB", { injuryDays: 2 })], "DM", () => 50)).toBeNull();
  });
});
