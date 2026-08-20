import type { RngState } from "./rng";
export type { RngState };

export type Position = 0 | 1 | 2 | 3 | 4;

export interface SkillSet {
  gol: number;
  vel: number;
  tec: number;
  pas: number;
  des: number;
  arm: number;
  fin: number;
}

export interface PlayerDevelopmentProfile {
  declineStartAge: number;
  developmentRate: number;
  developmentVolatility: number;
}

export interface Player {
  id: number;
  name: string;
  country: string;
  age: number;
  position: Position;
  side: number;
  skills: SkillSet;
  overall: number;
  potential: number;
  tier: number;
  characteristic1: number;
  characteristic2: number;
  energy: number;
  salary: number;
  payrollPaidThroughDay: number;
  payrollPaidAmount: number;
  payrollPeriodStartDay: number;
  value: number;
  releaseClause: number;
  injuryDays: number;
  contractDays: number;
  isYouth: boolean;
  starter: boolean;
  growthAcc: number;
  potentialAcc: number;
  skillAcc: number[];
  careerGoals: number;
  careerAssists: number;
  seasonGoals: number;
  seasonAssists: number;
  yellows: number;
  reds: number;
  clubId: number | null;
  tacPos: number;
  onSale: boolean;
  suspendedGames: number;
  morale: number;
  loanId: number | null;
  developmentProfile: PlayerDevelopmentProfile;
  recentMinutes: number[];
  // Immutable player-origin metadata (player-generation §50). Null for players
  // migrated from saves created before this generator landed.
  generatedClubId?: number | null;
  generatedDivision?: number | null;
  generatedSeasonId?: number | null;
  generationType?: string | null;
  generatedClubHighestDivision?: number | null;
  /** Raw unshifted birth-quality Z (player-generation §37 tier basis). */
  rawZ?: number | null;
  /**
   * Season id in which this player was generated as a financial-intervention
   * replacement (financial-control §31). While set to the current season the
   * player cannot be system-liquidated again (no repeated system-funded
   * creation → liquidation loops); eligibility resumes the following season.
   */
  financialInterventionGeneratedSeasonId?: number | null;
}

export interface LedgerEntry {
  code: number;
  amount: number;
  day: number;
  label: string;
}

export interface Ledger {
  income: LedgerEntry[];
  expense: LedgerEntry[];
}

export interface Tactics {
  formation: number;
  style: number;
  pressing: number;
  direction: number;
}

export interface SavedLineup {
  starters: number[];
  subs: number[];
  freeKickTakerId: number | null;
}

export interface Club {
  id: number;
  name: string;
  shortName: string;
  // Multiplayer: the user who owns this club, null for filler AI clubs.
  ownerUserId: number | null;
  // Multiplayer: IANA timezone of the owner (clustering target).
  timezone: string | null;
  // Multiplayer competition state: NEW | PROVISIONAL | ACTIVE | DORMANT.
  competitionState: "NEW" | "PROVISIONAL" | "ACTIVE" | "DORMANT";
  // Multiplayer: epoch ms of the last meaningful activity.
  lastMeaningfulActivityAt: number | null;
  // Multiplayer: epoch ms when the club became eligible for abandonment
  // (inactivity threshold exceeded mid-season). Actual removal only happens at
  // rollover (plan §42).
  abandonmentEligibleAt: number | null;
  // 0 = none, 1/2 = warning issued, 3 = removal-eligible at rollover.
  inactivityWarningStage?: number;
  // Multiplayer: epoch ms of the scheduled live-match kickoff (if any).
  liveMatchAt: number | null;
  country: string;
  // Highest division this club has ever reached (1 = strongest). Historical
  // milestone, independent of the current division (which is derived from
  // membership state via divisionForClub). Updated only once the club actually
  // enters a higher division (player-generation §20-§21).
  highestDivision: number;
  cash: number;
  stadiumName: string;
  stadiumCapacity: number;
  primaryColor: string;
  secondaryColor: string;
  coachName: string;
  tactics: Tactics;
  trainingFocus: "assistant" | "primary" | "secondary";
  captainId: number | null;
  penaltyTakerId: number | null;
  savedLineup?: SavedLineup | null;
  isHuman: boolean;
  ledger: Ledger;
  trophies: Record<string, number>;
}

export interface StandingsRow {
  clubId: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface GroupStandings {
  groupName: string;
  rows: Record<number, StandingsRow>;
}

export interface Competition {
  id: number;
  kind: "league" | "cup" | "state" | "division";
  name: string;
  round: number;
  stage: "group" | "knockout" | "finished";
  // Multiplayer: pyramid position of a division competition.
  seasonId?: number;
  tier?: number;
  groupIndex?: number;
  // Fixed for the life of this season.  It is used only when the configured
  // match-time mode is DIVISION_LOCAL_KICKOFF; changing an owner's timezone
  // must never move already scheduled fixtures.
  referenceTimezone?: string | null;
  status?: string;
  config: {
    clubs: number[];
    turns: number;
    groups: number[][];
    bracket: { home: number; away: number }[][];
    promoted: number;
    relegated: number;
    groupQualifiers: number;
    knockoutDays?: number[];
  };
  standings: Record<number, StandingsRow>;
  groupStandings: GroupStandings[];
  winners: number[];
  knockouts: Tie[][];
}

export interface KnockoutLeg {
  round: number;
  leg: number;
  homeClubId: number;
  awayClubId: number;
  played: boolean;
  aggregate?: [number, number];
}

export interface Tie {
  h: number;
  a: number;
  leg1?: { hs: number; as: number };
  leg2?: { hs: number; as: number };
  pen?: { hs: number; as: number; winner: number };
  winner: number | null;
  played: boolean;
}

export interface Fixture {
  id: number;
  competitionId: number;
  round: number;
  homeClubId: number;
  awayClubId: number;
  dayIndex: number;
  played: boolean;
  leg?: number;
  tie?: number;
  // Multiplayer: real kickoff timestamp (epoch ms). The match auto-plays at
  // this time whether humans are present or not.
  kickoffAt?: number;
  // Identity at the time this fixture was scheduled/played.  Competition
  // slots can change from filler AI to a human during a season, while the
  // historical participant/result must remain renderable after the filler is
  // retired.
  homeClubNameSnapshot?: string;
  awayClubNameSnapshot?: string;
}

export interface MatchEvent {
  minute: number;
  half: number;
  type: number;
  subtype: number;
  clubId: number;
  playerId: number | null;
  player2Id: number | null;
  goalType: number;
}

/** Per-team aggregate statistics produced by the possession-state engine
 *  (plans/6. match-simulator-overhaul.md §44). Percentages (possession share,
 *  field tilt) are never persisted; selectors derive them from
 *  `controlledBallSeconds`. */
export interface TeamMatchStats {
  controlledBallSeconds: number;
  attackingThirdControlledSeconds: number;

  possessions: number;
  passes: number;
  crosses: number;
  carries: number;
  dribbles: number;

  turnovers: number;
  highRecoveries: number;
  counterattacks: number;
  counterattackShots: number;
  boxEntries: number;

  shots: number;
  shotsOnTarget: number;
  xG: number;

  corners: number;
  fouls: number;
  yellows: number;
  reds: number;
  offsides: number;
  penalties: number;
  injuries: number;
}

export interface MatchStats {
  home: TeamMatchStats;
  away: TeamMatchStats;
}

export interface LiveCardState {
  playerId: number;
  /** YELLOW | RED | YELLOW_RED */
  kind: "YELLOW" | "RED" | "YELLOW_RED";
  minute: number;
}

export interface LiveInjuryState {
  playerId: number;
  days: number;
  minute: number;
}

export interface LiveSubstitutionState {
  minute: number;
  outId: number;
  inId: number;
}

/** A club's live per-match tactics (plans/6. §2). Formation/style/pressing are
 *  adapted from Club.tactics into the possession-state model. */
export interface LiveTactics {
  formation: number;
  /** CONTROL | PRESS | COUNTER (mapped from Club.tactics.style). */
  style: "CONTROL" | "PRESS" | "COUNTER";
  /** Effective pressing intensity 0..1 (Club.tactics.pressing scaled). */
  pressing: number;
  /** Preferred lane: CENTRE | WIDE (from Club.tactics.direction). */
  direction: "CENTRE" | "WIDE";
  /** Familiarity 0..100 with the current tactical setup. */
  familiarity: number;
}

export interface Match {
  id: number;
  fixtureId: number;
  competitionId: number;
  homeClubId: number;
  awayClubId: number;
  homeScore: number;
  awayScore: number;
  penaltyWinnerId: number | null;
  penaltyScore?: [number, number];
  attendance: number;
  gateRevenue: number;
  events: MatchEvent[];
  stats: MatchStats;
  extraTime?: boolean;
  minuteEvents: MatchEvent[][];
  // not persisted — used for activity tracking
  minutes?: Record<number, number>;
}

export interface SubSlots {
  gn: number[][];
  gm: number[][];
}

export interface LiveMatchState {
  matchId: number;
  fixtureId: number;
  competitionId: number;
  homeClubId: number;
  awayClubId: number;
  homeNeutral: boolean;
  decider: boolean;
  compKind: "league" | "cup" | "state" | "division";
  year: number;
  homeXI: number[];
  awayXI: number[];
  homeSubs: number[];
  awaySubs: number[];
  homeOn: number[];
  awayOn: number[];
  usedSubs: [number, number];
  subbedIn: [number[], number[]];
  scores: [number, number];
  stats: MatchStats;
  events: MatchEvent[];
  half: 0 | 1;
  minute: number;
  firstHalfLen: number;
  secondHalfLen: number;
  extraTimePlayed: boolean;
  withBall: number;
  possessionCounts: [number, number];
  playerYellows: Record<number, number>;
  subSlots: SubSlots;
  suspensionClears: number[];
  playerMinutes: Record<number, number>;
  /** Fractional in-match energy is persisted separately from Player.energy
   *  (the database field is an integer) so streamed ticks and reloads do not
   *  reset fatigue or introduce rounding drift. */
  playerEnergy: Record<number, number>;
  shootout?: { scores: [number, number]; winner: number };
  ended: boolean;
  // Real clock (epoch ms) of the last time this match was advanced. Used to
  // pace live matches at the configured real-world duration regardless of
  // worker tick rate and across server downtime.
  lastAdvancedAt: number;

  // -------------------------------------------------------------------------
  // Possession-state engine runtime (plans/6. match-simulator-overhaul.md §2).
  // All fields below are engine-owned runtime state and are persisted with the
  // live match so a restart resumes deterministically.
  // -------------------------------------------------------------------------
  /** Current match-clock seconds (controlled-ball + dead-ball time). */
  matchClockSeconds: number;
  period: 1 | 2;
  /** Seeded RNG stream owned by the engine. */
  rngState: RngState;
  /** Seconds of controlled ball per team (drives possession share). */
  controlledBallSeconds: [number, number];
  /** Seconds controlled in the attacking third per team. */
  attackingThirdControlledSeconds: [number, number];
  /** Current possession phase, zone and lane. */
  phase: string;
  zone: string;
  lane: "LEFT" | "CENTRE" | "RIGHT";
  possessionStartType: string;
  /** Seconds of the current possession already played (SET_PIECE/TRANSITION windows). */
  possessionAgeSeconds: number;
  /** Team quality / tactics signals derived once at kickoff. */
  homeTactics: LiveTactics;
  awayTactics: LiveTactics;
  /** Defensive organisation 0..1 per team (recovered continuously). */
  homeDefensiveOrganisation: number;
  awayDefensiveOrganisation: number;
  homeBaselineOrganisation: number;
  awayBaselineOrganisation: number;
  homeOrganisationRecoveryTime: number;
  awayOrganisationRecoveryTime: number;
  /** Live card/injury/substitution bookkeeping. */
  cards: LiveCardState[];
  injuries: LiveInjuryState[];
  substitutions: LiveSubstitutionState[];
  /** Team-match stat accumulators (mirrors Match.stats; kept here so live ticks
   *  accumulate incrementally and the final build is exact). */
  teamStats: { home: TeamMatchStats; away: TeamMatchStats };
  /** Bookkeeping: is this possession a live counterattack. */
  isCounter: boolean;
  /** Bookkeeping: high-recovery was recorded for the current possession. */
  possessionHighRecovery: boolean;
  /** Bookkeeping: opponent control window for sustained-pressure commentary. */
  opponentControlSeconds: [number, number];
  /** Bookkeeping: consecutive advanced/box states within the pressure window. */
  pressureWindowAdvancedStates: [number, number];
  pressureWindowStartSeconds: [number, number];
  /** Dead-ball restarts accumulated (used for restart sampling/corners). */
  pendingRestart: string | null;
  /** First action pinned by a possession start (resumed deterministically). */
  possessionFirstAction: string | null;
}

export interface NewsItem {
  dayIndex: number;
  text: string;
  kind: string;
  clubId?: number;
}

/** One private maximum bid per club/listing (transfer-market-overhaul §69). */
export interface MarketBid {
  id: number;
  /** TRANSFER | FREE_AGENT */
  marketType: "TRANSFER" | "FREE_AGENT";
  listingId: number;
  clubId: number;
  maxBid: number;
  // Snapshot of bidder-specific cap inputs/results for TRANSFER bids so later
  // config changes cannot make historical acceptance impossible to audit.
  capMultiplierAtSubmission?: number;
  maximumAllowedByRuleAtSubmission?: number;
  buyerDivisionAtSubmission?: number;
  createdAt: number;
  updatedAt: number;
  // Immutable tie-priority instant (earliest wins at equal maximums, §13).
  initialPriorityAt: number;
}

/** A listing in a public market. Auction + free-agent (transfer-market §68/70). */
export type MarketType = "TRANSFER" | "FREE_AGENT";

export type AuctionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** Public auction listing (transfer-market-overhaul §68). */
export interface TransferAuction {
  id: number;
  playerId: number;
  sellerClubId: number;
  playerValueAtListing: number;
  openingPrice: number;
  bidIncrement: number;
  // Seller's division number at listing time (cap basis, §10/§102.13.3).
  sellerDivisionAtListing: number;
  // Total division count (pyramid depth) at listing time, so later pyramid
  // changes cannot retroactively alter the normalized gap of a live listing.
  totalDivisionsAtListing: number;
  currentPrice: number;
  leadingClubId: number | null;
  createdAt: number;
  deadline: number;
  originalDeadline: number;
  status: AuctionStatus;
  completedAt: number | null;
  winningClubId: number | null;
  finalPrice: number | null;
  cancelledAt: number | null;
  /** True once the deadline was extended by a soft-close competitive bid. */
  softClosed: boolean;
  /** Number of soft-close extensions applied so far (bounds §17/§18). */
  softCloseExtensions: number;
}

/** Free-agent listing (transfer-market-overhaul §70). Phase 7 lifecycle. */
export interface FreeAgentListing {
  id: number;
  playerId: number;
  playerValueAtListing: number;
  openingPrice: number;
  bidIncrement: number;
  demandedSalary: number;
  demandedContractDays: number;
  currentPrice: number;
  leadingClubId: number | null;
  relistStage: number;
  createdAt: number;
  deadline: number;
  status: AuctionStatus;
  completedAt: number | null;
  winningClubId: number | null;
  finalPrice: number | null;
  previousListingId: number | null;
  /**
   * Club forbidden from bidding on this specific listing (financial-control
   * §35). Set to the former club when a system-liquidated player is listed so
   * the club cannot immediately re-sign the player it lost through financial
   * intervention. Null = no restriction; the block ends once another club
   * signs the player (§36).
   */
  blockedClubId: number | null;
  /** True once the deadline was extended by a soft-close competitive bid. */
  softClosed: boolean;
  /** Number of soft-close extensions applied so far (bounds §17/§18). */
  softCloseExtensions: number;
}

/**
 * Durable funds reserved against a club's active market commitments
 * (transfer-market-overhaul §23/§73). Survives server restart; released at
 * proxy state transitions and settlement.
 */
export interface MarketReservation {
  id: number;
  clubId: number;
  listingId: number;
  marketType: MarketType;
  /** Reserved amount = the club's current private maximum on this listing. */
  amount: number;
  createdAt: number;
  releasedAt: number | null;
}

/** Completed market movement history (transfer-market-overhaul §72). */
export interface PlayerMarketTransaction {
  id: number;
  playerId: number;
  listingId: number | null;
  type: "TRANSFER" | "FREE_AGENT_SIGNING" | "LOAN";
  fromClubId: number | null;
  toClubId: number | null;
  price: number;
  seasonId: number;
  seasonKey: string;
  matchday: number;
  timestamp: number;
}

/**
 * Durable AI market evaluation/decision state (transfer-market-overhaul
 * §102.5). One row per (marketType, listingId, clubId) so the AI evaluates
 * each listing at most once and a restart cannot trigger a re-evaluation.
 */
export interface AIEvaluation {
  marketType: MarketType;
  listingId: number;
  clubId: number;
  evaluatedAt: number;
  /** Action decided: NONE | BID | CLAIM (loans) | PASS. */
  decision: string;
  /** Maximum the AI committed, when it chose to bid. */
  maxBid: number | null;
}

export interface Loan {
  id: number;
  playerId: number;
  fromClubId: number;
  toClubId: number | null;
  startDay: number;
  endDay: number;
  recalled: boolean;
  /** Real-time instant the player was listed for loan (§57). */
  listedAt: number;
  /** Real-time instant the listing becomes claimable (listedAt + exposure, §57). */
  claimableAt: number;
}

export interface SeasonAward {
  season: number;
  category: string;
  competitionId: number | null;
  playerId: number | null;
  clubId: number | null;
  playerNameSnapshot: string | null;
  detail: string | null;
}

export interface CareerRecord {
  category: string;
  value: number;
  holderName: string;
}

export interface ManagerHistoryEntry {
  clubId: number;
  name: string;
  appointedDay: number;
  departedDay: number | null;
  gamesInCharge: number;
  reason: string | null;
}

export interface StadiumUpgrade {
  clubId: number;
  startedDay: number;
  completesDay: number;
  newCapacity: number;
  cost: number;
  completed: boolean;
}

export interface SeasonSummary {
  leagueChampionId: number | null;
  leagueRunnerUpId: number | null;
}

export type ClubCompetitionState = "NEW" | "PROVISIONAL" | "ACTIVE" | "DORMANT";

export interface MpState {
  // Current season identity (calendar month) and its DB row id.
  seasonId: number;
  seasonYear: number;
  seasonMonth: number;
  seasonStatus: "PREPARATION" | "ACTIVE" | "INTERSEASON" | "ROLLOVER" | "COMPLETE";
  completedRounds: number;
  joinLockRound: number;
  joinState: "OPEN" | "LOCKED";
  joinThresholdPercent: number;
  inactivityThresholds: { 1: number; 2: number; default: number };
  matchTimeMode: "GLOBAL_FIXED_KICKOFF" | "DIVISION_LOCAL_KICKOFF";
  matchKickoffHour: number;
  lastProcessedGameDay: number;
  // idempotency: last UTC day (yyyymmdd) the daily tick ran for.
  lastDailyTickDay: number;
  // Robust daily-time marker (plan §2): the last processed UTC date as
  // "YYYY-MM-DD". Null until the first daily tick runs. `lastDailyTickDay`
  // above is retained for migration from older saves.
  lastDailyTickDate: string | null;
  // Admin manual clock override: when set, the game treats completedRounds as
  // this value and simulates all rounds up to it instantly instead of waiting
  // for real kickoffs. Null = real schedule.
  manualRound: number | null;
  // Resumable rollover phase (plan §58): null when no rollover is in progress.
  rolloverPhase: string | null;
}

export interface MpQueueEntry {
  clubId: number;
  source: "NEW_CLUB" | "RETURNING_CLUB";
  queuedAt: number;
  preferredSeasonId: number;
}

export interface SeasonAllocation {
  clubId: number;
  seasonId: number;
  type: "ACTIVE_FULL" | "ACTIVE_PRORATED" | "PROVISIONAL_NEXT_SEASON";
  amount: number;
  issuedAt: number;
}

/** One child record of a financial intervention (financial-control §53). */
export interface FinancialInterventionEntry {
  playerId: number;
  /** FORCED_AUCTION | FORCED_AUCTION_CANCELLED | SYSTEM_LIQUIDATION */
  kind: string;
  price: number | null;
  replacementPlayerId: number | null;
}

/**
 * Audit record for one financial intervention run (financial-control §53).
 * Idempotency key: (clubId, seasonId, payrollCycleId) — the intervention for a
 * payroll cycle may execute at most once (§52).
 */
export interface FinancialIntervention {
  id: number;
  clubId: number;
  seasonId: number;
  /** dayIndex of the payroll cycle that triggered the intervention. */
  payrollCycleId: number;
  cashBefore: number;
  /** Active bids + remaining salaries + contingent leading-bid salaries. */
  commitmentsBefore: number;
  cushionBefore: number;
  forcedAuctionRevenue: number;
  systemLiquidationRevenue: number;
  cashAfter: number;
  /** Active bids + remaining salaries + contingent leading-bid salaries. */
  commitmentsAfter: number;
  cushionAfter: number;
  createdAt: number;
  entries: FinancialInterventionEntry[];
  /** True when even the best liquidation set could not fully recover the club. */
  unableToFullyRecover: boolean;
}

export interface MpMembershipEntry {
  divisionId: number;
  clubId: number;
  slotNumber: number;
  isFillerAI: boolean;
  replacedClubId: number | null;
  joinedAt: number;
}

export interface MpClubSeasonEntry {
  clubId: number;
  seasonId: number;
  divisionId: number | null;
  tier: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  promotionStatus: string;
  relegationStatus: string;
}

export interface MpActivityEntry {
  userId: number;
  clubId: number;
  activityType: string;
  occurredAt: number;
  metadata: string | null;
}

export interface MpAuditEntry {
  seasonId: number | null;
  clubId: number | null;
  userId: number | null;
  eventType: string;
  occurredAt: number;
  metadata: string | null;
}

/** Final standings snapshot for a completed season (plan §70/§71). Captured at
 *  rollover with club-name snapshots so later AI replacement, renaming or
 *  dormancy never rewrites historical results. */
export interface SeasonHistoryEntry {
  seasonId: number;
  seasonKey: string;
  archivedAt: number;
  divisions: {
    divisionId: number;
    divisionName: string;
    tier: number;
    groupIndex: number;
    standings: {
      clubId: number;
      clubName: string;
      played: number;
      wins: number;
      draws: number;
      losses: number;
      goalsFor: number;
      goalsAgainst: number;
      points: number;
    }[];
  }[];
}

export interface World {
  seed: number;
  year: number;
  dayIndex: number;
  dayOfWeek: number;
  nextId: number;
  clubs: Club[];
  players: Player[];
  competitions: Competition[];
  fixtures: Fixture[];
  matches: Match[];
  news: NewsItem[];
  loans: Loan[];
  // Multiplayer transfer market (transfer-market-overhaul Phase 2+).
  marketBids: MarketBid[];
  transferAuctions: TransferAuction[];
  freeAgentListings: FreeAgentListing[];
  marketReservations: MarketReservation[];
  playerMarketHistory: PlayerMarketTransaction[];
  aiEvaluations: AIEvaluation[];
  seasonAwards: SeasonAward[];
  records: CareerRecord[];
  managerHistory: ManagerHistoryEntry[];
  ticketPrices: Record<number, [number, number, number, number]>;
  stadiumUpgrades: StadiumUpgrade[];
  humanClubId: number | null;
  seasonSummary: SeasonSummary | null;
  rng: RngState;
  contractWarnings: number[];
  // Financial-intervention audit records (financial-control §53). Persisted for
  // disputes and anti-exploit analysis.
  financialInterventions: FinancialIntervention[];
  // Multiplayer state (see MpState).
  mp: MpState;
  // Multiplayer: clubs waiting for next season (post-lock joins, returning).
  mpQueue: MpQueueEntry[];
  // Multiplayer: multiple matches can be live at once. Each belongs to a
  // scheduled fixture and auto-plays to completion on the worker.
  liveMatches: LiveMatchState[];
  // Multiplayer: season allocations issued this season (idempotent payments).
  seasonAllocations: SeasonAllocation[];
  // Multiplayer: normalized per-division memberships for the active season
  // (mirror of MpMembership rows).
  mpMemberships: MpMembershipEntry[];
  // Multiplayer: per-club-per-season competition records (mirror of
  // MpClubSeason rows).
  mpClubSeasons: MpClubSeasonEntry[];
  // Multiplayer: audit trail of meaningful activity (mirror of MpActivity).
  mpActivities: MpActivityEntry[];
  mpAudits: MpAuditEntry[];
  // Multiplayer: final standings snapshots for completed seasons (plan §70).
  seasonHistory: SeasonHistoryEntry[];
  // Idempotency ledger for player generation events (player-generation §45/§46).
  // Keys: "academy-intake:{clubId}:{seasonId}", "club-creation:{clubId}".
  generationEvents: string[];
  pendingDayEvents?: string[];
  pendingDayMatchIds?: number[];
}

export interface DayResult {
  dayIndex: number;
  dateLabel: string;
  playedMatches: Match[];
  news: NewsItem[];
  events: string[];
  humanMatch?: Match;
  matchPending?: boolean;
  seasonEnded?: boolean;
}
