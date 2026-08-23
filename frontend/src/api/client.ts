export interface User {
  id: number;
  username: string;
  isAdmin?: boolean;
  isPro?: boolean;
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
  vel: number;
  tec: number;
  pas: number;
  des: number;
  arm: number;
  fin: number;
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
  position: number;
  positionName: string;
  tacPos: number;
  tacPosName: string;
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
  seasonGoals: number;
  seasonAssists: number;
  careerGoals: number;
  careerAssists: number;
  yellows: number;
  reds: number;
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
  tactics: { formation: number; style: number; pressing: number; direction: number; formationName: string; styleName: string; pressingName: string; directionName: string } | null;
  trophies: Record<string, number>;
  ledger: { income: LedgerEntry[]; expense: LedgerEntry[] };
  finance?: { activeBidCommitments: number; remainingSalaryCommitments: number; contingentSalary: number; immediateAvailableCash: number; remainingSeasonFraction: number; financialCushion: number; status: "SAFE" | "AT_RISK" | "NEGATIVE_CASH" };
}

export interface MpStatus {
  ready: boolean;
  saveId: number | null;
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
    isHome: boolean;
    played: boolean;
    goalsFor: number | null;
    goalsAgainst: number | null;
  }[];
  userClubId: number | null;
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
}

export interface AdminAnalytics {
  seasonId: number;
  totalDivisions: number;
  divisions: AdminAnalyticsDivision[];
  summary: {
    divisionCount: number;
    clubCount: number;
    realAvgOverall: number | null;
    projectedAvgOverall: number | null;
    clubsInFinancialDistress: number;
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
    dateLabel: string;
    dayOfWeek: string;
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
  } | null;
  club: ClubView | null;
  nextFixture: { id: number; home: string; away: string; dayLabel: string; dayIndex: number; isHome: boolean; kickoffAt: number | null } | null;
  competitions: { id: number; kind: string; name: string; stage: string; round: number; tier: number | null; groupIndex: number | null; position: number; winnerId: number | null }[];
  squad: PlayerView[];
  juniors: PlayerView[];
  loanedOut: PlayerView[];
  news: { dayIndex: number; dayLabel: string; text: string; kind: string }[];
  auctions: AuctionView[];
  freeAgents: PlayerView[];
  records: CareerRecord[];
  seasonAwards: SeasonAward[];
}

export type PyramidResponse = { seasonKey: string | null; tiers: PyramidTier[]; myDivisionId?: number | null };

export interface CareerRecord {
  category: string;
  value: number;
  holderName: string;
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
  position: number;
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
  position: number;
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
  position: number;
  tacPos: number;
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
  dateLabel: string;
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
  homeTactics: LiveTactics;
  awayTactics: LiveTactics;
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
}

export interface LineupPlayer {
  id: number;
  name: string;
  position: number;
  overall: number;
  energy: number;
  injuryDays: number;
  suspended: boolean;
}

export interface LineupView {
  formation: number;
  starters: (LineupPlayer | null)[];
  subs: (LineupPlayer | null)[];
  penaltyTakerId: number | null;
  freeKickTakerId: number | null;
  slots: number[];
  squad: { id: number; name: string; position: number; overall: number; energy: number; tacPosName: string; injuryDays: number; suspended: boolean }[];
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
  };
  events: LiveEvent[];
}

export interface Settings {
  matchDurationMinutes: number;
  maxContractSeasons?: number;
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

// Auth endpoints, live match info, match live state, and settings are never cached.
const NEVER_CACHE = /^api\/(auth|mp\/live-match$|matches\/.*\/(live|events|sub|halftime|ws)|settings)/;

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
  me: () => request<{ user: User }>("/api/auth/me"),
  register: (username: string, password: string, inviteToken?: string) =>
    request<{ user: User }>("/api/auth/register", { method: "POST", body: JSON.stringify(inviteToken ? { username, password, inviteToken } : { username, password }) }),
  login: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // Friends & invitations (plan 9)
  friends: () => request<{ friends: { userId: number; username: string; clubName: string | null; competitionState: string | null; since: string }[] }>("/api/auth/friends"),
  removeFriend: (userId: number) =>
    request<{ ok: boolean }>(`/api/auth/friends/${userId}`, { method: "DELETE" }),
  invitations: () => request<{ invitations: { token: string; createdAt: string }[] }>("/api/auth/invitations"),
  createInvitation: () => request<{ inviteToken: string }>("/api/auth/invite", { method: "POST" }),
  revokeInvitation: (token: string) =>
    request<{ ok: boolean }>(`/api/auth/invitations/${token}`, { method: "DELETE" }),

  // Multiplayer
  mpStatus: () => request<MpStatus>("/api/mp/status"),
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
  countries: () => request<{ featuredCountries: CountryOption[]; allCountries: CountryOption[] }>("/api/mp/countries"),
  history: () => request<{ seasons: SeasonHistoryView[] }>("/api/mp/history"),

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
  getLineup: (auto?: boolean, formation?: number) => {
    const params = new URLSearchParams();
    if (auto) params.set("auto", "1");
    if (formation !== undefined) params.set("formation", String(formation));
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

  renewContract: (playerId: number, length: number) =>
    request<{ ok: boolean; demand: number }>(`/api/players/${playerId}/contract`, { method: "POST", body: JSON.stringify({ length }) }),
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
  academyAction: (playerId: number, action: "promote" | "dismiss") =>
    request<{ ok: boolean }>(`/api/players/${playerId}/academy`, { method: "POST", body: JSON.stringify({ action }) }),
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

  // Pro features
  getAutomation: () => request<{ presets: unknown[] }>("/api/mp/automation"),
  setAutomation: (presets: unknown[]) => request<{ ok: boolean; presets: unknown[] }>("/api/mp/automation", { method: "PUT", body: JSON.stringify({ presets }) }),
  updateLogoVariant: (variant: number) => request<{ ok: boolean; logoVariant: number }>("/api/mp/club/logo-variant", { method: "PUT", body: JSON.stringify({ variant }) }),
  uploadCustomLogo: (mime: string, data: string) => request<{ ok: boolean }>("/api/mp/club/logo", { method: "POST", body: JSON.stringify({ mime, data }) }),
  deleteCustomLogo: () => request<{ ok: boolean }>("/api/mp/club/logo", { method: "DELETE" }),
  nicknamePlayer: (playerId: number, nickname: string | null) => request<{ ok: boolean; nickname: string | null; displayName: string }>(`/api/mp/players/${playerId}/nickname`, { method: "PUT", body: JSON.stringify({ nickname }) }),
  playerHistory: (playerId: number) => request<{ player: PlayerView & { displayName: string }; seasons: unknown[]; transfers: unknown[]; matches: unknown[] }>(`/api/players/${playerId}/history`),
  marketPlayerHistory: (listingId: number, marketType: "TRANSFER" | "FREE_AGENT") => request<{ player: PlayerView & { displayName: string }; seasons: unknown[]; transfers: unknown[]; matches: unknown[] }>(`/api/market/listings/${listingId}/player-history?marketType=${marketType}`),

  // Notifications & push
  listNotifications: (limit?: number, unread?: boolean) => request<{ notifications: { id: string; type: string; payload: unknown; createdAt: string; readAt: string | null }[] }>(`/api/notifications${limit ? `?limit=${limit}` : ""}${unread ? `${limit ? "&" : "?"}unread=1` : ""}`),
  markNotificationRead: (id: string) => request<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => request<{ ok: boolean }>("/api/notifications/read-all", { method: "POST" }),
  getVapidKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),
  pushSubscribe: (endpoint: string, p256dh: string, auth: string) => request<{ ok: boolean }>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint, p256dh, auth }) }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),

  // Warnings (own)
  myWarnings: () => request<{ warnings: { id: number; reason: string; createdAt: string; acknowledgedAt: string | null }[] }>("/api/auth/warnings"),
  ackWarning: (id: number) => request<{ ok: boolean }>(`/api/auth/warnings/${id}/acknowledge`, { method: "POST" }),

  // Admin user management
  adminListUsers: (search?: string, limit?: number) => request<{ users: { id: number; username: string; isAdmin: boolean; isPro: boolean; bannedAt: string | null; banReason: string | null; createdAt: string }[] }>(`/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ""}${limit ? `${search ? "&" : "?"}limit=${limit}` : ""}`),
  adminSetPro: (userId: number, isPro: boolean) => request<{ ok: boolean }>(`/api/admin/users/${userId}/pro`, { method: "POST", body: JSON.stringify({ isPro }) }),
  adminBanUser: (userId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/users/${userId}/ban`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminUnbanUser: (userId: number) => request<{ ok: boolean }>(`/api/admin/users/${userId}/unban`, { method: "POST" }),
  adminWarnUser: (userId: number, reason: string) => request<{ ok: boolean; warningId: number }>(`/api/admin/users/${userId}/warn`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminListUserWarnings: (userId: number) => request<{ warnings: { id: number; reason: string; issuedByAdminUserId: number; createdAt: string; acknowledgedAt: string | null }[] }>(`/api/admin/users/${userId}/warnings`),
  adminResetClubName: (clubId: number, name: string | undefined, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/reset-club-name`, { method: "POST", body: JSON.stringify({ clubId, ...(name ? { name } : {}), reason }) }),
  adminResetStadiumName: (clubId: number, stadiumName: string, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/reset-stadium-name`, { method: "POST", body: JSON.stringify({ clubId, stadiumName, reason }) }),
  adminClearNickname: (playerId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/clear-nickname`, { method: "POST", body: JSON.stringify({ playerId, reason }) }),
  adminRemoveLogo: (clubId: number, reason: string) => request<{ ok: boolean }>(`/api/admin/moderation/remove-logo`, { method: "POST", body: JSON.stringify({ clubId, reason }) }),

  // Admin analytics / world browsing / MOTD
  adminAnalytics: () => request<{ analytics: AdminAnalytics | null }>("/api/admin/analytics"),
  adminClubDetail: (clubId: number) => request<{ club: AdminClubDetail }>(`/api/admin/clubs/${clubId}`),
  adminSuggestedClubName: (attempt = 0) => request<{ name: string }>(`/api/admin/suggested-club-name?attempt=${attempt}`),
  adminGetMotd: () => request<{ messages: { dayIndex: number; dayLabel: string; text: string }[] }>("/api/admin/motd"),
  adminPostMotd: (text: string) => request<{ ok: boolean; text: string; dayIndex: number }>("/api/admin/motd", { method: "POST", body: JSON.stringify({ text }) }),
  adminDeleteMotd: () => request<{ ok: boolean; removed: number }>("/api/admin/motd", { method: "DELETE" }),
};
