import { describe, expect, it } from "vitest";
import baseline from "./fixtures/generation-golden.json";
import { createLiveMatchState, performLiveSub, simulateMatch, tickLiveMatch } from "../src/game/match";
import { createRng } from "../src/game/rng";
import { generateSeniorPlayer, type GeneratePlayerContext } from "../src/game/playerGeneration";
import type { Club, MatchEvent, Player, Position, Tactics, TeamMatchStats } from "../src/game/types";

type MatchBaseline = {
  instantNeutral: InstantDigest;
  instantTactics: InstantDigest;
  liveFull: LiveDigest;
};

type InstantDigest = {
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
  homeScore: number;
  awayScore: number;
  penaltyWinnerId: number | null;
  extraTime: boolean;
  events: MatchEvent[];
  stats: { home: TeamMatchStats; away: TeamMatchStats };
  minutes: Record<number, number>;
  postEnergy: Record<number, number>;
  rngState: number;
};

type LiveDigest = {
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
  homeOn: number[];
  awayOn: number[];
  scores: [number, number];
  ended: boolean;
  firstHalfAddedMinutes?: number;
  secondHalfAddedMinutes?: number;
  coinTossWinner?: 0 | 1;
  events: MatchEvent[];
  teamStats: { home: TeamMatchStats; away: TeamMatchStats };
  playerMinutes: Record<number, number>;
  playerEnergy: Record<number, number>;
  cards: unknown[];
  injuries: unknown[];
  substitutions: unknown[];
  rngState: number;
};

const fixture = baseline as unknown as { matches: MatchBaseline };

function context(overrides: Partial<GeneratePlayerContext> = {}): GeneratePlayerContext {
  return {
    id: 1,
    clubId: 10,
    country: "BRA",
    position: 3,
    isYouth: false,
    currentDivision: 1,
    highestDivisionReached: 1,
    totalDivisions: 5,
    seasonId: null,
    generationType: "initial-senior",
    seed: 42,
    slot: 0,
    ...overrides,
  };
}

function club(id: number, tactics: Tactics): Club {
  return {
    id,
    name: id === 1 ? "Golden Home" : "Golden Away",
    shortName: id === 1 ? "GH" : "GA",
    ownerUserId: null,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 1e8,
    stadiumName: "Ground",
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics,
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    savedLineup: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

const positions: Position[] = [0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 2, 3, 1, 4];

function squad(clubId: number, division: number, seed: number, offset: number): Player[] {
  return positions.map((position, slot) => generateSeniorPlayer(context({
    id: offset + slot + 1,
    clubId,
    position,
    currentDivision: division,
    highestDivisionReached: division,
    seed,
    slot,
  })));
}

function clone(players: Player[]): Player[] {
  return players.map((player) => ({
    ...player,
    skills: { ...player.skills },
    skillAcc: [...player.skillAcc],
    recentMinutes: [...player.recentMinutes],
    developmentProfile: { ...player.developmentProfile },
  }));
}

function energy(players: Player[]): Record<number, number> {
  return Object.fromEntries(players.map((player) => [player.id, player.energy]));
}

function tactics(style: number, pressing = 0): Tactics {
  return { formation: 4, style, pressing, direction: 0 };
}

function instantDigest(
  seed: number,
  fixtureId: number,
  home: Club,
  away: Club,
  players: Player[],
  homeNeutral: boolean,
  lineupPlayers: Player[] = players,
): InstantDigest {
  const lineup = createLiveMatchState(createRng(seed), home, away, clone(lineupPlayers), {
    matchId: fixtureId,
    competitionId: 1,
    fixtureId,
    year: 1,
    homeNeutral,
  });
  const rng = createRng(seed);
  const { match } = simulateMatch(rng, home, away, players, {
    competitionId: 1,
    fixtureId,
    year: 1,
    homeNeutral,
  });
  return {
    homeXI: lineup.homeXI,
    awayXI: lineup.awayXI,
    homeSubs: lineup.homeSubs,
    awaySubs: lineup.awaySubs,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    penaltyWinnerId: match.penaltyWinnerId,
    extraTime: match.extraTime ?? false,
    events: match.events,
    stats: match.stats,
    minutes: match.minutes ?? {},
    postEnergy: energy(players),
    rngState: rng.state,
  };
}

function liveDigest(home: Club, away: Club, players: Player[]): LiveDigest {
  const rng = createRng(777003);
  const state = createLiveMatchState(rng, home, away, players, {
    matchId: 700003,
    competitionId: 1,
    fixtureId: 700003,
    homeNeutral: true,
  });
  for (const chunk of [17, 23, 21]) tickLiveMatch(rng, home, away, players, state, chunk, { ignoreHalfTime: false });
  for (const chunk of [31, 12]) tickLiveMatch(rng, home, away, players, state, chunk, { resume: true, ignoreHalfTime: false });
  if (!state.ended && state.awaySubs.length > 0 && state.homeOn.length > 10) {
    performLiveSub(rng, home, away, players, state, 0, state.homeOn[state.homeOn.length - 1], state.homeSubs[0]);
  }
  while (!state.ended) {
    const before = state.matchClockSeconds;
    tickLiveMatch(rng, home, away, players, state, 10, { resume: true });
    if (state.matchClockSeconds === before) break;
  }
  return {
    homeXI: state.homeXI,
    awayXI: state.awayXI,
    homeSubs: state.homeSubs,
    awaySubs: state.awaySubs,
    homeOn: state.homeOn,
    awayOn: state.awayOn,
    scores: [...state.scores] as [number, number],
    ended: state.ended,
    firstHalfAddedMinutes: state.firstHalfAddedMinutes,
    secondHalfAddedMinutes: state.secondHalfAddedMinutes,
    coinTossWinner: state.coinTossWinner,
    events: state.events,
    teamStats: state.teamStats,
    playerMinutes: state.playerMinutes,
    playerEnergy: state.playerEnergy,
    cards: state.cards,
    injuries: state.injuries,
    substitutions: state.substitutions,
    rngState: state.rngState.state,
  };
}

describe("match neutrality", () => {
  it("replays fixed-seed instant matches exactly", () => {
    const homeSquad = squad(1, 1, 31111, 1000);
    const awaySquad = squad(2, 4, 32222, 2000);
    const neutralPlayers = clone([...homeSquad, ...awaySquad]);
    expect(instantDigest(777001, 700001, club(1, tactics(0)), club(2, tactics(0)), neutralPlayers, true))
      .toEqual(fixture.matches.instantNeutral);

    const tacticalPlayers = clone([...homeSquad, ...awaySquad]);
    for (const player of tacticalPlayers) player.energy = 71;
    expect(instantDigest(777002, 700002, club(1, tactics(1)), club(2, tactics(2)), tacticalPlayers, false, [...homeSquad, ...awaySquad]))
      .toEqual(fixture.matches.instantTactics);
  });

  it("replays the fixed-seed live match, including state, events, fatigue, and RNG", () => {
    const home = club(1, tactics(0));
    const away = club(2, tactics(2));
    const players = clone([
      ...squad(1, 1, 31111, 1000),
      ...squad(2, 4, 32222, 2000),
    ]);
    expect(liveDigest(home, away, players)).toEqual(fixture.matches.liveFull);
  });
});
