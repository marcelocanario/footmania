import { describe, it, expect } from "vitest";
import { simulateMatch, createLiveMatchState, tickLiveMatch } from "../src/game/match";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import type { RngState } from "../src/game/rng";
import { EVENT_CODES, GOAL_SUBTYPES } from "../src/game/constants";
import type { Club, MatchEvent, Player, Position } from "../src/game/types";

let clubIdCounter = 1;
function makeClub(overrides: Partial<Club> = {}): Club {
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
    ...overrides,
  };
}

function makeSquad(rng: RngState, club: Club, count: number, offset = 0): Player[] {
  const balanced: Position[] = [
    0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4,
  ];
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generatePlayer(rng, club, { id: offset + i + 1, position: balanced[i % balanced.length] }));
  }
  return players;
}

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

function countByType(events: MatchEvent[], type: number, clubId?: number): number {
  return events.filter((e) => e.type === type && (clubId === undefined || e.clubId === clubId)).length;
}

describe("match timeline boundary events", () => {
  it("emits exactly one half-time, second-half and full-time whistle per completed match", () => {
    const rng = createRng(9100);
    const home = makeClub();
    const away = makeClub();
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      const matchRng = createRng(9100 * 100 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
      const events = match.events;

      expect(countByType(events, EVENT_CODES.HALF_TIME)).toBe(1);
      expect(countByType(events, EVENT_CODES.SECOND_HALF_START)).toBe(1);
      expect(countByType(events, EVENT_CODES.FULL_TIME)).toBe(1);

      const ht = events.find((e) => e.type === EVENT_CODES.HALF_TIME)!;
      expect(ht.minute).toBe(45);
      // Added time is always ≥ 1 configured minute, so the stamp must be present.
      expect(ht.addedTime).toBeGreaterThan(0);

      const second = events.find((e) => e.type === EVENT_CODES.SECOND_HALF_START)!;
      expect(second.minute).toBe(46);
      expect(second.half).toBe(2);

      const ft = events.find((e) => e.type === EVENT_CODES.FULL_TIME)!;
      expect(ft.minute).toBe(90);
      expect(ft.addedTime).toBeGreaterThan(0);
      // Full time is the last recorded moment of the match.
      expect(events.indexOf(ft)).toBe(events.length - 1);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("reconciles curated event counts with team stat counters", () => {
    const rng = createRng(9200);
    const home = makeClub();
    const away = makeClub();
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    let sawCorners = false;
    let sawSavesOrWoodwork = false;
    for (let i = 0; i < 8; i++) {
      const matchRng = createRng(9200 * 100 + i);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: i, year: 1 });
      const inPlay = match.events.filter((e) => e.minute < 100);
      for (const [side, clubId] of [["home", home.id], ["away", away.id]] as const) {
        const stats = match.stats[side];
        const squadIds = new Set(players.filter((p) => p.clubId === clubId).map((p) => p.id));
        expect(countByType(inPlay, EVENT_CODES.CORNER, clubId)).toBe(stats.corners);
        // Corners name a taker from the attacking club's outfield squad.
        for (const corner of inPlay.filter((e) => e.type === EVENT_CODES.CORNER && e.clubId === clubId)) {
          expect(corner.playerId).not.toBeNull();
          expect(squadIds.has(corner.playerId!)).toBe(true);
        }
        // On target = goals + on-target woodwork (attacking side) + saves
        // recorded against the defending side's goalkeeper.
        const oppClubId = side === "home" ? away.id : home.id;
        const oppSquadIds = new Set(players.filter((p) => p.clubId === oppClubId).map((p) => p.id));
        const onTargetWoodwork = inPlay.filter((e) => e.type === EVENT_CODES.WOODWORK && e.clubId === clubId && e.subtype === 1).length;
        expect(
          countByType(inPlay, EVENT_CODES.GOAL, clubId) +
          onTargetWoodwork +
          countByType(inPlay, EVENT_CODES.SAVE, oppClubId),
        ).toBe(stats.shotsOnTarget);
        // A save names the defending goalkeeper plus the shooter.
        for (const save of inPlay.filter((e) => e.type === EVENT_CODES.SAVE)) {
          if (save.clubId !== clubId) continue;
          expect(save.playerId).not.toBeNull();
          expect(squadIds.has(save.playerId!)).toBe(true);
          expect(save.player2Id).not.toBeNull();
          expect(oppSquadIds.has(save.player2Id!)).toBe(true);
        }
        if (stats.corners > 0) sawCorners = true;
        if (stats.shotsOnTarget > countByType(inPlay, EVENT_CODES.GOAL, clubId)) sawSavesOrWoodwork = true;
      }
    }
    expect(sawCorners).toBe(true);
    expect(sawSavesOrWoodwork).toBe(true);
  });

  it("streams the same boundaries through paused live ticks exactly once", () => {
    const rng = createRng(9300);
    const home = makeClub();
    const away = makeClub();
    const players = [...makeSquad(rng, home, 30), ...makeSquad(rng, away, 30, 30)];
    const state = createLiveMatchState(createRng(931), home, away, cloneSquad(players), {
      matchId: 1, competitionId: 1, fixtureId: 1, year: 1, homeNeutral: true,
    });
    for (const chunk of [17, 23, 21]) tickLiveMatch(createRng(931), home, away, cloneSquad(players), state, chunk, { ignoreHalfTime: false });
    for (const chunk of [31, 12]) tickLiveMatch(createRng(931), home, away, cloneSquad(players), state, chunk, { resume: true, ignoreHalfTime: false });
    while (!state.ended) {
      const before = state.matchClockSeconds;
      tickLiveMatch(createRng(931), home, away, cloneSquad(players), state, 10, { resume: true });
      if (state.matchClockSeconds === before) break;
    }

    expect(state.ended).toBe(true);
    expect(countByType(state.events, EVENT_CODES.HALF_TIME)).toBe(1);
    expect(countByType(state.events, EVENT_CODES.SECOND_HALF_START)).toBe(1);
    expect(countByType(state.events, EVENT_CODES.FULL_TIME)).toBe(1);
    const ht = state.events.find((e) => e.type === EVENT_CODES.HALF_TIME)!;
    expect(ht.addedTime).toBe(state.firstHalfAddedMinutes);
    const ft = state.events.find((e) => e.type === EVENT_CODES.FULL_TIME)!;
    expect(ft.addedTime).toBe(state.secondHalfAddedMinutes);

    // Idempotence: ticking a finished match adds nothing.
    const lengthBefore = state.events.length;
    tickLiveMatch(createRng(931), home, away, cloneSquad(players), state, 10, { resume: true });
    expect(state.events.length).toBe(lengthBefore);
  });

  it("announces a shootout once before the kicks on drawn deciders, with full time last", () => {
    const rng = createRng(9400);
    const home = makeClub();
    const away = makeClub();
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    let found = false;
    for (let seed = 1; seed <= 400 && !found; seed++) {
      const matchRng = createRng(940000 + seed);
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      const { match } = simulateMatch(matchRng, home, away, players, { competitionId: 1, fixtureId: seed, year: 1, decider: true });
      if (match.penaltyWinnerId == null) continue;
      found = true;

      expect(countByType(match.events, EVENT_CODES.SHOOTOUT)).toBe(1);
      const announcement = match.events.findIndex((e) => e.type === EVENT_CODES.SHOOTOUT);
      const firstKick = match.events.findIndex((e) => e.minute >= 120 && (e.type === EVENT_CODES.GOAL || e.type === EVENT_CODES.MISSED_PENALTY));
      expect(firstKick).toBeGreaterThan(-1);
      expect(announcement).toBeLessThan(firstKick);
      const ft = match.events.find((e) => e.type === EVENT_CODES.FULL_TIME)!;
      expect(match.events.indexOf(ft)).toBe(match.events.length - 1);
    }
    expect(found).toBe(true);
  });

  it("is deterministic: the same seed reproduces the identical timeline", () => {
    const rng = createRng(9500);
    const home = makeClub();
    const away = makeClub();
    const homeSquad = makeSquad(rng, home, 30);
    const awaySquad = makeSquad(rng, away, 30, 30);
    const run = () => {
      const players = [...cloneSquad(homeSquad), ...cloneSquad(awaySquad)];
      return simulateMatch(createRng(9555), home, away, players, { competitionId: 1, fixtureId: 1, year: 1 }).match.events;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(countByType(a, EVENT_CODES.HALF_TIME)).toBe(1);
  });
});
