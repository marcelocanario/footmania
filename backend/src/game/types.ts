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
  /** Pro-set nickname, visible to everyone; null = none. */
  nickname?: string | null;
  country: string;
  age: number;
  position: Position;
  side: number;
  skills: SkillSet;
  overall: number;
  potential: number;
  energy: number;
  /** Hidden exponentially-decaying recent match workload. */
  recentLoad?: number;
  salary: number;
  payrollPaidThroughDay: number;
  payrollPaidAmount: number;
  payrollPeriodStartDay: number;
  value: number;
  releaseClause: number;
  injuryDays: number;
  /** Absolute game-day injury state. injuryDays is retained as a derived legacy view. */
  injuryUntilAbsoluteGameDay?: number | null;
  injuryInitialGameDays?: number | null;
  injuryEquivalentRealDays?: number | null;
  injuryCause?: "MATCH" | "TRAINING" | null;
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
  /** Squad shirt number; unique within a club. Null = not yet assigned. */
  squadNumber?: number | null;
  onSale: boolean;
  suspendedGames: number;
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

export type AutomationTriggerKind = "MINUTE" | "HALF_TIME" | "GOAL_SCORED" | "GOAL_CONCEDED" | "RED_CARD";
export type AutomationCondition = "ANY" | "WINNING" | "LOSING" | "DRAWING" | "WINNING_BY_2" | "LOSING_BY_2";
export type AutomationActionKind = "SUB" | "TACTICS";

export interface AutomationTrigger {
  kind: AutomationTriggerKind;
  /** For MINUTE only. 1..90. */
  minute?: number;
}

export interface AutomationAction {
  kind: AutomationActionKind;
  /** SUB: player IDs */
  outPlayerId?: number;
  inPlayerId?: number;
  /** TACTICS: partial tactics update */
  formation?: number;
  style?: number;
  pressing?: number;
  direction?: number;
}

export interface AutomationRule {
  id: string;
  trigger: AutomationTrigger;
  condition: AutomationCondition;
  action: AutomationAction;
}

export interface AutomationPreset {
  id: string;
  name: string;
  /** Formation this preset applies to; null = any (regular users) */
  formationId: number | null;
  enabled: boolean;
  rules: AutomationRule[];
}

export interface Club {
  id: number;
  name: string;
  shortName: string;
  // Multiplayer: the user who owns this club, null for filler AI clubs.
  ownerUserId: number | null;
  // Multiplayer competition state: NEW | PROVISIONAL | ACTIVE | DORMANT.
  competitionState: "NEW" | "PROVISIONAL" | "ACTIVE" | "DORMANT";
  // Multiplayer: epoch ms of the last meaningful activity.
  lastMeaningfulActivityAt: number | null;
  // Multiplayer: epoch ms when the club became eligible for abandonment
  // (inactivity threshold exceeded mid-season). Actual removal only happens at
  // rollover (plan §42).
  abandonmentEligibleAt: number | null;
  // Multiplayer: epoch ms of the scheduled live-match kickoff (if any).
  liveMatchAt: number | null;
  // Preferred match-time half-hour slots on a UTC grid (0..47). Null =
  // unconstrained (legacy humans, AI): every slot scores distance 0. Clients
  // convert from/to the browser's timezone at the edges; the server never sees
  // a timezone. Consulted when a season's fixtures are generated AND when
  // divisions are regrouped (window-overlap clustering); never reschedules.
  preferredHours?: number[] | null;
  /** Friend-grouping consent (bilateral rule): this owner's accepted friendships
   * may pull them into the same division group only when BOTH friends opted in.
   * Undefined = true for legacy rows. Serialized to Club.friendGroupingOptIn. */
  friendGroupingOptIn?: boolean;
  country: string;
  // Highest division this club has ever reached (1 = strongest). Historical
  // milestone, independent of the current division (which is derived from
  // membership state via divisionForClub). Updated only once the club actually
  // enters a higher division (player-generation §20-§21).
  highestDivision: number;
  cash: number;
  stadiumName: string;
  primaryColor: string;
  secondaryColor: string;
  /** Kit Lab: explicit jersey designs (home/away/GK). Null = derive from the
   * two identity colors (see game/kits.ts). Serialized to Club.kitJson. */
  kits?: import("./kits").ClubKits | null;
  /** Crest/badge variant (0 = default SVG recolored). Grows with art assets. */
  logoVariant?: number;
  /** Custom raster logo uploaded by Pro users (base64). Null = none/active variant fallback. */
  customLogo?: { mime: string; data: string; status: string } | null;
  /** Automation presets (JSON; one per formation for Pro, one total for regular). */
  automationPresets?: AutomationPreset[] | null;
  coachName: string;
  /** Season key in which the human manager last changed the coach name. */
  coachNameChangedSeasonKey?: string | null;
  tactics: Tactics;
  trainingFocus: "assistant" | "primary" | "secondary";
  captainId: number | null;
  penaltyTakerId: number | null;
  savedLineup?: SavedLineup | null;
  isHuman: boolean;
  ledger: Ledger;
  trophies: Record<string, number>;
  /** Hidden competitive rating used for human-vs-human promotion comparisons. */
  eloRating?: number;
  eloRatedMatches?: number;
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
  // Legacy multiplayer field: never written by current code and unused by
  // match-time modes, but kept for old save rows. Must never move already
  // scheduled fixtures.
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
  /** Immutable zero-based game-calendar day on which this round is played. */
  scheduledSeasonDayIndex?: number;
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
  /** Stoppage-time minute offset when the event occurred during added time (e.g. 90+2). */
  addedTime?: number;
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

/** Optional instant-simulation diagnostics; never required for persisted matches. */
export interface MatchSimulationDiagnostics {
  actionCounts: Record<string, number>;
  phaseResidenceSeconds: Record<string, number>;
  restartCounts: Record<string, number>;
  possessionStarts: number;
  deadBallSeconds: number;
  controlledBallSeconds: [number, number];
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
  equivalentRealDays?: number;
  cause?: "MATCH" | "TRAINING";
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
  events: MatchEvent[];
  stats: MatchStats;
  extraTime?: boolean;
  scheduledAt?: number;
  minuteEvents: MatchEvent[][];
  /** Captured at kickoff so later ownership changes cannot rewrite history. */
  homeWasHuman?: boolean;
  awayWasHuman?: boolean;
  eloProcessed?: boolean;
  // not persisted — used for activity tracking
  minutes?: Record<number, number>;
  /** not persisted — available for calibration/instrumentation consumers */
  simulationDiagnostics?: MatchSimulationDiagnostics;
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
  /** Persistent workload snapshot and this match's accumulated load. */
  playerRecentLoad?: Record<number, number>;
  playerMatchLoad?: Record<number, number>;
  playerPreMatchLoad?: Record<number, number>;
  absoluteGameDay?: number;
  roundsPerSeason?: number;
  matchSpacingDays?: number;
  shootout?: { scores: [number, number]; winner: number };
  ended: boolean;
  // Real clock (epoch ms) of the last time this match was advanced. Used to
  // pace live matches at the configured real-world duration regardless of
  // worker tick rate and across server downtime.
  lastAdvancedAt: number;
  /** Coin-toss winner: 0 = home kicks off first half, 1 = away. Frozen at creation. */
  coinTossWinner?: 0 | 1;
  /** Announced added minutes per half, frozen when the half's regulation clock is first reached. */
  firstHalfAddedMinutes?: number;
  secondHalfAddedMinutes?: number;
  /** Wall-clock instant halftime started (first half + its added time finished). Null outside halftime. */
  halftimeStartedAt?: number | null;
  /** Per-side ready flags to skip the wall-clock halftime early (both humans must be ready in human vs human). */
  halftimeReady?: [boolean, boolean];
  /** Match-minute of each side's last tactics change (manual or automation).
   *  Drives the liveMatch.tacticsCooldownMatchMinutes lock; null = not yet
   *  changed this match, so the first change is always free. */
  tacticsChangedAtMinute?: [number | null, number | null];

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
  /** Automation: rule ids that have already fired this match (persisted for restart idempotency). */
  automationFiredRuleIds?: string[];
  /** Automation: per-side kill-switch set when viewer explicitly disables automation. */
  automationDisabled?: [boolean, boolean];
}

export interface NewsItem {
  id?: number;
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
  /** Contract terms accepted with the first bid; immutable on later raises. */
  contractSeasons?: number;
  contractSalary?: number;
  contractDemandAtSubmission?: number;
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
  /** Salary baseline used for bidder-specific contract demands. */
  salaryBaselineAtListing?: number;
  playerOverallAtListing?: number;
  playerAgeAtListing?: number;
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
  /** True once the deadline was reset by a soft-close competitive bid. */
  softClosed: boolean;
  /** Incremented whenever the persisted real-time deadline is replaced. */
  deadlineVersion?: number;
}

/** Free-agent listing (transfer-market-overhaul §70). Phase 7 lifecycle. */
export interface FreeAgentListing {
  id: number;
  playerId: number;
  playerValueAtListing: number;
  openingPrice: number;
  bidIncrement: number;
  /** Salary baseline used for bidder-specific contract demands. */
  salaryBaselineAtListing?: number;
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
  /** Original unclaimed timestamp preserved through every relist. */
  unclaimedSince?: number;
  /** True once the deadline was reset by a soft-close competitive bid. */
  softClosed: boolean;
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
  seasonDayIndex: number;
  /**
   * Global completed-rounds counter at transaction time. Feeds the resale
   * anchor fade with a monotonic clock (review C4); legacy rows may predate
   * the field and fall back to the day-based approximation.
   */
  completedRounds?: number;
  contractSeasons?: number | null;
  contractSalary?: number | null;
  timestamp: number;
}

export interface Loan {
  id: number;
  playerId: number;
  fromClubId: number;
  toClubId: number | null;
  startDay: number;
  endDay: number;
  recalled: boolean;
  /**
   * Lender-chosen claim fee (§55), snapshotted in absolute currency at listing
   * time as a fraction of the player's value within the configured band. Paid
   * by the borrower to the lender at claim; legacy rows may predate the field.
   */
  feeAmount?: number;
  /** Real-time instant the player was listed for loan (§57). */
  listedAt: number;
  /** Real-time instant the listing becomes claimable (listedAt + exposure, §57). */
  claimableAt: number;
}

export interface SeasonAward {
  id?: number;
  season: number;
  category: string;
  competitionId: number | null;
  playerId: number | null;
  clubId: number | null;
  playerNameSnapshot: string | null;
  detail: string | null;
}

export interface CareerRecord {
  id?: number;
  category: string;
  value: number;
  holderName: string;
}

export interface SeasonSummary {
  leagueChampionId: number | null;
  leagueRunnerUpId: number | null;
}

export type ClubCompetitionState = "NEW" | "PROVISIONAL" | "ACTIVE" | "DORMANT";

export type RolloverWorkflowStep =
  | "SEASON_RESULTS_FINALIZE"
  | "INTERSEASON_START"
  | "PROMOTION_RELEGATION"
  | "DIVISION_RESTRUCTURE"
  | "WAITING_POOL_ASSIGNMENT"
  | "NEXT_SEASON_BUDGET_ALLOCATION"
  | "CONTRACT_END_PROCESSING"
  | "SEASONAL_ACADEMY_INTAKE"
  | "NEXT_SEASON_PREPARATION_OPEN"
  | "NEXT_SEASON_FIXTURE_GENERATION"
  | "NEXT_SEASON_STRUCTURE_VALIDATE"
  | "SEASON_ROLLOVER_COMMIT";

export interface RolloverContext {
  sourceSeasonId: number;
  targetSeasonId: number;
  targetYear: number;
  targetMonth: number;
  /** Seed shared by all next-season group-assignment tie-breaks. */
  groupAssignmentSeed?: number;
  assignments: Record<string, number>;
  abandonedClubIds: number[];
  provisionalClubIds: number[];
  completedSteps: RolloverWorkflowStep[];
  eloRegressionApplied?: boolean;
}

export interface MpState {
  // Current season identity and its DB row id. Year/month are display metadata
  // retained for compatibility with old saves, not competition timing.
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
  absoluteGameDay?: number;
  seasonNumber?: number;
  seasonDayIndex?: number;
  phase?: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
  lastAdvancedAt?: number | null;
  clockVersion?: number;
  startAbsoluteGameDay?: number;
  /** Wall-clock instant corresponding to Season Day 1. */
  seasonStartAt?: number | null;
  /** Durable context shared by independently executable rollover steps. */
  rolloverContext?: RolloverContext | null;
  /** One-time economic conversion marker for the 30 -> 35 day migration. */
  calendarMigrationVersion?: number;
  /** One-time cleanup marker for the bidder-specific contract market rollout. */
  contractMarketMigrationVersion?: number;
  /** Absolute end day for loans, keyed by loan ID. */
  loanEndAbsoluteGameDays?: Record<string, number>;
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

export interface ClubEloEvent {
  id: number;
  matchId: number;
  clubId: number;
  opponentClubId: number;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  expectedScore: number;
  actualScore: number;
  createdAt: number;
}

export interface MpActivityEntry {
  userId: number;
  clubId: number;
  activityType: string;
  occurredAt: number;
  metadata: string | null;
}

export interface MpFriendshipEntry {
  userAId: number;
  userBId: number;
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
  clubEloEvents?: ClubEloEvent[];
  news: NewsItem[];
  loans: Loan[];
  // Multiplayer transfer market (transfer-market-overhaul Phase 2+).
  marketBids: MarketBid[];
  transferAuctions: TransferAuction[];
  freeAgentListings: FreeAgentListing[];
  marketReservations: MarketReservation[];
   playerMarketHistory: PlayerMarketTransaction[];
   seasonAwards: SeasonAward[];
   records: CareerRecord[];
   humanClubId: number | null;
   seasonSummary: SeasonSummary | null;
   rng: RngState;
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
  /** Accepted human friendships used only during same-tier regrouping. */
  friendships?: MpFriendshipEntry[];
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
