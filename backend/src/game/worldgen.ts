import type { Club, Player, World } from "../game/types";
import { createRng } from "../game/rng";
import { nextInt } from "../game/rng";
import { generatePlayer } from "../game/player";
import { tacticsForClub, divisionTicketTier } from "../game/club";
import { STARTING_CASH, TICKET_PRICES } from "../game/constants";
import { generateName } from "../game/names";
import { MP_CONFIG } from "../config";

/**
 * World generation for the multiplayer game. The world is a single shared
 * object persisted in one global Save row; the pyramid is built by the
 * multiplayer engine (see game/multiplayer.ts) rather than here.
 */
export function generateWorld(seed: number): World {
  const rng = createRng(seed);
  return {
    seed,
    year: 1,
    dayIndex: 0,
    dayOfWeek: 0,
    nextId: 1,
    clubs: [],
    players: [],
    competitions: [],
    fixtures: [],
    matches: [],
    news: [{ dayIndex: 0, text: "Welcome to Footmania! A new season is about to begin.", kind: "season" }],
    loans: [],
    marketBids: [],
    transferAuctions: [],
    freeAgentListings: [],
    marketReservations: [],
    playerMarketHistory: [],
    aiEvaluations: [],
    seasonAwards: [],
    records: [],
    managerHistory: [],
    ticketPrices: {},
    stadiumUpgrades: [],
    humanClubId: null,
    seasonSummary: null,
    rng,
    contractWarnings: [],
    mp: {
      seasonId: 0,
      seasonYear: 1,
      seasonMonth: 1,
      seasonStatus: "PREPARATION",
      completedRounds: 0,
      joinLockRound: Math.floor(MP_CONFIG.joinThresholdPercent * 14),
      joinState: "OPEN",
      joinThresholdPercent: MP_CONFIG.joinThresholdPercent,
      inactivityThresholds: { ...MP_CONFIG.inactivityThresholds },
      matchTimeMode: MP_CONFIG.matchTimeMode,
      matchKickoffHour: MP_CONFIG.matchKickoffHourUtc,
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
  };
}

export interface HumanClubOptions {
  userId: number;
  clubName: string;
  country: string;
  timezone: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  stadiumName?: string;
}

/**
 * Creates a brand-new persistent human club. The club is independent of any
 * AI slot it may later replace (plan §8): identity, roster, finances and
 * facilities all belong to the human club record.
 */
export function createHumanClub(world: World, opts: HumanClubOptions): Club {
  const rng = world.rng;
  const id = world.nextId++;
  const name = opts.clubName.trim();
  const stadiumName = opts.stadiumName?.trim() || `${name} Stadium`;
  const club: Club = {
    id,
    name,
    shortName: name,
    ownerUserId: opts.userId,
    timezone: opts.timezone,
    competitionState: "NEW",
    lastMeaningfulActivityAt: Date.now(),
    abandonmentEligibleAt: null,
    inactivityWarningStage: 0,
    liveMatchAt: null,
    country: opts.country,
    // A fresh club's division is unknown until placement (placeNewClub). Keep a
    // neutral 1 until then; placement / rollover records the real tier.
    highestDivision: 1,
    // Deprecated: still consumed by the player-generation code (calcOverall /
    // generateSkills) until that overhaul lands. Neutral benchmark level.
    level: 15,
    cash: STARTING_CASH[2], // Division 1 new-club starting cash
    stadiumName,
    // Neutral default; stadium/capacity logic is slated for a separate revamp.
    stadiumCapacity: Math.max(15000, Math.min(60000, 15 * 1100 + nextInt(rng, 15000))),
    primaryColor: opts.primaryColor ?? "#d40000",
    secondaryColor: opts.secondaryColor ?? "#ffffff",
    coachName: generateName(rng, opts.country),
    tactics: tacticsForClub(rng),
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
  world.clubs.push(club);
  const base = TICKET_PRICES[divisionTicketTier(1)].map((x) => Math.max(1, Math.round(x / 200))) as [number, number, number, number];
  world.ticketPrices[club.id] = base;
  populatePlayers(rng, world, club);
  return club;
}

/** Generates a club's senior + youth squads and position top-ups. */
function populatePlayers(rng: ReturnType<typeof createRng>, world: World, club: Club) {
  const seniorCount = 25 + nextInt(rng, 6);
  const juniorCount = 8 + nextInt(rng, 5);
  for (let i = 0; i < seniorCount; i++) {
    const p = generatePlayer(rng, club, { id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  for (let i = 0; i < juniorCount; i++) {
    const p = generatePlayer(rng, club, { isYouth: true, id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  const squad = () => world.players.filter((p) => p.clubId === club.id);
  const byPos = (pos: number) => squad().filter((p) => p.position === pos);
  for (const pos of [0, 2, 1] as const) {
    if (byPos(pos).length === 0) {
      const p = generatePlayer(rng, club, { position: pos, id: world.nextId++, seed: world.seed });
      world.players.push(p);
    }
  }
  const gks = byPos(0).sort((a, b) => b.overall - a.overall);
  if (gks.length > 0) club.captainId = gks[0].id;
  club.penaltyTakerId = byPos(4).sort((a, b) => b.overall - a.overall)[0]?.id ?? gks[0]?.id ?? null;
}
