export interface User {
  id: number;
  /** Google display name (the manager is called by this in-game). */
  name: string;
  /** Verified email — the account key across OAuth providers. */
  email: string;
  isAdmin?: boolean;
  isPro?: boolean;
  locale?: "en" | "fr" | "pt-BR" | null;
  bannedAt?: string | null;
  banReason?: string | null;
}

export interface CountryOption {
  code: string;
  name: string;
  strength: number;
  featured: boolean;
}

export interface SkillSet {
  gol: number;
  pace: number;
  tec: number;
  pas: number;
  des: number;
  playmaking: number;
  fin: number;
  /** @deprecated legacy keys */
  vel?: number;
  arm?: number;
}

/** Kit Lab: one jersey design (mirrors backend game/kits.ts). */
export interface KitDesign {
  primary: string;
  secondary: string;
  accent: string;
  numberColor: string;
  pattern: string;
  number?: number | null;
}

export interface ClubKits {
  home: KitDesign;
  away: KitDesign;
  gk: KitDesign;
}

export interface PlayerView {
  id: number;
  name: string;
  nickname?: string | null;
  displayName?: string;
  age: number;
  country: string;
  naturalPosition: string;
  slotIndex?: number | null;
  deployedRole?: string | null;
  rolePenalty?: number | null;
  suitabilityLabel?: string | null;
  adjustedTacticalRating?: number | null;
  /** Squad shirt number; null for legacy players not yet assigned. */
  squadNumber?: number | null;
  overall: number;
  skills: SkillSet;
  energy: number;
  value: number;
  salary: number;
  contractDays: number;
  injuryDays: number;
  injuryDaysRemaining?: number;
  injuryCause?: "MATCH" | "TRAINING" | null;
  injuryUntilAbsoluteGameDay?: number | null;
  conditionLabel?: string;
  isYouth: boolean;
  /** League matches this season with at least one minute played. */
  seasonAppearances?: number;
  seasonGoals: number;
  seasonAssists: number;
  careerGoals: number;
  careerAssists: number;
  /** Matches named MVP (best performer on the winning team). */
  seasonMvps?: number;
  careerMvps?: number;
  yellows: number;
  reds: number;
  /** Yellow cards in the current league turn (per-turn disciplinary limit). */
  turnYellows?: number;
  /** True when booked in the same league turn as the club's next match and one
   *  card away from the automatic per-turn ban. */
  yellowWarning?: boolean;
  onSale: boolean;
  suspended: boolean;
  suspendedGames: number;
  loanId: number | null;
  releaseClause: number;
  onLoan: boolean;
  onLoanOut: boolean;
  loanClubName: string | null;
  loanFromName: string | null;
}

/** Player history omits skills for non-Pro viewers of another club. */
export type PlayerHistoryView = Omit<PlayerView, "skills"> & {
  clubId: number | null;
  skills?: SkillSet;
  clubName: string | null;
  isOwnTeam: boolean;
};

export interface PlayerHistorySeason {
  seasonId: number;
  seasonKey: string;
  clubId: number;
  clubName: string;
  appearances: number;
  goals: number;
  assists: number;
  yellows: number;
  reds: number;
  minutes: number;
  /** End-of-season snapshot; null for seasons archived before the field existed. */
  overall: number | null;
  value: number | null;
  /** Season MVP count snapshot. */
  mvps?: number;
  /** Average MVP score (goals*2 + assists)/appearances; null when no apps. */
  avgScore?: number | null;
}

/** One of a player's recent matches with his performance rating. */
export interface PlayerMatchScoreView {
  matchId: number;
  /** 3.0–10.0 rating; 0 when NR (under 10 minutes). */
  score: number;
  rating: number | null;
  goals: number;
  assists: number;
  won: boolean;
  result: string | null;
  /** Season the match belongs to. */
  seasonId?: number | null;
  /** True when the match belongs to the current world season. */
  currentSeason?: boolean;
  minutesPlayed?: number;
  role?: string;
}

export interface PlayerHistoryResponse {
  player: PlayerHistoryView;
  seasons: PlayerHistorySeason[];
  transfers: unknown[];
  matches: unknown[];
  /** Player's scores for his last 10 appearances, newest first. */
  matchScores?: PlayerMatchScoreView[];
  /** Running average rating for the current season; null when not rated/visible. */
  currentSeasonAvg?: number | null;
}

export interface ClubView {
  id: number;
  name: string;
  shortName: string;
  country: string;
  highestDivision: number;
  cash: number;
  stadiumName: string;
  primaryColor: string;
  secondaryColor: string;
  kits?: ClubKits | null;
  logoVariant?: number;
  hasCustomLogo?: boolean;
  coachName: string;
  coachEditAllowed?: boolean;
  trainingFocus: "assistant" | "primary" | "secondary";
  competitionState?: string;
  tactics: { formation: number; style: number; pressing: number; direction: number; familiarity?: number; projections?: TacticProjection[] } | null;
  trophies: Record<string, number>;
  ledger: { income: LedgerEntry[]; expense: LedgerEntry[] };
  finance?: { activeBidCommitments: number; remainingSalaryCommitments: number; contingentSalary: number; immediateAvailableCash: number; remainingSeasonFraction: number; financialCushion: number; status: "SAFE" | "AT_RISK" | "NEGATIVE_CASH" };
}

export interface MpStatus {
  ready: boolean;
  saveId: number | null;
  /** Season pause (admin freeze): countdowns hold and market/loan actions are disabled. */
  paused: boolean;
  season: {
    seasonNumber: number;
    key: string;
    year: number;
    month: number;
    status: string;
    completedRounds: number;
    joinLockRound: number;
    joinState: "OPEN" | "LOCKED";
    seasonDayIndex: number;
    seasonDay: number;
    seasonDays: number;
    phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
    interseasonAfterMatchDays: number;
    interseasonBeforeNextSeasonDays: number;
    lastLeagueMatchDayIndex: number;
    interseasonStartIndex: number;
    preparationStartIndex: number;
  };
  calendar: {
    today: number;
    days: { day: number; phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON"; label: string }[];
  };
  myMatches: {
    fixtureId: number;
    dayIndex: number;
    round: number;
    opponent: string;
    opponentClubId: number;
    isHome: boolean;
    played: boolean;
    goalsFor: number | null;
    goalsAgainst: number | null;
  }[];
  userClubId: number | null;
  awaitingFirstHuman: boolean;
  club: {
    id: number;
    name: string;
    shortName: string;
    country: string;
    highestDivision: number;
    cash: number;
    competitionState: string;
    friendGroupingOptIn: boolean;
    preferredHours: number[] | null;
    reservedNextSeasonAllocation: { seasonId: number; amount: number; issuedAt: number } | null;
    inactivity: { eligible: boolean; removedAtRollover: boolean; note: string | null } | null;
  } | null;
  preservedIdentity: {
    name: string;
    primaryColor: string;
    secondaryColor: string;
    stadiumName: string;
    coachName: string;
    country: string;
    hasCustomLogo: boolean;
    kits: { home: KitDesign; away: KitDesign; gk: KitDesign } | null;
  } | null;
}

/** Public world-clock snapshot served unauthenticated to the landing page. */
export interface PublicSeasonStatus {
  ready: boolean;
  paused: boolean;
  awaitingFirstHuman: boolean;
  season: {
    seasonNumber: number;
    key: string;
    completedRounds: number;
    joinLockRound: number;
    joinState: "OPEN" | "LOCKED";
    seasonDay: number;
    seasonDays: number;
    phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
    interseasonStartIndex: number;
    preparationStartIndex: number;
    lastLeagueMatchDayIndex: number;
  };
}

export interface MarketUpdate {
  type: "marketUpdated";
  marketType: "TRANSFER" | "FREE_AGENT";
  listingId: number;
  status: string;
  currentPrice?: number;
  deadline?: number;
  bidderCount?: number;
  amILeading?: boolean;
}

export interface SchedulerClockView {
  absoluteGameDay: number;
  seasonId: number;
  seasonNumber: number;
  seasonDayIndex: number;
  seasonDay: number;
  seasonDays: number;
  phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
  interseasonDays: number;
  interseasonAfterMatchDays: number;
  interseasonBeforeNextSeasonDays: number;
  lastLeagueMatchDayIndex: number;
  interseasonStartIndex: number;
  preparationStartIndex: number;
  lastAdvancedAt: string;
  nextAutomaticDayAdvance: string | null;
  lastDayAdvance: string;
  /** Season pause state (freeze-timers semantics). */
  paused: boolean;
  pausedAt: number | null;
  health: "HEALTHY" | "OVERDUE" | "FAILED_EVENTS" | "SCHEDULER_REQUIRES_ADMIN_REVIEW";
  pendingEvents: number;
  overdueEvents: number;
  failedEvents: number;
  oldestOverdueSeconds: number;
}

export interface ScheduledEventView {
  id: string;
  type: string;
  timeBasis: "GAME_DAY" | "REAL_TIME";
  dueAbsoluteGameDay: number | null;
  dueAt: string | null;
  phase: "BEGIN_OF_DAY" | "INTRADAY" | "END_OF_DAY" | null;
  priority: number;
  entityType: string | null;
  entityId: string | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  attempts: number;
  lastError: string | null;
  executionSource: string;
  payloadJson?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface SchedulerMatchView {
  id: number;
  seasonId: number;
  round: number;
  division: string;
  homeClub: string;
  awayClub: string;
  scheduledGameDay: number;
  scheduledAt: number | null;
  status: string;
  event: ScheduledEventView | null;
}

export interface SchedulerAuctionView {
  id: number;
  player: string;
  seller: string;
  displayedBid: number;
  leadingMaxBid: number | null;
  bidCount: number;
  createdAt: number;
  endsAt: number;
  status: string;
  event: ScheduledEventView | null;
}

export interface SchedulerAuditView {
  id: string;
  adminUserId: number;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeJson: string;
  afterJson: string;
  reason: string | null;
  createdAt: string;
}

export interface SchedulerPreviewEntry {
  seasonDayIndex: number;
  seasonDay: number;
  label: string;
  round: number | null;
  phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
  payroll: boolean;
  weeklySimulation: boolean;
}

export interface SeasonHistoryView {
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
      isMine: boolean;
    }[];
  }[];
}

export interface PyramidTier {
  tier: number;
  divisions: { id: number; name: string; tier: number; groupIndex: number; humanCount: number; aiCount: number }[];
}

export interface StandingsRow {
  clubId: number;
  clubName: string;
  clubShort: string;
  colors: { primary: string; secondary: string };
  /** Kit Lab: home design for jersey-style badges; null for legacy payloads. */
  kit?: KitDesign | null;
  hasCustomLogo?: boolean;
  isHuman: boolean;
  clubType: "HUMAN" | "AI";
  isMine: boolean;
  humanPosition: number | null;
  promotionStatus: "NONE" | "POSSIBLE" | "PROMOTED";
  relegationStatus: "NONE" | "RELEGATED";
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface FixtureView {
  id: number;
  round: number;
  home: string;
  away: string;
  homeClubId: number;
  awayClubId: number;
  /** Home side wears its home design, away side its away design. */
  homeKit?: KitDesign | null;
  awayKit?: KitDesign | null;
  homeHasCustomLogo?: boolean;
  awayHasCustomLogo?: boolean;
  /** Venue: the home club's stadium. */
  venue?: string;
  kickoffAt: number | null;
  played: boolean;
  /** Stored match id once played; null while unplayed. */
  matchId?: number | null;
  /** Set while this fixture is being played right now; spectators can watch. */
  liveMatchId?: number | null;
  homeScore: number | null;
  awayScore: number | null;
  isHuman: boolean;
}

/** Admin analytics: per-division real vs projected quality (adminAnalytics.ts). */
export interface AdminAnalyticsDivision {
  divisionId: number;
  name: string;
  tier: number;
  groupIndex: number;
  clubCount: number;
  humanCount: number;
  /** Mean senior overall in the division; null when no senior players exist. */
  realAvgOverall: number | null;
  /** Canonical divisionMean(tier, depth) expectation. */
  projectedAvgOverall: number;
  deltaOverall: number | null;
  clubsInFinancialDistress: number;
  realSeniorCount: number;
  projectedSeniorCount: number;
  realYouthCount: number;
  projectedYouthCount: number;
  clubsBelowSquadFloor: number;
  overallStdDev: number | null;
  overallP10: number | null;
  overallP90: number | null;
  fillerCount: number;
  fillerAvgOverall: number | null;
  humanAvgOverall: number | null;
  positionCounts: Record<string, number>;
  positionShareDelta: Record<string, number>;
  salaryDriftIndex: number | null;
}

export interface AdminAnalyticsAgeBucket {
  label: string;
  realCount: number;
  realShare: number;
  projectedShare: number;
}

export interface AdminAnalyticsPopulationFlow {
  seasonId: number;
  seasonKey: string;
  retirees: number;
  promotions: number;
  seasonalIntakeGenerated: number;
  replacementsGenerated: number;
}

export interface AdminAnalytics {
  seasonId: number;
  totalDivisions: number;
  divisions: AdminAnalyticsDivision[];
  summary: {
    divisionCount: number;
    clubCount: number;
    humanCount: number;
    realAvgOverall: number | null;
    projectedAvgOverall: number | null;
    clubsInFinancialDistress: number;
    realSeniorCount: number;
    projectedSeniorCount: number;
    realYouthCount: number;
    projectedYouthCount: number;
    clubsBelowSquadFloor: number;
    overallStdDev: number | null;
    salaryDriftIndex: number | null;
  };
  ageDistribution: AdminAnalyticsAgeBucket[];
  freeAgentPool: {
    activeCount: number;
    avgAge: number | null;
    avgOverall: number | null;
    avgListedValue: number | null;
  };
  population: {
    history: AdminAnalyticsPopulationFlow[];
    currentSeason: AdminAnalyticsPopulationFlow | null;
  };
}

/** Admin club moderation context (GET /api/admin/clubs/:id). */
export interface AdminClubDetail {
  id: number;
  name: string;
  shortName: string;
  stadiumName: string;
  competitionState: string;
  country: string;
  ownerUserId: number | null;
  ownerUsername: string | null;
  ownerBannedAt: string | null;
  cash: number;
  financialCushion: number;
  hasCustomLogo: boolean;
  division: { id: number; name: string; tier: number; groupIndex: number } | null;
  squadSize: number;
  avgOverall: number | null;
  nicknamedPlayers: { id: number; name: string; nickname: string }[];
}

export interface Snapshot {
  save: {
    year: number;
    dayIndex: number;
    seasonDays: number;
    seasonDayIndex: number;
    phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
    interseasonAfterMatchDays: number;
    interseasonBeforeNextSeasonDays: number;
    lastLeagueMatchDayIndex: number;
    interseasonStartIndex: number;
    preparationStartIndex: number;
  };
  seasonSummary: {
    leagueChampion: string | null;
    leagueRunnerUp: string | null;
    /** IDs so clients can link the champion/runner-up to the team screen. */
    leagueChampionId: number | null;
    leagueRunnerUpId: number | null;
  } | null;
  club: ClubView | null;
  nextFixture: { id: number; home: string; away: string; homeClubId: number; awayClubId: number; dayIndex: number; isHome: boolean; kickoffAt: number | null } | null;
  formationOptions: Array<{ id: number; name: string }>;
  competitions: { id: number; kind: string; name: string; stage: string; round: number; tier: number | null; groupIndex: number | null; position: number; winnerId: number | null }[];
  squad: PlayerView[];
  juniors: PlayerView[];
  loanedOut: PlayerView[];
  news: NewsItemView[];
  auctions: AuctionView[];
  freeAgents: PlayerView[];
  records: CareerRecord[];
  seasonAwards: SeasonAward[];
}

export interface PyramidResponse { seasonKey: string | null; tiers: PyramidTier[]; myDivisionId?: number | null }

/** One structured fact inside a grouped news message. */
export interface NewsEntryView {
  key?: string;
  label?: string | import("@server-i18n/catalog").MessageRef;
  detail?: string | import("@server-i18n/catalog").MessageRef;
}

/** News item as served by the dashboard snapshot. */
export interface NewsItemView {
  id?: number;
  dayIndex: number;
  text: string;
  kind: string;
  /** Locale-independent body (frame key or direct ref); absent on legacy rows. */
  body?: import("@server-i18n/catalog").MessageRef;
  headline?: string;
  subject?: string;
  entries?: NewsEntryView[];
  recipientClubId?: number;
}

/** Public identity block of the team screen (GET /api/mp/clubs/:id). */
export interface TeamClubIdentity {
  id: number;
  name: string;
  shortName: string;
  country: string;
  stadiumName: string;
  primaryColor: string;
  secondaryColor: string;
  kits: ClubKits;
  logoVariant: number;
  hasCustomLogo: boolean;
  coachName: string;
  isHuman: boolean;
  competitionState: string;
}

export interface TeamSeasonSummary {
  seasonNumber: number | null;
  division: { id: number; name: string; tier: number; groupIndex: number };
  position: number | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

/** One archived season in a club's history timeline (movement derived from
 *  consecutive recorded tiers; tier 1 is strongest). */
export interface TeamHistoryRow {
  seasonKey: string;
  divisionName: string;
  tier: number;
  position: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  champion: boolean;
  promoted: boolean;
  relegated: boolean;
}

/** Minimal player row for the team-screen squad list (nickname quoted client-side). */
export interface TeamPlayerRow {
  id: number;
  name: string;
  nickname: string | null;
  naturalPosition: string;
  overall: number;
  age: number;
  country: string;
  isYouth: boolean;
  /** Loaned into the viewed club (colour-coded on the public squad list). */
  onLoan?: boolean;
  /** Always false on the public list (loaned-out players live elsewhere). */
  onLoanOut?: boolean;
  loanClubName?: string | null;
  loanFromName?: string | null;
}

/** Full team-screen payload. Public identity, competitive results, squad
 *  digest and aggregate value — never salaries, contracts or Elo of another
 *  manager's club. */
export interface TeamProfile {
  club: TeamClubIdentity;
  footmaniaRank: number | null;
  trophies: Record<string, number>;
  /** Squad market value plus cash balance. */
  totalValue: number;
  players: TeamPlayerRow[];
  season: TeamSeasonSummary | null;
  standings: StandingsRow[];
  fixtures: FixtureView[];
  history: TeamHistoryRow[];
}

export interface CareerRecord {
  category: string;
  value: number;
  holderName: string;
}

/** One Best XI member of a best_xi award, resolved by the server. */
export interface SeasonAwardEntry {
  id: number | null;
  clubId: number | null;
  name: string;
  /** False once the player has left the world (retired/deleted): render as
   *  plain text instead of a player-card link. */
  active: boolean;
}

export interface SeasonAward {
  season: number;
  category: string;
  competitionId: number | null;
  playerId: number | null;
  clubId: number | null;
  playerNameSnapshot: string | null;
  detail: string | null;
  /** Best XI members (best_xi rows only), parsed server-side. */
  entries?: SeasonAwardEntry[] | null;
}

export interface FootmaniaRankingEntry {
  rank: number;
  clubId: number;
  name: string;
  shortName: string;
  country: string;
  primaryColor: string;
  secondaryColor: string;
  kit?: KitDesign | null;
  hasCustomLogo?: boolean;
}

export interface FootmaniaRankingResponse {
  rankings: FootmaniaRankingEntry[];
  totalRanked: number;
  viewerRank: number | null;
}

export interface LoanView {
  id: number;
  playerId: number;
  fromClubId: number;
  toClubId: number | null;
  startDay: number;
  endDay: number;
  recalled: boolean;
  feeAmount?: number;
  listedAt: number;
  claimableAt: number;
  player: PlayerView | null;
  fromClub: string;
  toClub: string | null;
  available: boolean;
  claimableIn: number;
}

export interface FinanceDetails {
  records: CareerRecord[];
  awards: SeasonAward[];
}

export interface LedgerEntry {
  code: number;
  amount: number;
  day: number;
  label: string;
}

/** Financial snapshot for the club (financial-control §55). */
export interface FinanceSnapshot {
  activeBidCommitments: number;
  remainingSalaryCommitments: number;
  contingentSalary: number;
  financialCushion: number;
  immediateAvailableCash: number;
  remainingSeasonFraction: number;
  status: "SAFE" | "AT_RISK" | "NEGATIVE_CASH";
  nextPayroll: number | null;
}

export interface AuctionView {
  id: number;
  playerId: number;
  playerName: string;
  overall: number;
  naturalPosition: string;
  age: number;
  salary: number;
  skills: SkillSet;
  value: number;
  openingPrice: number;
  currentPrice: number;
  bidIncrement: number;
  bidderCount: number;
  sellerClubId: number;
  sellerName: string;
  deadline: number;
  originalDeadline: number;
  status: string;
  completedAt: number | null;
  winningClubId: number | null;
  finalPrice: number | null;
  contractDemandsBySeason: Record<number, number>;
  myMaxBid: number | null;
  myContractSeasons: number | null;
  myContractSalary: number | null;
  amILeading: boolean;
}

export interface FreeAgentView {
  id: number;
  playerId: number;
  playerName: string;
  overall: number;
  naturalPosition: string;
  age: number;
  salary: number;
  contractDays: number;
  salaryBaseline: number;
  contractDemandsBySeason: Record<number, number>;
  skills: SkillSet;
  value: number;
  openingPrice: number;
  currentPrice: number;
  bidIncrement: number;
  bidderCount: number;
  deadline: number;
  relistStage: number;
  status: string;
  myMaxBid: number | null;
  myContractSeasons: number | null;
  myContractSalary: number | null;
  amILeading: boolean;
}

export interface LivePlayer {
  id: number;
  name: string;
  displayName?: string;
  nickname?: string | null;
  naturalPosition: string;
  slotIndex: number | null;
  deployedRole: string | null;
  /** Squad shirt number shown on the pitch marker. */
  number?: number | null;
  overall: number;
  energy: number;
  injuryDays: number;
  injuryDaysRemaining?: number;
  injuryCause?: "MATCH" | "TRAINING" | null;
  injuryUntilAbsoluteGameDay?: number | null;
  conditionLabel?: string;
  suspended: boolean;
}

export interface LivePlayerScore {
  playerId: number;
  clubId: number;
  goals: number;
  assists: number;
  score: number;
  won: boolean;
  minutes: number;
  name?: string;
  /** Coarse deployed role (live ratings). */
  role?: string;
  /** True when this is a live rating row, not a legacy points score. */
  live?: boolean;
  /** 3.0–10.0 rating; null before 10 match-minutes (NR). */
  rating?: number | null;
}

export interface LiveEvent {
  sequence?: number;
  minute: number;
  half: number;
  type: number;
  subtype: number;
  clubId: number;
  playerId?: number | null;
  player2Id?: number | null;
  player: string;
  player2: string;
  addedTime?: number | null;
  /** Injury events carry the estimated days out here. */
  goalType?: number;
}

/**
 * A player missing from the pitch with cause: sent off (RED) or injured while
 * no substitution slot/candidate remained (INJURY). Auto-subbed injuries do
 * not appear — their SUB event removes them from the projection.
 */
export interface LiveMissingPlayer {
  side: 0 | 1;
  playerId: number;
  name: string;
  number?: number | null;
  kind: "INJURY" | "RED";
  slotIndex: number | null;
  deployedRole: string | null;
}

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

export interface LiveTactics {
  style: number;
  pressing: number;
  direction: number;
}

/** Server-computed plans/6 §17 switch-transfer projection for one setup. */
export interface TacticProjection {
  style: number;
  pressing: number;
  direction: number;
  familiarity: number;
}

/** Tactics view as delivered by the live-state API (request payload plus the
 *  server-supplied familiarity fields). */
export interface LiveTacticsView extends LiveTactics {
  /** In-match familiarity with this side's current setup. */
  familiarity: number;
  projections: TacticProjection[];
}

export interface LiveBallAction {
  sequence: number;
  action: string;
  outcome: string;
  side: 0 | 1;
  fromZone: string;
  toZone: string | null;
  fromPlayerId: number | null;
  targetPlayerId: number | null;
  interceptorId: number | null;
  foulerId: number | null;
}

/** Possession projection for the live pitch ball (see backend liveView.ts). */
export interface LiveBall {
  /** Possessing team index: 0 = home, 1 = away. */
  side: 0 | 1;
  zone: string;
  phase: string;
  startType: string;
  counter: boolean;
  /** Stable on-pitch carrier selected by the simulator for rendering. */
  carrierId?: number | null;
  /** Last resolved possession action + zone it started from; drives turnover
   *  intent lines. Null on matches started before the engine tracked them. */
  lastAction?: string | null;
  prevZone?: string | null;
  lastBallAction?: LiveBallAction | null;
}

export interface LiveState {
  matchId: number;
  fixtureId: number;
  competitionId: number;
  competitionName: string;
  competitionKind: string;
  seasonNumber: number | null;
  divisionTier: number | null;
  groupNumber: number | null;
  roundNumber: number | null;
  stadiumName: string;
  dayIndex: number;
  homeClubId: number;
  awayClubId: number;
  home: string;
  away: string;
  homeKit: KitDesign;
  awayKit: KitDesign;
  homeGkKit: KitDesign;
  awayGkKit: KitDesign;
  homeScore: number;
  awayScore: number;
  minute: number;
  half: number;
  phase: "pregame" | "first" | "halftime" | "second" | "et1" | "et2" | "shootout" | "fulltime";
  extraTime: boolean;
  ended: boolean;
  shootout: { scores: [number, number]; winner: string } | null;
  stats: MatchStats;
  events: LiveEvent[];
  /** Per-player MVP scores (goals*2 + assists + win bonus) for the current
   *  match state; only players with pitch minutes appear. */
  scores?: LivePlayerScore[];
  homeOn: LivePlayer[];
  awayOn: LivePlayer[];
  homeBench: LivePlayer[];
  awayBench: LivePlayer[];
  usedSubs: [number, number];
  humanSide: 0 | 1;
  /** True when the viewer's own club is playing; spectators get read-only UI. */
  isParticipant?: boolean;
  homeManager: string;
  awayManager: string;
  homeFormation: string;
  awayFormation: string;
  homeFormationId: number;
  awayFormationId: number;
  homeFormationSlots?: Array<{ index: number; key: string; role: string; lane: string; line: string; x: number; y: number; label: string }>;
  awayFormationSlots?: Array<{ index: number; key: string; role: string; lane: string; line: string; x: number; y: number; label: string }>;
  homeTactics: LiveTacticsView;
  awayTactics: LiveTacticsView;
  /** Live-match tactics lock: match-minutes remaining per side (0 = unlocked). */
  homeTacticsCooldownMinutes: number;
  awayTacticsCooldownMinutes: number;
  automationDisabled?: [boolean, boolean];
  automationFiredCount?: number;
  progressPct: number;
  coinTossWinner: 0 | 1;
  firstHalfAddedMinutes: number;
  secondHalfAddedMinutes: number;
  halftimeStartedAt: number | null;
  halftimeReady: [boolean, boolean];
  halftimePauseMinutes: number;
  currentAddedTime?: number | null;
  homeIsHuman: boolean;
  awayIsHuman: boolean;
  /** Players absent from the pitch (red cards; unreplaced injuries). */
  missingPlayers?: LiveMissingPlayer[];
  ball?: LiveBall;
}

export interface LiveStateDelta {
  matchId: number;
  minute: number;
  half: number;
  phase: LiveState["phase"];
  homeScore: number;
  awayScore: number;
  stats: MatchStats;
  newEvents: LiveEvent[];
  automationFiredCount: number;
  progressPct: number;
  currentAddedTime: number | null;
  homeTacticsCooldownMinutes: number;
  awayTacticsCooldownMinutes: number;
  homeOn: LivePlayer[];
  awayOn: LivePlayer[];
  homeBench: LivePlayer[];
  awayBench: LivePlayer[];
  usedSubs: [number, number];
  /** Per-player MVP scores for the current state (updates as goals/assists
   *  happen so the live Scores tab stays fresh). */
  scores?: LivePlayerScore[];
  /** Full missing-player snapshot each delta. */
  missingPlayers?: LiveMissingPlayer[];
  ball?: LiveBall;
}

export interface LineupPlayer {
  id: number;
  name: string;
  naturalPosition: string;
  overall: number;
  energy: number;
  injuryDays: number;
  suspended: boolean;
  slotIndex?: number | null;
  deployedRole?: string | null;
  rolePenalty?: number | null;
  suitabilityLabel?: string | null;
  adjustedTacticalRating?: number | null;
  /** Squad shirt number shown on the lineup board jersey marker. */
  number?: number | null;
}

export interface LineupView {
  formation: number;
  /** §15.3: the formation's authoritative slot metadata, in slot order. */
  slots: Array<{ index: number; key: string; role: string; lane: string; line: string; x: number; y: number; label: string }>;
  starters: (LineupPlayer | null)[];
  subs: (LineupPlayer | null)[];
  penaltyTakerId: number | null;
  freeKickTakerId: number | null;
  squad: { id: number; name: string; naturalPosition: string; overall: number; energy: number; slotIndex?: number | null; deployedRole?: string | null; injuryDays: number; suspended: boolean; number?: number | null }[];
  slotPreviews?: Array<{ slotIndex: number; deployedRole: string; rolePenalty: number | null; suitabilityLabel: string; adjustedTacticalRating: number | null }>;
  previewPlayerId?: number | null;
}

export interface MatchEvents {
  match: {
    id: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    /** Detailed stats are a Pro feature; null for regular users. */
    stats: MatchStats | null;
    /** MVP award (best performer on the winning team); null when none. */
    mvpPlayerId?: number | null;
    mvpPlayerName?: string | null;
    mvpClubId?: number | null;
  };
  events: LiveEvent[];
  /** Per-player MVP scores for the finished match (only players with minutes). */
  scores?: LivePlayerScore[];
}

export interface Settings {
  matchDurationMinutes: number;
  maxContractSeasons?: number;
  seniorSquadLimit?: number;
  academyVoluntaryPromotionAge?: number;
  academyAutomaticPromotionAge?: number;
  pregameWindowMinutes?: number;
}

// --- In-flight dedupe + TTL cache for GET requests ---
// Prevents redundant network round-trips when multiple components mount concurrently
// (e.g. navigating between tabs) and avoids a fresh fetch per render cycle.
// Auth, live-match, and mutation responses are never cached.

type CacheEntry = {
  data: unknown;
  expiresAt: number;
  staleUntil: number;
};

const CACHE_TTL_MS = 30_000;
const CACHE_STALE_WINDOW_MS = 120_000;
const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;
type CacheListener = (scope?: string) => void;
const cacheListeners = new Set<CacheListener>();
const marketUpdateListeners = new Set<(event: MarketUpdate) => void>();

// Auth endpoints, live match info, match live state, and settings are never
// cached. `matches/:id/events` is intentionally excluded from this list: for
// a finished (immutable) match its response never changes, so it can safely
// flow through the normal GET cache — only the genuinely-live endpoints
// (live state, subs, halftime, the WS handshake path) need to bypass it.
// Player history is also never cached: the card it feeds must reflect a goal
// scored in an in-progress live match (and the full-time commit right after).
const NEVER_CACHE = /^api\/(auth|account|mp\/live-match$|matches\/.*\/(live|sub|halftime|ws)|settings|players\/.*\/history)/;

function shouldCache(url: string): boolean {
  const path = url.split("?", 1)[0].replace(/^\//, "");
  return !NEVER_CACHE.test(path);
}

function notifyCacheListeners(scope?: string): void {
  for (const listener of cacheListeners) listener(scope);
}

function cacheScopeForUrl(url: string): string {
  const path = url.split("?", 1)[0];
  if (path.startsWith("/api/transfers")) return "transfers";
  if (path.startsWith("/api/mp/club") || path.startsWith("/api/mp/status") || path.startsWith("/api/club/")) return "club";
  if (path.startsWith("/api/history")) return "history";
  if (path.startsWith("/api/notifications")) return "notifications";
  return "mp";
}

export const cache = {
  /** Drop all cached GET responses so subsequent requests hit the network. */
  clear: () => {
    cacheGeneration++;
    responseCache.clear();
    inFlight.clear();
    notifyCacheListeners();
  },
  /** Drop only cached entries whose key starts with `scope` (e.g. "/api/mp/club"). */
  invalidate: (scope?: string) => {
    if (!scope) {
      cacheGeneration++;
      responseCache.clear();
      inFlight.clear();
      notifyCacheListeners();
      return;
    }
    cacheGeneration++;
    const prefixes = scope.startsWith("/")
      ? [scope]
      : scope === "club"
        ? ["/api/mp/club", "/api/mp/status", "/api/club/"]
        : [`/api/${scope}`];
    for (const key of responseCache.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) responseCache.delete(key);
    }
    for (const key of inFlight.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) inFlight.delete(key);
    }
    notifyCacheListeners(scope);
  },
  subscribe: (listener: CacheListener) => {
    cacheListeners.add(listener);
    return () => {
      cacheListeners.delete(listener);
    };
  },
  emitMarketUpdated: (event: MarketUpdate) => {
    for (const listener of marketUpdateListeners) listener(event);
  },
  subscribeMarketUpdated: (listener: (event: MarketUpdate) => void) => {
    marketUpdateListeners.add(listener);
    return () => {
      marketUpdateListeners.delete(listener);
    };
  },
  get<T>(key: string): T | undefined {
    const entry = responseCache.get(key);
    if (!entry || Date.now() >= entry.staleUntil) {
      responseCache.delete(key);
      return undefined;
    }
    return entry.data as T;
  },
  peek<T>(key: string): { data: T; fresh: boolean } | undefined {
    const entry = responseCache.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (now >= entry.staleUntil) {
      responseCache.delete(key);
      return undefined;
    }
    return { data: entry.data as T, fresh: now < entry.expiresAt };
  },
  set(key: string, data: unknown, ttlMs = CACHE_TTL_MS, notifyScope?: string): void {
    const now = Date.now();
    responseCache.set(key, { data, expiresAt: now + ttlMs, staleUntil: now + ttlMs + CACHE_STALE_WINDOW_MS });
    if (notifyScope) notifyCacheListeners(notifyScope);
  },
};

async function rawFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const res = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const isGet = method === "GET";

  // Mutations bypass cache and invalidate only affected read models. The server
  // WebSocket may issue a more precise follow-up invalidation after the write.
  if (!isGet) {
    const result = await rawFetch<T>(url, options);
    const path = url.split("?", 1)[0];
    if (path.startsWith("/api/transfers")) {
      cache.invalidate("transfers");
      cache.invalidate("club");
    } else if (path.startsWith("/api/mp")) {
      cache.invalidate("mp");
      cache.invalidate("club");
    } else if (path.startsWith("/api/club") || path.startsWith("/api/players")) {
      cache.invalidate("club");
    } else if (path.startsWith("/api/notifications")) {
      cache.invalidate("notifications");
    } else if (path.startsWith("/api/admin")) {
      cache.invalidate("admin");
    }
    return result;
  }

  // GET requests that should never be cached (auth, live, etc.):
  if (!shouldCache(url)) {
    return rawFetch<T>(url, options);
  }

  const key = url;

  // 1. Return cached data immediately. Stale entries are revalidated in the
  // background so navigation never waits for a refresh.
  const cached = cache.peek<T>(key);
  if (cached) {
    if (!cached.fresh && !inFlight.has(key)) {
      const generation = cacheGeneration;
      const refresh = rawFetch<T>(url, options);
      inFlight.set(key, refresh);
      void refresh
        .then((data) => {
           if (generation === cacheGeneration) cache.set(key, data, CACHE_TTL_MS, `background:${cacheScopeForUrl(key)}`);
        })
        .catch(() => undefined)
        .finally(() => inFlight.delete(key));
    }
    return cached.data;
  }

  // 2. Dedupe: if an identical GET is already in-flight, reuse its promise.
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // 3. Otherwise start a new request and track it for dedupe.
  const promise = rawFetch<T>(url, options);
  const generation = cacheGeneration;
  inFlight.set(key, promise);
  try {
    const data = await promise;
    if (generation === cacheGeneration) cache.set(key, data);
    return data;
  } catch (e) {
    // Don't cache errors; let the next caller retry.
    throw e;
  } finally {
    inFlight.delete(key);
  }
}

export const api = {
  cache,
  rawFetch,
  mpWsUrl: () =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/mp/ws`,
  me: () => request<{ user: User }>("/api/account/me"),
  updateLocale: (locale: NonNullable<User["locale"]>) =>
    request<{ ok: boolean; locale: NonNullable<User["locale"]> }>("/api/account/me/locale", { method: "PUT", body: JSON.stringify({ locale }) }),
  logout: () => request<{ ok: boolean }>("/api/account/logout", { method: "POST" }),
  acceptInvite: (token: string) =>
    request<{ ok: boolean }>("/api/account/invite/accept", { method: "POST", body: JSON.stringify({ token }) }),

  // Friends & invitations (plan 9)
  friends: () => request<{ friends: { userId: number; name: string; clubId: number | null; clubName: string | null; competitionState: string | null; since: string }[] }>("/api/account/friends"),
  removeFriend: (userId: number) =>
    request<{ ok: boolean }>(`/api/account/friends/${userId}`, { method: "DELETE" }),
  invitations: () => request<{ invitations: { token: string; createdAt: string }[] }>("/api/account/invitations"),
  createInvitation: () => request<{ inviteToken: string }>("/api/account/invite", { method: "POST" }),
  revokeInvitation: (token: string) =>
    request<{ ok: boolean }>(`/api/account/invitations/${token}`, { method: "DELETE" }),

  // Multiplayer
  mpStatus: () => request<MpStatus>("/api/mp/status"),
  publicSeasonStatus: () => request<PublicSeasonStatus>("/api/public/season"),
  join: (payload: { clubName: string; country: string; primaryColor?: string; secondaryColor?: string; kits?: ClubKits; stadiumName: string; coachName: string; preferredHours?: number[] }) =>
    request<{ ok: boolean; clubId: number }>("/api/mp/join", { method: "POST", body: JSON.stringify(payload) }),
  updateClubKit: (kits: ClubKits) =>
    request<{ ok: boolean; kits: ClubKits }>("/api/mp/club/kit", { method: "PUT", body: JSON.stringify({ kits }) }),
  updateClubProfile: (payload: { clubName?: string; stadiumName?: string; coachName?: string }) =>
    request<{ ok: boolean; name: string; stadiumName: string; coachName: string }>("/api/mp/club/profile", { method: "PUT", body: JSON.stringify(payload) }),
  updatePreferredHours: (preferredHours: number[]) =>
    request<{ ok: boolean; preferredHours: number[] }>("/api/mp/preferred-hours", { method: "PUT", body: JSON.stringify({ preferredHours }) }),
  updateFriendGrouping: (enabled: boolean) =>
    request<{ ok: boolean; friendGroupingOptIn: boolean }>("/api/mp/club/friend-grouping", { method: "PUT", body: JSON.stringify({ enabled }) }),
  returnClub: () =>
    request<{ ok: boolean }>("/api/mp/return", { method: "POST" }),
  practice: () =>
    request<{ homeGoals: number; awayGoals: number; events: number; opponentName: string }>("/api/mp/practice", { method: "POST" }),
  myClub: () => request<{ snapshot: Snapshot }>("/api/mp/club"),
  pyramid: () => request<PyramidResponse>("/api/mp/pyramid"),
  divisionStandings: (id: number) =>
    request<{ competition: { id: number; name: string; tier: number; groupIndex: number }; standings: StandingsRow[] }>(`/api/mp/divisions/${id}/standings`),
  divisionFixtures: (id: number) => request<{ fixtures: FixtureView[] }>(`/api/mp/divisions/${id}/fixtures`),
  teamProfile: (clubId: number) => request<TeamProfile>(`/api/mp/clubs/${clubId}`),
  countries: () => request<{ featuredCountries: CountryOption[]; allCountries: CountryOption[] }>("/api/mp/countries"),
  history: () => request<{ seasons: SeasonHistoryView[] }>("/api/mp/history"),
  footmaniaRanking: () => request<FootmaniaRankingResponse>("/api/mp/rankings/footmania"),

  liveMatchInfo: () => request<{ match: { id: number; home: string; away: string } | null }>("/api/mp/live-match"),

  matchEvents: (matchId: number) => request<MatchEvents>(`/api/matches/${matchId}/events`),
  liveState: (matchId: number) => request<{ state: LiveState }>(`/api/matches/${matchId}/live`),
  liveSub: (matchId: number, outId: number, inId: number) =>
    request<{ event: LiveEvent | null; state: LiveState }>(`/api/matches/${matchId}/sub`, { method: "POST", body: JSON.stringify({ outId, inId }) }),
  liveTactics: (matchId: number, tactics: LiveTactics) =>
    request<{ ok: boolean; state: LiveState }>(`/api/matches/${matchId}/tactics`, { method: "POST", body: JSON.stringify(tactics) }),
  halftimeReady: (matchId: number) =>
    request<{ ok: boolean; state: LiveState }>(`/api/matches/${matchId}/halftime/ready`, { method: "POST" }),
  liveWsUrl: (matchId: number) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/matches/${matchId}/ws`,
  getLineup: (auto?: boolean, formation?: number, previewPlayerId?: number) => {
    const params = new URLSearchParams();
    if (auto) params.set("auto", "1");
    if (formation !== undefined) params.set("formation", String(formation));
    if (previewPlayerId !== undefined) params.set("previewPlayerId", String(previewPlayerId));
    const query = params.toString();
    return request<LineupView>(`/api/club/lineup${query ? `?${query}` : ""}`);
  },
  setLineup: (lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean }>("/api/club/lineup", { method: "POST", body: JSON.stringify(lineup) }),
  setPlayerNumber: (playerId: number, number: number) =>
    request<{ ok: boolean; number: number | null; swappedWithName: string | null }>(`/api/players/${playerId}/number`, { method: "POST", body: JSON.stringify({ number }) }),
  matchLineup: (matchId: number, lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean; state?: LiveState }>(`/api/matches/${matchId}/lineup`, { method: "POST", body: JSON.stringify(lineup) }),
  sellPlayer: (playerId: number, openingPrice?: number) =>
    request<{ ok: boolean; listingId?: number; openingPrice?: number }>("/api/transfers/auctions", { method: "POST", body: JSON.stringify({ playerId, openingPrice }) }),
  listAuctions: () => request<{ auctions: AuctionView[] }>("/api/transfers/auctions"),
  listFreeAgents: () => request<{ signings: FreeAgentView[] }>("/api/transfers/free-agents"),
  bidFreeAgent: (listingId: number, maxBid: number, contractSeasons: number) =>
    request<{ ok: boolean; currentPrice: number; leading: boolean; contractSeasons: number; contractSalary: number }>(`/api/transfers/free-agents/${listingId}/bid`, { method: "POST", body: JSON.stringify({ maxBid, contractSeasons }) }),
  bidAuction: (listingId: number, maxBid: number, contractSeasons: number) =>
    request<{ ok: boolean; currentPrice: number; leading: boolean; contractSeasons: number; contractSalary: number }>(`/api/transfers/auctions/${listingId}/bid`, { method: "POST", body: JSON.stringify({ maxBid, contractSeasons }) }),
  cancelAuction: (listingId: number) =>
    request<{ ok: boolean }>(`/api/transfers/auctions/${listingId}/cancel`, { method: "POST" }),
  auctionPreview: (playerId: number) =>
    request<{
      playerId: number;
      value: number;
      baseValue: number;
      openingPriceRange: { min: number; max: number };
      cooldownError: string | null;
      alreadyListed: boolean;
    }>(
      `/api/transfers/auctions/preview?playerId=${playerId}`
    ),

  // `contractSeasons` = complete seasons beyond the remainder of the current
  // one, the same meaning the transfer and free-agent bid endpoints use.
  renewContract: (playerId: number, contractSeasons: number) =>
    request<{ ok: boolean; demand: number }>(`/api/players/${playerId}/contract`, { method: "POST", body: JSON.stringify({ contractSeasons }) }),
  setTrainingFocus: (focus: "assistant" | "primary" | "secondary") =>
    request<{ ok: boolean; trainingFocus: "assistant" | "primary" | "secondary" }>("/api/club/training", { method: "POST", body: JSON.stringify({ focus }) }),
  setTactics: (tactics: { style: number; pressing: number; direction: number }) =>
    request<{ ok: boolean }>("/api/club/tactics", { method: "POST", body: JSON.stringify(tactics) }),
  finances: () =>
    request<{ cash: number; income: LedgerEntry[]; expense: LedgerEntry[]; finance: FinanceSnapshot }>("/api/club/finances"),
  financeDetails: () => request<FinanceDetails>("/api/club/finance-details"),
  listLoans: () => request<{ loans: LoanView[] }>("/api/transfers/loans"),
  offerLoan: (playerId: number, feeRatio?: number) =>
    request<{ ok: boolean }>("/api/transfers/loans", { method: "POST", body: JSON.stringify(feeRatio !== undefined ? { playerId, feeRatio } : { playerId }) }),
  claimLoan: (loanId: number) =>
    request<{ ok: boolean }>(`/api/transfers/loans/${loanId}/claim`, { method: "POST" }),
  cancelLoan: (loanId: number) =>
    request<{ ok: boolean }>(`/api/transfers/loans/${loanId}/cancel`, { method: "POST" }),
  // Promotion takes NO contract term and NO salary offer: it is a status change
  // that preserves the player's existing academy deal exactly.
  academyAction: (playerId: number, action: "promote" | "dismiss") =>
    request<{ ok: boolean }>(`/api/players/${playerId}/academy`, { method: "POST", body: JSON.stringify({ action }) }),
  academyPromotionPreview: (playerId: number) =>
    request<{
      isYouth: boolean;
      age: number;
      voluntaryPromotionAge: number;
      automaticPromotionAge: number;
      contractEndAge: number;
      eligibleForVoluntaryPromotion: boolean;
      retainedSalary: number;
      retainedContractDays: number;
      retainedContractSeasons: number;
      seniorRosterError: string | null;
    }>(`/api/players/${playerId}/academy`),
  releasePlayer: (playerId: number) =>
    request<{ ok: boolean; cost: number }>(`/api/players/${playerId}/release`, { method: "POST" }),
  contractDemand: (playerId: number) =>
    request<{ demand: number; demandsBySeason: Record<number, number>; salary: number; contractDays: number }>(`/api/players/${playerId}/contract`),
  settings: () => request<Settings>("/api/settings"),

  // Admin (manual clock / settings)
  adminStatus: () =>
    request<{ world: { seasonKey: string; seasonStatus: string; completedRounds: number; joinState: string; joinLockRound: number; manualRound: number | null; realCompletedRounds: number; roundsPerSeason: number; divisionCount: number; clubCount: number; humanClubCount: number; liveMatchCount: number } | null }>("/api/admin/status"),
  adminAdvanceRound: (round: number) =>
    request<{ ok: boolean; from: number; to: number; joinState: string; joinLockRound: number }>("/api/admin/advance-round", { method: "POST", body: JSON.stringify({ round }) }),
  adminSetRound: (round: number) =>
    request<{ ok: boolean; manualRound: number }>("/api/admin/set-round", { method: "POST", body: JSON.stringify({ round }) }),
  adminClearManual: () =>
    request<{ ok: boolean }>("/api/admin/clear-manual", { method: "POST" }),
  adminSchedulerClock: () =>
    request<{ clock: SchedulerClockView }>("/api/admin/scheduler/clock"),
  adminSchedulerEvents: (filters?: { status?: string; type?: string; timeBasis?: string; entityType?: string; entityId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.type) params.set("type", filters.type);
    if (filters?.timeBasis) params.set("timeBasis", filters.timeBasis);
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const query = params.toString();
    return request<{ events: ScheduledEventView[] }>(`/api/admin/scheduler/events${query ? `?${query}` : ""}`);
  },
  adminSchedulerEvent: (eventId: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/events/${eventId}`),
  adminSchedulerAdvanceDay: (reason?: string) =>
    request<{ clock: SchedulerClockView }>("/api/admin/scheduler/day/advance", { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerAdvanceMany: (days: number, reason?: string) =>
    request<{ clock: SchedulerClockView }>("/api/admin/scheduler/day/advance-many", { method: "POST", body: JSON.stringify({ days, reason }) }),
  adminSchedulerForceAdvance: (reason: string) =>
    request<{ clock: SchedulerClockView }>("/api/admin/scheduler/day/force-advance", { method: "POST", body: JSON.stringify({ confirmation: "FORCE", reason }) }),
  adminSchedulerScan: () =>
    request<{ executed: number }>("/api/admin/scheduler/scan", { method: "POST" }),
  adminSchedulerExecuteEvent: (eventId: string, reason?: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/events/${eventId}/execute`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerRetryEvent: (eventId: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/events/${eventId}/retry`, { method: "POST" }),
  adminSchedulerCancelEvent: (eventId: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/events/${eventId}/cancel`, { method: "POST" }),
  adminSchedulerRollover: (reason: string) =>
    request<{ season: { seasonId: number; year: number; month: number } }>("/api/admin/scheduler/rollover", { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerMatches: () =>
    request<{ matches: SchedulerMatchView[] }>("/api/admin/scheduler/matches"),
  adminSchedulerStartMatch: (matchId: number, reason?: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/matches/${matchId}/start`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerResolveMatch: (matchId: number, reason?: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/matches/${matchId}/resolve`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerAuctions: () =>
    request<{ auctions: SchedulerAuctionView[] }>("/api/admin/scheduler/auctions"),
  adminSchedulerEndAuction: (auctionId: number, reason?: string) =>
    request<{ event: ScheduledEventView }>(`/api/admin/scheduler/auctions/${auctionId}/end`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerExtendAuction: (auctionId: number, minutes: number, reason?: string) =>
    request(`/api/admin/scheduler/auctions/${auctionId}/extend`, { method: "POST", body: JSON.stringify({ minutes, reason }) }),
  adminSchedulerAudit: () =>
    request<{ audit: SchedulerAuditView[] }>("/api/admin/scheduler/audit?limit=100"),
  adminSchedulerPreview: (seasonId: number) =>
    request<{ seasonId: number; season: SchedulerPreviewEntry[] }>(`/api/admin/scheduler/season/${seasonId}`),
  // Season pause / resume (freeze timers; resume shifts every real-time anchor).
  adminSchedulerPause: (reason?: string) =>
    request<{ pausedAt: number }>("/api/admin/scheduler/pause", { method: "POST", body: JSON.stringify({ reason }) }),
  adminSchedulerResume: (reason?: string) =>
    request<{ resumedAt: number; shiftMs: number }>("/api/admin/scheduler/resume", { method: "POST", body: JSON.stringify({ reason }) }),
  // Rebuild the current season's schedules — only before any match has been played.
  adminRecalculateFixtures: (reason: string) =>
    request<{ ok: boolean; divisions: number; fixturesBefore: number; fixturesAfter: number }>("/api/admin/scheduler/fixtures/recalculate", { method: "POST", body: JSON.stringify({ reason }) }),
  // Destructive: wipes the world, keeps user accounts. Requires typed confirmation.
  adminWorldReset: (confirmation: "RESET", reason: string, keepIdentity?: boolean) =>
    request<{ ok: boolean; oldSaveId: number; newSaveId: number; seasonId: number; archivedClubs?: number }>("/api/admin/world/reset", { method: "POST", body: JSON.stringify({ confirmation, reason, keepIdentity }) }),

  // Pro features
  getAutomation: () => request<{ presets: unknown[] }>("/api/mp/automation"),
  setAutomation: (presets: unknown[]) => request<{ ok: boolean; presets: unknown[] }>("/api/mp/automation", { method: "PUT", body: JSON.stringify({ presets }) }),
  updateLogoVariant: (variant: number) => request<{ ok: boolean; logoVariant: number }>("/api/mp/club/logo-variant", { method: "PUT", body: JSON.stringify({ variant }) }),
  uploadCustomLogo: (mime: string, data: string) => request<{ ok: boolean }>("/api/mp/club/logo", { method: "POST", body: JSON.stringify({ mime, data }) }),
  deleteCustomLogo: () => request<{ ok: boolean }>("/api/mp/club/logo", { method: "DELETE" }),
  nicknamePlayer: (playerId: number, nickname: string | null) => request<{ ok: boolean; nickname: string | null; displayName: string }>(`/api/mp/players/${playerId}/nickname`, { method: "PUT", body: JSON.stringify({ nickname }) }),
  playerHistory: (playerId: number) => request<PlayerHistoryResponse>(`/api/players/${playerId}/history`),
  marketPlayerHistory: (listingId: number, marketType: "TRANSFER" | "FREE_AGENT") => request<{ player: PlayerView & { displayName: string }; seasons: unknown[]; transfers: unknown[]; matches: unknown[] }>(`/api/market/listings/${listingId}/player-history?marketType=${marketType}`),

  // Notifications & push
  listNotifications: (limit?: number, unread?: boolean) => request<{ notifications: { id: string; type: string; payload: unknown; createdAt: string; readAt: string | null }[] }>(`/api/notifications${limit ? `?limit=${limit}` : ""}${unread ? `${limit ? "&" : "?"}unread=1` : ""}`),
  markNotificationRead: (id: string) => request<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => request<{ ok: boolean }>("/api/notifications/read-all", { method: "POST" }),
  getVapidKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),
  pushSubscribe: (endpoint: string, p256dh: string, auth: string) => request<{ ok: boolean }>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint, p256dh, auth }) }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),

  // Warnings (own)
  myWarnings: () => request<{ warnings: { id: number; reason: string; createdAt: string; acknowledgedAt: string | null }[] }>("/api/account/warnings"),
  ackWarning: (id: number) => request<{ ok: boolean }>(`/api/account/warnings/${id}/acknowledge`, { method: "POST" }),

  // Admin user management
  adminListUsers: (search?: string, limit?: number) => request<{ users: { id: number; name: string; email: string; isAdmin: boolean; isPro: boolean; elo: number | null; bannedAt: string | null; banReason: string | null; createdAt: string; club: { id: number; name: string; competitionState: string } | null }[] }>(`/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ""}${limit ? `${search ? "&" : "?"}limit=${limit}` : ""}`),
  adminSetPro: (userId: number, isPro: boolean) => request<{ ok: boolean }>(`/api/admin/users/${userId}/pro`, { method: "POST", body: JSON.stringify({ isPro }) }),
  adminBanUser: (userId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/users/${userId}/ban`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminUnbanUser: (userId: number) => request<{ ok: boolean }>(`/api/admin/users/${userId}/unban`, { method: "POST" }),
  adminWarnUser: (userId: number, reason: string) => request<{ ok: boolean; warningId: number }>(`/api/admin/users/${userId}/warn`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminListUserWarnings: (userId: number) => request<{ warnings: { id: number; reason: string; issuedByAdminUserId: number; createdAt: string; acknowledgedAt: string | null }[] }>(`/api/admin/users/${userId}/warnings`),
  adminDeleteUser: (userId: number, confirmation: "DELETE", reason: string) => request<{ ok: boolean }>(`/api/admin/users/${userId}/delete`, { method: "POST", body: JSON.stringify({ confirmation, reason }) }),
  adminResetClubName: (clubId: number, name: string | undefined, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/reset-club-name`, { method: "POST", body: JSON.stringify({ clubId, ...(name ? { name } : {}), reason }) }),
  adminResetStadiumName: (clubId: number, stadiumName: string, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/reset-stadium-name`, { method: "POST", body: JSON.stringify({ clubId, stadiumName, reason }) }),
  adminClearNickname: (playerId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/clear-nickname`, { method: "POST", body: JSON.stringify({ playerId, reason }) }),
  adminRemoveLogo: (clubId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/remove-logo`, { method: "POST", body: JSON.stringify({ clubId, reason }) }),

  // Admin analytics / world browsing / MOTD
  adminAnalytics: () => request<{ analytics: AdminAnalytics | null }>("/api/admin/analytics"),
  adminClubDetail: (clubId: number) => request<{ club: AdminClubDetail }>(`/api/admin/clubs/${clubId}`),
  adminSuggestedClubName: (attempt = 0) => request<{ name: string }>(`/api/admin/suggested-club-name?attempt=${attempt}`),
  adminGetMotd: () => request<{ messages: { dayIndex: number; text: string }[] }>("/api/admin/motd"),
  adminPostMotd: (text: string) => request<{ ok: boolean; text: string; dayIndex: number }>("/api/admin/motd", { method: "POST", body: JSON.stringify({ text }) }),
  adminDeleteMotdMessage: (dayIndex: number, text: string) => request<{ ok: boolean; removed: number }>(`/api/admin/motd/message?dayIndex=${dayIndex}&text=${encodeURIComponent(text)}`, { method: "DELETE" }),
  adminDeleteMotd: () => request<{ ok: boolean; removed: number }>("/api/admin/motd", { method: "DELETE" }),
};
