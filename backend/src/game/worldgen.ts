import type { Club, World } from "../game/types";
import { createRng } from "../game/rng";
import { nextInt } from "../game/rng";
import { tacticsForClub } from "../game/club";
import { generateName } from "../game/names";
import { ELO_CONFIG, MP_CONFIG } from "../config";
import { generateNewClubRoster, totalDivisionsForGeneration } from "./clubGenerator";

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
    clubEloEvents: [],
    news: [{ dayIndex: 0, text: "Welcome to Footmania! A new season is about to begin.", kind: "season" }],
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
    rng,
    financialInterventions: [],
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
      absoluteGameDay: 0,
      seasonNumber: 1,
      seasonDayIndex: 0,
      phase: "ACTIVE",
      lastAdvancedAt: null,
      clockVersion: 0,
      startAbsoluteGameDay: 0,
      seasonStartAt: null,
      rolloverContext: null,
      calendarMigrationVersion: 1,
      contractMarketMigrationVersion: 1,
      loanEndAbsoluteGameDays: {},
    },
    mpQueue: [],
    liveMatches: [],
    seasonAllocations: [],
    mpMemberships: [],
    mpClubSeasons: [],
    mpActivities: [],
    mpAudits: [],
    friendships: [],
    seasonHistory: [],
    generationEvents: [],
  };
}

export interface HumanClubOptions {
  userId: number;
  clubName: string;
  country: string;
  primaryColor?: string;
  secondaryColor?: string;
  /** Kit Lab: full three-kit set from the creation wizard. When present the
   * home shell becomes the club identity colors. */
  kits?: import("./kits").ClubKits | null;
  stadiumName?: string;
  /** Human-entered manager name. Omitted only for internal legacy callers. */
  coachName?: string;
  /** Validated half-hour preferred-match slots on the UTC grid
   * (see game/scheduling.ts). */
  preferredHours?: number[] | null;
  /** Friend-grouping consent; defaults to true (bilateral rule enforced in
   * game/multiplayer.ts social scoring). */
  friendGroupingOptIn?: boolean;
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
  const initialDivision = totalDivisionsForGeneration(world);
  const club: Club = {
    id,
    name,
    shortName: name,
    ownerUserId: opts.userId,
    preferredHours: opts.preferredHours ?? null,
    friendGroupingOptIn: opts.friendGroupingOptIn ?? true,
    competitionState: "NEW",
    lastMeaningfulActivityAt: Date.now(),
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: opts.country,
    // The initial roster uses the current bottom edge; actual first placement
    // can replace this provisional value when the club enters competition.
    highestDivision: initialDivision,
    // New clubs are funded exclusively by their season budget (MP_CONFIG).
    cash: MP_CONFIG.newClubStartingCash,
    stadiumName,
    // Kit designs: explicit from the wizard, else null (derived on read). The
    // identity columns mirror the home shell so standings/live consumers that
    // read primaryColor/secondaryColor stay authoritative.
    kits: opts.kits ?? null,
    primaryColor: opts.kits?.home.primary ?? opts.primaryColor ?? "#d40000",
    secondaryColor: opts.kits?.home.secondary ?? opts.secondaryColor ?? "#ffffff",
    coachName: opts.coachName?.trim() || generateName(rng, opts.country),
    coachNameChangedSeasonKey: null,
    tactics: tacticsForClub(rng),
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    logoVariant: 0,
    customLogo: null,
    automationPresets: [],
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
    eloRating: ELO_CONFIG.initial,
    eloRatedMatches: 0,
  };
  world.clubs.push(club);
  // The human club's initial roster is generated by the canonical division-driven
  // generator. A brand-new human club has no division until placement, so the
  // senior squad starts at the bottom division's expectation (player-generation
  // §72); placement / first rollover records the real division for future intake.
  generateNewClubRoster({
    world,
    club,
    currentDivision: initialDivision,
    highestDivisionReached: initialDivision,
    totalDivisions: initialDivision,
    seasonId: null,
  });
  return club;
}
