import { describe, expect, it } from "vitest";
import { evaluateAutomationForMatch, processAutomation } from "../src/game/automation";
import { advanceLiveMatches } from "../src/game/world";
import { createHumanClub, generateWorld } from "../src/game/worldgen";
import { EVENT_CODES, AUTOMATION_REASON } from "../src/game/constants";
import { MATCH_SIMULATOR_CONFIG as MS } from "../src/matchSimulatorConfig";
import type { AutomationPreset, Club, LiveMatchState, Player, World } from "../src/game/types";

let clubIdCounter = 700;

/** A minimally-sufficient LiveMatchState for exercising automation in
 *  isolation — mirrors the manual-construction style of injuryAutoSub.test.ts,
 *  providing exactly the fields the code under test reads. */
function baseState(overrides: Partial<LiveMatchState> = {}): LiveMatchState {
  return {
    matchId: 1,
    fixtureId: 1,
    competitionId: 1,
    homeClubId: 0,
    awayClubId: 0,
    ended: false,
    period: 1,
    extraTimePlayed: false,
    matchClockSeconds: 600,
    firstHalfAddedMinutes: 0,
    secondHalfAddedMinutes: 0,
    minute: 20,
    half: 0,
    scores: [0, 0],
    events: [],
    substitutions: [],
    usedSubs: [0, 0],
    subbedIn: [[], []],
    homeOn: [],
    awayOn: [],
    homeSubs: [],
    awaySubs: [],
    homeTactics: { formation: 4, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
    awayTactics: { formation: 4, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
    controlledBallSeconds: [0, 0],
    playerEnergy: {},
    playerYellows: {},
    playerPreMatchLoad: {},
    playerMatchLoad: {},
    playerMinutes: {},
    automationFiredRuleIds: [],
    automationFireCounts: {},
    automationLog: [],
    ...overrides,
  } as unknown as LiveMatchState;
}

function setupWorld(): { world: World; home: Club; away: Club } {
  const world = generateWorld(2026);
  const home = createHumanClub(world, { userId: clubIdCounter++, clubName: `Auto FC ${clubIdCounter}`, country: "BRA", preferredHours: null });
  const away = createHumanClub(world, { userId: clubIdCounter++, clubName: `Auto Opp ${clubIdCounter}`, country: "GER", preferredHours: null });
  // tacticsForClub assigns a random starting formation; pin it to 4 so every
  // preset() in this file (which arms against formationId: 4) actually arms.
  home.tactics.formation = 4;
  away.tactics.formation = 4;
  return { world, home, away };
}

function preset(rules: AutomationPreset["rules"], formationId = 4): AutomationPreset {
  return { id: "p1", name: "Test", formationId, enabled: true, rules };
}

describe("automation firing — triggers", () => {
  it("MINUTE fires only on the exact minute", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, minute: 59 });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 60 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 59, newEventsThisMinute: [] } })).toBe(false);
    st.minute = 60;
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 60, newEventsThisMinute: [] } })).toBe(true);
  });

  it("GOAL_SCORED / GOAL_CONCEDED distinguish which side scored", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id });
    const scoredEvent = { minute: 20, half: 0, type: EVENT_CODES.GOAL, subtype: 1, clubId: home.id, playerId: null, player2Id: null, goalType: 1 };
    const concededEvent = { minute: 20, half: 0, type: EVENT_CODES.GOAL, subtype: 1, clubId: away.id, playerId: null, player2Id: null, goalType: 1 };
    const scoredPresets = [preset([{ id: "r1", trigger: { kind: "GOAL_SCORED" }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets: scoredPresets, ctx: { minute: 20, newEventsThisMinute: [concededEvent] } })).toBe(false);
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets: scoredPresets, ctx: { minute: 20, newEventsThisMinute: [scoredEvent] } })).toBe(true);
  });

  it("RED_CARD, YELLOW_CARD, OPPONENT_RED_CARD and PLAYER_INJURED all read the event batch's clubId", () => {
    const { world, home, away } = setupWorld();
    const mk = (type: number, clubId: number) => ({ minute: 20, half: 0, type, subtype: 0, clubId, playerId: null, player2Id: null, goalType: 0 });
    const cases: [string, ReturnType<typeof mk>][] = [
      ["RED_CARD", mk(EVENT_CODES.RED, home.id)],
      ["YELLOW_CARD", mk(EVENT_CODES.YELLOW, home.id)],
      ["OPPONENT_RED_CARD", mk(EVENT_CODES.RED, away.id)],
      ["PLAYER_INJURED", mk(EVENT_CODES.INJURY, home.id)],
      ["MISSED_PENALTY", mk(EVENT_CODES.MISSED_PENALTY, home.id)],
    ];
    for (const [kind, event] of cases) {
      const presets = [preset([{ id: "r1", trigger: { kind: kind as never }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
      const fresh = baseState({ homeClubId: home.id, awayClubId: away.id });
      expect(evaluateAutomationForMatch({ world, st: fresh, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [event] } })).toBe(true);
    }
  });

  it("HALF_TIME evaluates true whenever isHalftime(st) holds, including through the human wall-clock pause (advanceLiveMatches)", () => {
    const { world, home, away } = setupWorld();
    home.tactics.formation = 4;
    const st = baseState({
      homeClubId: home.id,
      awayClubId: away.id,
      period: 1,
      matchClockSeconds: MS.timing.firstHalfEndSeconds,
      homeTactics: { formation: 4, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
    });
    world.liveMatches = [st];
    const presets = new Map<number, AutomationPreset[]>([
      [home.id, [preset([{ id: "r1", trigger: { kind: "HALF_TIME" }, conditions: [], actions: [{ kind: "TACTICS", formation: 7 }] }])]],
    ]);
    // Regression: this branch used to `continue` before automation ever ran,
    // so a HALF_TIME formation-change rule could never actually apply for a
    // human-involving match paused at half-time (game/world.ts).
    advanceLiveMatches(world, Date.now(), { automationPresets: presets });
    expect(st.homeTactics.formation).toBe(7);
    expect(st.automationLog?.some((e) => e.status === "APPLIED")).toBe(true);
  });
});

describe("automation firing — conditions (ANDed)", () => {
  it("requires every listed condition to hold", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, scores: [1, 0], usedSubs: [0, 0] });
    const presets = [
      preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["WINNING", "HAS_SUBS_LEFT"], actions: [{ kind: "STOP_AUTOMATION" }] }]),
    ];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);

    const st2 = baseState({ homeClubId: home.id, awayClubId: away.id, scores: [1, 0], usedSubs: [5, 0] });
    expect(evaluateAutomationForMatch({ world, st: st2, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
  });

  it("A_MAN_DOWN / A_MAN_UP compare on-pitch counts between sides", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], awayOn: [3, 4, 5] });
    const down = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["A_MAN_DOWN"], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    const up = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["A_MAN_UP"], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets: down, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    const st2 = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], awayOn: [3, 4, 5] });
    expect(evaluateAutomationForMatch({ world, st: st2, side: 0, club: home, presets: up, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
  });

  it("TIRED_PLAYER_ON_PITCH and BOOKED_PLAYER_ON_PITCH read per-player maps for this side only", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [11], awayOn: [], playerEnergy: { 11: 40 } });
    const tired = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["TIRED_PLAYER_ON_PITCH"], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets: tired, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(evaluateAutomationForMatch({ world, st, side: 1, club: away, presets: tired, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);

    const st2 = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [12], playerYellows: { 12: 1 } });
    const booked = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["BOOKED_PLAYER_ON_PITCH"], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st: st2, side: 0, club: home, presets: booked, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
  });

  it("LOSING_POSSESSION compares this side's controlled-ball share to the threshold", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, controlledBallSeconds: [100, 400] });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: ["LOSING_POSSESSION"], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(evaluateAutomationForMatch({ world, st, side: 1, club: away, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
    // No possession recorded yet: never matches (avoids a 0/0 false positive).
    const fresh = baseState({ homeClubId: home.id, awayClubId: away.id, controlledBallSeconds: [0, 0] });
    expect(evaluateAutomationForMatch({ world, st: fresh, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
  });
});

describe("automation firing — minute-window guards", () => {
  it("fromMinute/toMinute bound a non-MINUTE trigger", () => {
    const { world, home, away } = setupWorld();
    const presets = [preset([{ id: "r1", trigger: { kind: "GOAL_CONCEDED" }, conditions: [], fromMinute: 60, toMinute: 75, actions: [{ kind: "STOP_AUTOMATION" }] }])];
    const event = { minute: 30, half: 0, type: EVENT_CODES.GOAL, subtype: 1, clubId: away.id, playerId: null, player2Id: null, goalType: 1 };
    const early = baseState({ homeClubId: home.id, awayClubId: away.id, minute: 30 });
    expect(evaluateAutomationForMatch({ world, st: early, side: 0, club: home, presets, ctx: { minute: 30, newEventsThisMinute: [event] } })).toBe(false);
    const inWindow = baseState({ homeClubId: home.id, awayClubId: away.id, minute: 65 });
    expect(evaluateAutomationForMatch({ world, st: inWindow, side: 0, club: home, presets, ctx: { minute: 65, newEventsThisMinute: [event] } })).toBe(true);
    const late = baseState({ homeClubId: home.id, awayClubId: away.id, minute: 80 });
    expect(evaluateAutomationForMatch({ world, st: late, side: 0, club: home, presets, ctx: { minute: 80, newEventsThisMinute: [event] } })).toBe(false);
  });
});

describe("automation firing — maxFires", () => {
  it("a rule may apply more than once when maxFires says so, then retires", () => {
    const { world, home, away } = setupWorld();
    const presets = [preset([{ id: "r1", trigger: { kind: "GOAL_CONCEDED" }, conditions: [], maxFires: 2, actions: [{ kind: "STOP_AUTOMATION" }] }])];
    const st = baseState({ homeClubId: home.id, awayClubId: away.id });
    const event = { minute: 20, half: 0, type: EVENT_CODES.GOAL, subtype: 1, clubId: away.id, playerId: null, player2Id: null, goalType: 1 };
    // STOP_AUTOMATION disables the side after the first application, so re-arm
    // it between attempts to isolate the maxFires bookkeeping under test.
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [event] } })).toBe(true);
    expect(st.automationFireCounts?.["p1:r1"]).toBe(1);
    st.automationDisabled = [false, false];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 30, newEventsThisMinute: [event] } })).toBe(true);
    expect(st.automationFireCounts?.["p1:r1"]).toBe(2);
    st.automationDisabled = [false, false];
    // Third attempt: maxFires reached, silently retired (no log growth).
    const before = st.automationLog?.length ?? 0;
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 40, newEventsThisMinute: [event] } })).toBe(false);
    expect(st.automationLog?.length ?? 0).toBe(before);
  });
});

describe("automation firing — TACTICS cooldown retries instead of burning the rule", () => {
  it("a cooldown-rejected TACTICS rule stays eligible and can apply once the cooldown lifts", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({
      homeClubId: home.id,
      awayClubId: away.id,
      minute: 5,
      tacticsChangedAtMinute: [5, null],
    });
    const presets = [preset([{ id: "r1", trigger: { kind: "GOAL_CONCEDED" }, conditions: [], actions: [{ kind: "TACTICS", pressing: 2 }] }])];
    const event = { minute: 8, half: 0, type: EVENT_CODES.GOAL, subtype: 1, clubId: away.id, playerId: null, player2Id: null, goalType: 1 };
    // Still inside the cooldown window (default 10 match-minutes): skipped, not retired.
    st.minute = 8;
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 8, newEventsThisMinute: [event] } });
    expect(st.automationLog?.at(-1)).toMatchObject({ status: "SKIPPED", reason: AUTOMATION_REASON.TACTICS_COOLDOWN });
    expect(st.automationFireCounts?.["p1:r1"] ?? 0).toBe(0);
    // Cooldown has lifted: the SAME rule now applies.
    st.minute = 20;
    const applied = evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [event] } });
    expect(applied).toBe(true);
    expect(st.automationLog?.at(-1)?.status).toBe("APPLIED");
    expect(st.homeTactics.pressing).not.toBe(0.5);
  });
});

describe("automation firing — dynamic SUB selectors are deterministic", () => {
  function squadState(home: Club, away: Club) {
    return baseState({
      homeClubId: home.id,
      awayClubId: away.id,
      homeOn: [9010101, 9010102, 9010103],
      homeSubs: [9010201, 9010202],
      homeSlotByPlayerId: { 9010101: 0, 9010102: 1, 9010103: 2 },
      homeTactics: { formation: 0, style: "CONTROL", pressing: 0.5, direction: "CENTRE", familiarity: 50 },
      playerEnergy: { 9010101: 90, 9010102: 40, 9010103: 70, 9010201: 80, 9010202: 60 },
      playerYellows: { 9010102: 1 },
    });
  }

  function makePlayers(clubId: number) {
    // Minimal Player-shaped stubs; only fields the resolvers/pickInjuryReplacement read are populated.
    const mk = (id: number, position: string) => ({
      id,
      clubId,
      position,
      overall: 60,
      energy: 70,
      injuryDays: 0,
      suspendedGames: 0,
      onSale: false,
      skills: { gol: 10, pace: 60, tec: 60, pas: 60, des: 60, playmaking: 60, fin: 60 },
    });
    return [mk(9010101, "CB"), mk(9010102, "DM"), mk(9010103, "ST"), mk(9010201, "DM"), mk(9010202, "ST")];
  }

  it("MOST_TIRED picks the lowest-energy outfielder, excluding the goalkeeper, with a lower-id tie-break", () => {
    const { world, home, away } = setupWorld();
    world.players.push(...(makePlayers(home.id) as unknown as Player[]));
    const st = squadState(home, away);
    const presets = [
      preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SUB", outSelect: "MOST_TIRED", inSelect: "BEST_FOR_ROLE" }] }]),
    ];
    const res1 = evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(res1).toBe(true);
    const subEvent = st.events.find((e) => e.type === EVENT_CODES.SUB);
    expect(subEvent?.playerId).toBe(9010102); // lowest energy (40) among outfielders
    // Repeating the same evaluation from a fresh, identically-shaped state
    // must resolve to the same candidate (determinism across retries/restarts).
    const st2 = squadState(home, away);
    const presets2 = [
      preset([{ id: "r2", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SUB", outSelect: "MOST_TIRED", inSelect: "BEST_FOR_ROLE" }] }]),
    ];
    evaluateAutomationForMatch({ world, st: st2, side: 0, club: home, presets: presets2, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(st2.events.find((e) => e.type === EVENT_CODES.SUB)?.playerId).toBe(9010102);
  });

  it("BOOKED prefers a carded outfielder over a merely tired one", () => {
    const { world, home, away } = setupWorld();
    world.players.push(...(makePlayers(home.id) as unknown as Player[]));
    const st = squadState(home, away);
    const presets = [
      preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SUB", outSelect: "BOOKED", inSelect: "BEST_FOR_ROLE" }] }]),
    ];
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(st.events.find((e) => e.type === EVENT_CODES.SUB)?.playerId).toBe(9010102); // the only booked player
  });

  it("SLOT resolves the player currently deployed at that formation slot", () => {
    const { world, home, away } = setupWorld();
    world.players.push(...(makePlayers(home.id) as unknown as Player[]));
    const st = squadState(home, away);
    const presets = [
      preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SUB", outSelect: "SLOT", outSlotIndex: 2, inSelect: "PLAYER", inPlayerId: 9010202 }] }]),
    ];
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    const subEvent = st.events.find((e) => e.type === EVENT_CODES.SUB);
    expect(subEvent?.playerId).toBe(9010103); // slot 2
    expect(subEvent?.player2Id).toBe(9010202);
  });

  it("no eligible candidate logs SKIPPED/NO_CANDIDATE and never throws", () => {
    const { world, home, away } = setupWorld();
    world.players.push(...(makePlayers(home.id) as unknown as Player[]));
    const st = squadState(home, away);
    st.homeSubs = []; // nobody left on the bench
    const presets = [
      preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SUB", outSelect: "MOST_TIRED", inSelect: "BEST_FOR_ROLE" }] }]),
    ];
    const result = evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(result).toBe(true); // the log entry itself is a persist-worthy change
    expect(st.automationLog?.at(-1)).toMatchObject({ status: "SKIPPED", reason: AUTOMATION_REASON.NO_CANDIDATE });
    expect(st.events.some((e) => e.type === EVENT_CODES.SUB)).toBe(false);
  });
});

describe("automation firing — SWAP_SLOTS, SET_TAKER, STOP_AUTOMATION, HALFTIME_READY", () => {
  it("SWAP_SLOTS exchanges two on-pitch players' deployed slots", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], homeSlotByPlayerId: { 1: 0, 2: 1 } });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(st.homeSlotByPlayerId).toEqual({ 1: 1, 2: 0 });
  });

  it("SET_TAKER only applies live-match-local state, never Club.penaltyTakerId", () => {
    const { world, home, away } = setupWorld();
    const originalTakerId = home.penaltyTakerId;
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2] });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SET_TAKER", takerPlayerId: 2 }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(st.livePenaltyTakerId).toEqual([2, null]);
    expect(home.penaltyTakerId).toBe(originalTakerId); // unchanged — §11's TACTICS guarantee, extended to takers
  });

  it("STOP_AUTOMATION disables the rest of this side's rules for the match", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(st.automationDisabled?.[0]).toBe(true);
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 25, newEventsThisMinute: [] } })).toBe(false);
  });

  it("HALFTIME_READY marks this side ready without waiting for the manager to click through", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, period: 1, matchClockSeconds: MS.timing.firstHalfEndSeconds, halftimeReady: [false, false] });
    const presets = [preset([{ id: "r1", trigger: { kind: "HALF_TIME" }, conditions: [], actions: [{ kind: "HALFTIME_READY" }] }])];
    processAutomation(world, st, [], new Map([[home.id, presets]]));
    expect(st.halftimeReady?.[0]).toBe(true);
  });
});

describe("automation firing — pausing/disabling a side", () => {
  it("automationDisabled[side] short-circuits evaluation entirely", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, automationDisabled: [true, false] });
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
    expect(st.automationLog?.length ?? 0).toBe(0);
  });

  it("no presets or a non-human club never evaluates", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id });
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets: [], ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
    const aiClub = { ...home, isHuman: false };
    const presets = [preset([{ id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] }])];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: aiClub, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(false);
  });
});

describe("automation firing — a rule may queue more than one action", () => {
  it("runs every action in order, each with its own log entry (actionIndex)", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], homeSlotByPlayerId: { 1: 0, 2: 1 } });
    const presets = [
      preset([
        {
          id: "r1",
          trigger: { kind: "MINUTE", minute: 20 },
          conditions: [],
          actions: [{ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }, { kind: "SET_TAKER", takerPlayerId: 1 }],
        },
      ]),
    ];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(st.homeSlotByPlayerId).toEqual({ 1: 1, 2: 0 });
    expect(st.livePenaltyTakerId).toEqual([1, null]);
    expect(st.automationLog?.map((e) => ({ actionIndex: e.actionIndex, status: e.status }))).toEqual([
      { actionIndex: 0, status: "APPLIED" },
      { actionIndex: 1, status: "APPLIED" },
    ]);
    // Both actions are attributed to the same rule and consume exactly one fire.
    expect(st.automationFireCounts?.["p1:r1"]).toBe(1);
  });

  it("one action failing does not stop the others from applying, and the rule still fires", () => {
    const { world, home, away } = setupWorld();
    // SET_TAKER names a player who isn't on the pitch (fails); SWAP_SLOTS is valid.
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], homeSlotByPlayerId: { 1: 0, 2: 1 } });
    const presets = [
      preset([
        {
          id: "r1",
          trigger: { kind: "MINUTE", minute: 20 },
          conditions: [],
          actions: [{ kind: "SET_TAKER", takerPlayerId: 999 }, { kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }],
        },
      ]),
    ];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true);
    expect(st.homeSlotByPlayerId).toEqual({ 1: 1, 2: 0 });
    expect(st.automationLog?.map((e) => ({ actionIndex: e.actionIndex, status: e.status }))).toEqual([
      { actionIndex: 0, status: "SKIPPED" },
      { actionIndex: 1, status: "APPLIED" },
    ]);
    expect(st.automationFireCounts?.["p1:r1"]).toBe(1);
  });

  it("all actions failing leaves the rule eligible to retry (no fire consumed)", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1] });
    const presets = [
      preset([
        { id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SET_TAKER", takerPlayerId: 999 }] },
      ]),
    ];
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } })).toBe(true); // the log entry itself persists
    expect(st.automationFireCounts?.["p1:r1"] ?? 0).toBe(0);
    st.minute = 21;
    expect(evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 21, newEventsThisMinute: [] } })).toBe(false); // MINUTE trigger doesn't match 21, but proves it wasn't retired
  });

  it("STOP_AUTOMATION short-circuits any actions queued after it in the same rule", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], homeSlotByPlayerId: { 1: 0, 2: 1 } });
    const presets = [
      preset([
        {
          id: "r1",
          trigger: { kind: "MINUTE", minute: 20 },
          conditions: [],
          actions: [{ kind: "STOP_AUTOMATION" }, { kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }],
        },
      ]),
    ];
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(st.automationDisabled?.[0]).toBe(true);
    // The SWAP_SLOTS action queued after STOP_AUTOMATION never ran.
    expect(st.homeSlotByPlayerId).toEqual({ 1: 0, 2: 1 });
    expect(st.automationLog?.map((e) => e.actionIndex)).toEqual([0]);
  });

  it("STOP_AUTOMATION also stops any later rule in the same evaluation pass", () => {
    const { world, home, away } = setupWorld();
    const st = baseState({ homeClubId: home.id, awayClubId: away.id, homeOn: [1, 2], homeSlotByPlayerId: { 1: 0, 2: 1 } });
    const presets = [
      preset([
        { id: "r1", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "STOP_AUTOMATION" }] },
        { id: "r2", trigger: { kind: "MINUTE", minute: 20 }, conditions: [], actions: [{ kind: "SWAP_SLOTS", swapPlayerAId: 1, swapPlayerBId: 2 }] },
      ]),
    ];
    evaluateAutomationForMatch({ world, st, side: 0, club: home, presets, ctx: { minute: 20, newEventsThisMinute: [] } });
    expect(st.homeSlotByPlayerId).toEqual({ 1: 0, 2: 1 }); // r2 never evaluated
    expect(st.automationLog?.map((e) => e.ruleId)).toEqual(["r1"]);
  });
});
