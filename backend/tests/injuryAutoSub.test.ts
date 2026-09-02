import { describe, expect, it } from "vitest";
import { createLiveMatchState } from "../src/game/match";
import {
  computeAttributeCenters,
  pickInjuryReplacement,
  simulatePossessionMatch,
} from "../src/game/matchSim";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { readiness } from "../src/game/energyInjury";
import { adjustedTacticalRating } from "../src/game/outOfPosition";
import { EVENT_CODES } from "../src/game/constants";
import { gameConfig, MP_CONFIG } from "../src/config";
import { liveStateDeltaView, liveStateView } from "../src/services/liveView";
import { evaluateAutomationForMatch } from "../src/game/automation";
import { createHumanClub, generateWorld } from "../src/game/worldgen";
import type { AutomationPreset, Club, LiveMatchState, Player, Position } from "../src/game/types";
import type { RngState } from "../src/game/rng";

let clubIdCounter = 500;
function makeClub(): Club {
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
  };
}

function makeSquad(rng: RngState, club: Club, count: number, offset = 0): Player[] {
  const balanced: Position[] = ["GK", "GK", "GK", "LB", "LB", "LB", "RB", "RB", "RB", "CB", "CB", "CB", "CB", "CB", "CB", "DM", "DM", "DM", "AM", "AM", "AM", "AM", "AM", "AM", "LW", "LW", "RW", "RW", "ST", "ST"];
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generatePlayer(rng, club, { id: offset + i + 1, position: balanced[i % balanced.length] }));
  }
  return players;
}

function player(id: number, position: Position, overrides: Partial<Player> = {}): Player {
  const club = makeClub();
  const p = generatePlayer(createRng(id * 77 + 1), club, { id, position });
  return Object.assign(p, overrides);
}

describe("pickInjuryReplacement", () => {
  it("prefers the highest-overall healthy bench player of the same position", () => {
    const bench = [
      player(1, "CB", { overall: 60 }),
      player(2, "CB", { overall: 74 }),
      player(3, "CB", { overall: 70, injuryDays: 4 }),
      player(4, "AM", { overall: 90 }),
    ];
    expect(pickInjuryReplacement(bench, "CB")?.id).toBe(2);
  });

  it("falls back to the best adjusted-score outfielder when no same-position player exists", () => {
    const bench = [
      player(5, "AM", { overall: 66 }),
      player(6, "ST", { overall: 71 }),
      player(7, "AM", { overall: 80, suspendedGames: 2 }),
    ];
    // §9.5: rank by actual adjusted role rating, not natural-position equality.
    const picked = pickInjuryReplacement(bench, "CB");
    expect(picked).not.toBeNull();
    expect(picked!.id).not.toBe(7); // suspended
    // The winner is whichever outfielder has the highest CB-adjusted rating
    // (an AM can legitimately outscore a ST at CB).
    const score = (p: Player) => (adjustedTacticalRating(p.skills, p.position, "CB") ?? 0) * readiness(p.energy);
    const expected = [5, 6].sort((a, b) => score(bench.find((p) => p.id === b)!) - score(bench.find((p) => p.id === a)!) || a - b)[0];
    expect(picked!.id).toBe(expected);
  });

  it("never replaces an outfielder with a goalkeeper when outfielders exist", () => {
    expect(pickInjuryReplacement([player(9, "ST", { overall: 40 })], "ST")?.id).toBe(9);
  });

  it("replaces a goalkeeper only with a goalkeeper", () => {
    const bench = [player(10, "AM", { overall: 95 }), player(11, "GK", { overall: 55 })];
    expect(pickInjuryReplacement(bench, "GK")?.id).toBe(11);
  });

  it("returns null when nothing eligible remains", () => {
    expect(pickInjuryReplacement([], "CB")).toBeNull();
    expect(pickInjuryReplacement([player(12, "CB", { injuryDays: 9 })], "CB")).toBeNull();
    expect(pickInjuryReplacement([player(13, "GK")], "ST")).toBeNull();
  });

  it("breaks score ties deterministically by lower id", () => {
    const skills = { gol: 40, pace: 60, tec: 60, pas: 60, des: 60, playmaking: 60, fin: 60 };
    const bench = [
      player(21, "AM", { overall: 70, skills: { ...skills } }),
      player(20, "AM", { overall: 70, skills: { ...skills } }),
    ];
    expect(pickInjuryReplacement(bench, "AM")?.id).toBe(20);
  });
});

describe("engine injury auto-substitution", () => {
  const centers = (players: Player[]) => computeAttributeCenters(players);

  function setupMatch(seed: number, targetPerMatch: number) {
    const prevTarget = gameConfig.injuries.matchTargetPerMatch;
    gameConfig.injuries.matchTargetPerMatch = targetPerMatch;
    const rng = createRng(seed);
    const home = makeClub();
    const away = makeClub();
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const st = createLiveMatchState(createRng(seed + 1), home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
    return {
      home,
      away,
      players,
      st,
      centers: centers(players),
      restore: () => {
        gameConfig.injuries.matchTargetPerMatch = prevTarget;
      },
    };
  }

  function sideCounts(st: LiveMatchState, type: number) {
    const byClub = (clubId: number) => st.events.filter((event) => event.type === type && event.clubId === clubId);
    return [byClub(st.homeClubId).length, byClub(st.awayClubId).length] as const;
  }

  it("auto-subscribes every injury while slots remain, keeping eleven on the pitch until the cap", () => {
    const setup = setupMatch(7, 6);
    try {
      simulatePossessionMatch(createRng(1), setup.home, setup.away, setup.players, setup.st, setup.centers);
      const st = setup.st;
      const [homeInjuries, awayInjuries] = sideCounts(st, EVENT_CODES.INJURY);
      const [homeSubs, awaySubs] = sideCounts(st, EVENT_CODES.SUB);
      // The seed must actually exercise the pathway.
      expect(homeInjuries + awayInjuries).toBeGreaterThan(0);
      // Auto-subs draw from the shared cap.
      expect(homeSubs).toBeLessThanOrEqual(MP_CONFIG.maxSubsPerSide);
      expect(awaySubs).toBeLessThanOrEqual(MP_CONFIG.maxSubsPerSide);
      // Every auto-sub replaces an injured player of the same side.
      const injuriesBySide = (clubId: number) =>
        st.events.filter((event) => event.type === EVENT_CODES.INJURY && event.clubId === clubId).map((event) => event.playerId);
      for (const sub of st.events.filter((event) => event.type === EVENT_CODES.SUB)) {
        expect(injuriesBySide(sub.clubId)).toContain(sub.playerId);
        expect(sub.player2Id).not.toBeNull();
      }
      // ...and every unsubbed injury means the cap was reached (benches here
      // always hold eligible candidates long before the cap is reached).
      expect(homeSubs).toBe(Math.min(MP_CONFIG.maxSubsPerSide, homeInjuries));
      expect(awaySubs).toBe(Math.min(MP_CONFIG.maxSubsPerSide, awayInjuries));
      // On-pitch counts shrink exactly by the unreplaced injuries.
      expect(st.homeOn.length).toBe(11 - (homeInjuries - homeSubs));
      expect(st.awayOn.length).toBe(11 - (awayInjuries - awaySubs));
      // Bookkeeping mirrors manual subs.
      expect(st.usedSubs[0]).toBe(homeSubs);
      expect(st.usedSubs[1]).toBe(awaySubs);
      expect(st.substitutions.length).toBe(homeSubs + awaySubs);
      const rosterIds = new Set(setup.players.map((p) => p.id));
      for (const substitution of st.substitutions) {
        expect(rosterIds.has(substitution.inId)).toBe(true);
        // Incoming players get seeded workload maps for full-time commit.
        expect(st.playerEnergy[substitution.inId]).toBeDefined();
        expect(st.playerPreMatchLoad?.[substitution.inId]).toBeDefined();
        // No double-fire: each outgoing player was substituted off once.
        expect(st.substitutions.filter((candidate) => candidate.outId === substitution.outId)).toHaveLength(1);
      }
      // The injured never reappear on the pitch list.
      for (const injury of st.events.filter((event) => event.type === EVENT_CODES.INJURY)) {
        expect(st.homeOn).not.toContain(injury.playerId);
        expect(st.awayOn).not.toContain(injury.playerId);
      }
    } finally {
      setup.restore();
    }
  });

  it("keeps the team a man short when no substitution slots remain", () => {
    const setup = setupMatch(7, 20);
    try {
      setup.st.usedSubs = [5, 5];
      simulatePossessionMatch(createRng(1), setup.home, setup.away, setup.players, setup.st, setup.centers);
      const st = setup.st;
      const [homeInjuries, awayInjuries] = sideCounts(st, EVENT_CODES.INJURY);
      const [homeSubs, awaySubs] = sideCounts(st, EVENT_CODES.SUB);
      expect(homeInjuries + awayInjuries).toBeGreaterThan(0);
      expect(homeSubs + awaySubs).toBe(0);
      expect(st.usedSubs).toEqual([5, 5]);
      // Dismissals remove a player without an injury event; both kinds of
      // absence must remain unreplaced once the shared slots are gone.
      const dismissals = (clubId: number) =>
        st.events.filter(
          (event) => (event.type === EVENT_CODES.RED || event.type === EVENT_CODES.YELLOW_RED) && event.clubId === clubId
        ).length;
      expect(st.homeOn.length).toBe(11 - homeInjuries - dismissals(st.homeClubId));
      expect(st.awayOn.length).toBe(11 - awayInjuries - dismissals(st.awayClubId));
      const removedIds = st.events
        .filter((event) => event.type === EVENT_CODES.INJURY || event.type === EVENT_CODES.RED || event.type === EVENT_CODES.YELLOW_RED)
        .map((event) => event.playerId);
      for (const removedId of removedIds) {
        expect(st.homeOn).not.toContain(removedId);
        expect(st.awayOn).not.toContain(removedId);
      }
    } finally {
      setup.restore();
    }
  });

  it("does not auto-substitute injuries when the toggle is off (AI tactical subs excepted)", () => {
    const setup = setupMatch(7, 6);
    const prevToggle = gameConfig.injuries.autoSubstitute;
    gameConfig.injuries.autoSubstitute = false;
    try {
      simulatePossessionMatch(createRng(1), setup.home, setup.away, setup.players, setup.st, setup.centers);
      const st = setup.st;
      const [homeInjuries, awayInjuries] = sideCounts(st, EVENT_CODES.INJURY);
      expect(homeInjuries + awayInjuries).toBeGreaterThan(0);
      // The injury pathway stays off: no substitution may remove an injured
      // player. AI-controlled sides may still replace the missing man through
      // their own tactical-substitution need (shorthanded team), which is not
      // governed by this toggle.
      const injuredIds = new Set(
        st.events.filter((event) => event.type === EVENT_CODES.INJURY).map((event) => event.playerId)
      );
      for (const sub of st.events.filter((event) => event.type === EVENT_CODES.SUB)) {
        expect(injuredIds.has(sub.playerId)).toBe(false);
        const side = sub.clubId === st.homeClubId ? 0 : 1;
        expect(st.subbedIn[side]).toContain(sub.player2Id!);
      }
    } finally {
      gameConfig.injuries.autoSubstitute = prevToggle;
      setup.restore();
    }
  });

  it("replays identically from identical seeds and never double-fires", () => {
    const prevTarget = gameConfig.injuries.matchTargetPerMatch;
    gameConfig.injuries.matchTargetPerMatch = 6;
    try {
      // One fixed scenario; every run gets a fresh clone so club/player ids and
      // derived skills are identical while simulation mutations cannot leak.
      const rng = createRng(23);
      const home = makeClub();
      const away = makeClub();
      const base = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
      const centers = computeAttributeCenters(base);
      const cloneSquad = () =>
        base.map((p) => ({
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
      const project = (st: LiveMatchState) => ({
        scores: st.scores,
        usedSubs: st.usedSubs,
        substitutions: st.substitutions,
        onPitch: [st.homeOn.length, st.awayOn.length],
        injuries: st.injuries.map((injury) => injury.playerId),
        keyEvents: st.events
          .filter((event) => event.type === EVENT_CODES.GOAL || event.type === EVENT_CODES.INJURY || event.type === EVENT_CODES.SUB)
          .map((event) => [event.minute, event.addedTime ?? null, event.type, event.clubId, event.playerId, event.player2Id]),
      });
      const run = () => {
        const players = cloneSquad();
        const st = createLiveMatchState(createRng(24), home, away, players, { matchId: 1, competitionId: 1, fixtureId: 1 });
        simulatePossessionMatch(createRng(1), home, away, players, st, centers);
        return project(st);
      };
      const first = run();
      expect(first.injuries.length).toBeGreaterThan(0);
      expect(first).toEqual(run());
      // No double-fire: each injured player was substituted off at most once.
      const subOutIds = first.keyEvents.filter((entry) => entry[2] === EVENT_CODES.SUB).map((entry) => entry[4]);
      expect(new Set(subOutIds).size).toBe(subOutIds.length);
    } finally {
      gameConfig.injuries.matchTargetPerMatch = prevTarget;
    }
  });
});

describe("live view missing-player projection", () => {
  function setup() {
    const world = generateWorld(2026);
    const home = createHumanClub(world, { userId: 31, clubName: "Missing Home FC", country: "BRA", preferredHours: null });
    const away = createHumanClub(world, { userId: 32, clubName: "Missing Away FC", country: "GER", preferredHours: null });
    const st = createLiveMatchState(createRng(7), home, away, world.players, { matchId: 1, fixtureId: 1, competitionId: 1 });
    const homeSquad = world.players.filter((p) => p.clubId === home.id);
    const sentOff = homeSquad[0];
    const replacedInjury = homeSquad[1];
    const stuckInjury = homeSquad[2];
    st.cards = [{ playerId: sentOff.id, kind: "RED", minute: 30 }];
    st.homeSlotByPlayerId ??= {};
    // Red cards/injuries remove the player's live slot-map entry (§9.1).
    delete st.homeSlotByPlayerId[sentOff.id];
    delete st.homeSlotByPlayerId[replacedInjury.id];
    delete st.homeSlotByPlayerId[stuckInjury.id];
    st.injuries = [
      { playerId: replacedInjury.id, days: 5, minute: 40 },
      { playerId: stuckInjury.id, days: 9, minute: 50 },
    ];
    st.events = [
      { minute: 30, half: 1, type: EVENT_CODES.RED, subtype: 0, clubId: home.id, playerId: sentOff.id, player2Id: null, goalType: 0 },
      { minute: 40, half: 1, type: EVENT_CODES.INJURY, subtype: 0, clubId: home.id, playerId: replacedInjury.id, player2Id: null, goalType: 5 },
      { minute: 40, half: 1, type: EVENT_CODES.SUB, subtype: 0, clubId: home.id, playerId: replacedInjury.id, player2Id: homeSquad[5].id, goalType: 0 },
      { minute: 50, half: 1, type: EVENT_CODES.INJURY, subtype: 0, clubId: home.id, playerId: stuckInjury.id, player2Id: null, goalType: 9 },
    ];
    return { world, home, away, st, sentOff, replacedInjury, stuckInjury };
  }

  it("lists red cards and unreplaced injuries, but not auto-subbed ones", () => {
    const { world, st, sentOff, stuckInjury } = setup();
    const view = liveStateView(world, st);
    const missing = view.missingPlayers;
    expect(missing.map((entry) => entry.playerId).sort((a, b) => a - b)).toEqual([sentOff.id, stuckInjury.id].sort((a, b) => a - b));
    const red = missing.find((entry) => entry.kind === "RED")!;
    expect(red.side).toBe(0);
    // Red cards/injuries remove the player's live slot-map entry (plan §9.1),
    // so missing players carry no slot assignment.
    expect(red.slotIndex).toBeNull();
    expect(red.deployedRole).toBeNull();
    expect(red.name.length).toBeGreaterThan(0);
    const injured = missing.find((entry) => entry.kind === "INJURY")!;
    expect(injured.playerId).toBe(stuckInjury.id);
    expect(injured.slotIndex).toBeNull();
  });

  it("carries the same snapshot on deltas so the pitch stays correct between state pushes", () => {
    const { world, st } = setup();
    const delta = liveStateDeltaView(world, st, 0);
    expect(delta.missingPlayers).toHaveLength(2);
  });

  it("sends the current roster after a red card and an unreplaced injury", () => {
    const { world, st, sentOff, stuckInjury } = setup();
    const homeOn = st.homeOn.filter((id) => id !== sentOff.id && id !== stuckInjury.id);
    st.homeOn = [sentOff.id, stuckInjury.id, ...homeOn].slice(0, 11);
    st.cards = [{ playerId: sentOff.id, kind: "RED", minute: 30 }];
    st.injuries = [{ playerId: stuckInjury.id, days: 9, minute: 50 }];
    st.events = [
      { minute: 30, half: 1, type: EVENT_CODES.RED, subtype: 0, clubId: st.homeClubId, playerId: sentOff.id, player2Id: null, goalType: 0 },
      { minute: 50, half: 1, type: EVENT_CODES.INJURY, subtype: 0, clubId: st.homeClubId, playerId: stuckInjury.id, player2Id: null, goalType: 9 },
    ];
    st.homeOn = st.homeOn.filter((id) => id !== sentOff.id && id !== stuckInjury.id);
    st.usedSubs = [MP_CONFIG.maxSubsPerSide, 0];

    const delta = liveStateDeltaView(world, st, 0);
    expect(delta.homeOn.map((player) => player.id)).not.toContain(sentOff.id);
    expect(delta.homeOn.map((player) => player.id)).not.toContain(stuckInjury.id);
    expect(delta.usedSubs[0]).toBe(MP_CONFIG.maxSubsPerSide);
    expect(delta.missingPlayers.map((entry) => entry.playerId).sort((a, b) => a - b)).toEqual(
      [sentOff.id, stuckInjury.id].sort((a, b) => a - b),
    );
  });
});

describe("automation SUB-rule invalidation", () => {
  function setup() {
    const world = generateWorld(2026);
    const club = createHumanClub(world, { userId: 41, clubName: "Auto FC", country: "BRA", preferredHours: null });
    const away = createHumanClub(world, { userId: 42, clubName: "Auto Opponent FC", country: "GER", preferredHours: null });
    const squad = world.players.filter((p) => p.clubId === club.id);
    const onPitch = squad[0];
    const healthyBench = squad[1];
    const injuredBench = squad[2];
    injuredBench.injuryDays = 4;
    const st = {
      matchId: 1,
      fixtureId: 1,
      competitionId: 1,
      homeClubId: club.id,
      awayClubId: away.id,
      ended: false,
      minute: 60,
      half: 1,
      scores: [0, 0] as [number, number],
      events: [] as import("../src/game/types").MatchEvent[],
      substitutions: [],
      usedSubs: [0, 0] as [number, number],
      subbedIn: [[], []] as number[][],
      homeOn: [onPitch.id],
      awayOn: [],
      homeSubs: [healthyBench.id, injuredBench.id],
      awaySubs: [],
      homeTactics: { formation: 4, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
      awayTactics: { formation: 4, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
      automationFiredRuleIds: [],
      playerEnergy: {},
      playerPreMatchLoad: {},
      playerMatchLoad: {},
      playerMinutes: {},
      playerRecentLoad: {},
    } as unknown as LiveMatchState;
    const presets: AutomationPreset[] = [
      {
        id: "p1",
        name: "Preset",
        formationId: club.tactics.formation,
        enabled: true,
        rules: [
          { id: "r_ok", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [{ kind: "SUB", outPlayerId: onPitch.id, inPlayerId: healthyBench.id }] },
          { id: "r_injured", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [{ kind: "SUB", outPlayerId: onPitch.id, inPlayerId: injuredBench.id }] },
          { id: "r_sold", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [{ kind: "SUB", outPlayerId: onPitch.id, inPlayerId: 987654 }] },
        ],
      },
    ];
    return { world, club, st, presets, onPitch, healthyBench, injuredBench };
  }

  it("discards rules whose incoming player could never legally enter the pitch", () => {
    const { world, club, st, presets } = setup();
    const mutated = evaluateAutomationForMatch({ world, st, side: 0, club, presets, ctx: { minute: 60, newEventsThisMinute: [] } });
    expect(mutated).toBe(true);
    // Invalid rules are retired without executing; the valid one ran.
    expect(st.automationFireCounts).toEqual({ "p1:r_ok": 1, "p1:r_injured": 1, "p1:r_sold": 1 });
    expect(st.automationLog?.map((e) => e.status)).toEqual(["APPLIED", "RETIRED", "RETIRED"]);
    // ...while the healthy rule performed exactly one substitution.
    expect(st.events.filter((event) => event.type === EVENT_CODES.SUB)).toHaveLength(1);
    expect(st.usedSubs[0]).toBe(1);
    expect(st.homeOn).toContain(st.events.find((event) => event.type === EVENT_CODES.SUB)!.player2Id!);
  });

  it("never refires discarded rules on later minutes", () => {
    const { world, club, st, presets } = setup();
    evaluateAutomationForMatch({ world, st, side: 0, club, presets, ctx: { minute: 60, newEventsThisMinute: [] } });
    const subsAfterFirst = st.events.filter((event) => event.type === EVENT_CODES.SUB).length;
    st.minute = 75;
    const second = evaluateAutomationForMatch({ world, st, side: 0, club, presets, ctx: { minute: 75, newEventsThisMinute: [] } });
    expect(second).toBe(false);
    expect(st.events.filter((event) => event.type === EVENT_CODES.SUB).length).toBe(subsAfterFirst);
  });
});
