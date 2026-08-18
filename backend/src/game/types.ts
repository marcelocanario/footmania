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
  salePrice: number | null;
  suspendedGames: number;
  morale: number;
  loanId: number | null;
  developmentProfile: PlayerDevelopmentProfile;
  recentMinutes: number[];
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
  level: number;
  cash: number;
  stadiumName: string;
  stadiumCapacity: number;
  primaryColor: string;
  secondaryColor: string;
  coachName: string;
  boardConfidence: number;
  fanConfidence: number;
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

export interface MatchStats {
  possession: [number, number];
  shots: [number, number];
  onGoal: [number, number];
  offTarget: [number, number];
  fouls: [number, number];
  corners: [number, number];
  yellows: [number, number];
  reds: [number, number];
  tackles: [number, number];
  wrongPasses: [number, number];
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
  shootout?: { scores: [number, number]; winner: number };
  ended: boolean;
  // Real clock (epoch ms) of the last time this match was advanced. Used to
  // pace live matches at the configured real-world duration regardless of
  // worker tick rate and across server downtime.
  lastAdvancedAt: number;
}

export interface NewsItem {
  dayIndex: number;
  text: string;
  kind: string;
  clubId?: number;
}

export interface AuctionListing {
  id: number;
  playerId: number;
  minBid: number;
  deadlineDay: number;
  // Multiplayer: absolute epoch-ms deadline (plan §51). Set from deadlineDay
  // when created; the minute worker settles auctions whose endsAt has passed.
  startsAt?: number;
  endsAt?: number;
  sellerClubId: number | null;
  bids: { clubId: number; amount: number }[];
}

export interface Loan {
  id: number;
  playerId: number;
  fromClubId: number;
  toClubId: number | null;
  startDay: number;
  endDay: number;
  recalled: boolean;
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

export interface TvDeal {
  clubId: number;
  season: number;
  baseAmount: number;
  positionBonus: number;
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
  auctions: AuctionListing[];
  loans: Loan[];
  seasonAwards: SeasonAward[];
  records: CareerRecord[];
  managerHistory: ManagerHistoryEntry[];
  ticketPrices: Record<number, [number, number, number, number]>;
  stadiumUpgrades: StadiumUpgrade[];
  tvDeals: TvDeal[];
  humanClubId: number | null;
  seasonSummary: SeasonSummary | null;
  rng: RngState;
  contractWarnings: number[];
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
