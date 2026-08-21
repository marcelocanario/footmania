import { createRng } from "../src/game/rng";
import { MP_CONFIG } from "../src/config";
import type { Club, Competition, Player, World } from "../src/game/types";

/**
 * Seed the minimum number of played league fixtures for every club so tests
 * that exercise outbound markets are past the new-club sell lock by default.
 * Sell-lock tests reset this via `{ competitions: [], fixtures: [] }` overrides.
 */
function seedPlayedMatches(world: World): void {
  const division: Competition = {
    id: 900_001,
    kind: "division",
    name: "1",
    round: 0,
    stage: "group",
    seasonId: world.mp.seasonId,
    tier: 1,
    groupIndex: 0,
    status: "ACTIVE",
    config: { clubs: [], turns: 2, groups: [], bracket: [], promoted: 2, relegated: 2, groupQualifiers: 0 },
    standings: {},
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  world.competitions.push(division);
  let fixtureId = 800_000;
  for (const club of world.clubs) {
    for (let round = 0; round < MP_CONFIG.newClubSellLockMatches; round++) {
      world.fixtures.push({
        id: fixtureId++,
        competitionId: division.id,
        round,
        homeClubId: club.id,
        awayClubId: -club.id,
        dayIndex: round,
        played: true,
      });
    }
  }
}

export function makeClub(overrides: Partial<Club> = {}): Club {
  return {
    id: 1,
    name: "Test FC",
    shortName: "TFC",
    ownerUserId: 1,
    timezone: null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 100_000_000,
    stadiumName: "St",
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}

export function makeWorld(clubs: Club[], players: Player[], overrides: Partial<World> = {}): World {
  const world: World = {
    seed: 1,
    year: 2026,
    dayIndex: 0,
    dayOfWeek: 0,
    nextId: 1000,
    clubs,
    players,
    competitions: [],
    fixtures: [],
    matches: [],
    news: [],
    loans: [],
    marketBids: [],
    transferAuctions: [],
    freeAgentListings: [],
    marketReservations: [],
    playerMarketHistory: [],
    seasonAwards: [],
    records: [],
    humanClubId: null,
    seasonSummary: null,
    rng: createRng(42),
    financialInterventions: [],
    mp: {
      seasonId: 1,
      seasonYear: 2026,
      seasonMonth: 1,
      seasonStatus: "ACTIVE",
      completedRounds: 0,
      joinLockRound: 7,
      joinState: "OPEN",
      joinThresholdPercent: 0.5,
      inactivityThresholds: { 1: 42, 2: 35, default: 28 },
      matchTimeMode: "GLOBAL_FIXED_KICKOFF",
      matchKickoffHour: 20,
      lastProcessedGameDay: 0,
      lastDailyTickDay: 0,
      lastDailyTickDate: null,
      manualRound: null,
      rolloverPhase: null,
    },
    mpQueue: [],
    liveMatches: [],
    seasonAllocations: [],
    mpMemberships: [],
    mpClubSeasons: [],
    mpActivities: [],
    mpAudits: [],
    seasonHistory: [],
    generationEvents: [],
  };
  seedPlayedMatches(world);
  return Object.assign(world, overrides);
}
