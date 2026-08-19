export interface User {
  id: number;
  username: string;
  isAdmin?: boolean;
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

export interface PlayerView {
  id: number;
  name: string;
  age: number;
  country: string;
  position: number;
  positionName: string;
  tacPos: number;
  tacPosName: string;
  overall: number;
  tier: number;
  skills: SkillSet;
  energy: number;
  value: number;
  salary: number;
  contractDays: number;
  injuryDays: number;
  isYouth: boolean;
  seasonGoals: number;
  seasonAssists: number;
  careerGoals: number;
  careerAssists: number;
  yellows: number;
  reds: number;
  characteristic1: number;
  characteristic2: number;
  onSale: boolean;
  suspended: boolean;
  suspendedGames: number;
  morale: number;
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
  stadiumCapacity: number;
  primaryColor: string;
  secondaryColor: string;
  coachName: string;
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
    key: string;
    year: number;
    month: number;
    status: string;
    completedRounds: number;
    joinLockRound: number;
    joinState: "OPEN" | "LOCKED";
  };
  userClubId: number | null;
  club: {
    id: number;
    name: string;
    shortName: string;
    country: string;
    highestDivision: number;
    cash: number;
    competitionState: string;
    timezone: string | null;
    reservedNextSeasonAllocation: { seasonId: number; amount: number; issuedAt: number } | null;
    inactivity: { eligible: boolean; removedAtRollover: boolean; note: string | null } | null;
  } | null;
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
  kickoffAt: number | null;
  played: boolean;
  homeScore: number | null;
  awayScore: number | null;
  isHuman: boolean;
}

export interface Snapshot {
  save: { year: number; dayIndex: number; dateLabel: string; dayOfWeek: string; seasonDays: number };
  seasonSummary: {
    leagueChampion: string | null;
    leagueRunnerUp: string | null;
  } | null;
  club: ClubView | null;
  nextFixture: { id: number; home: string; away: string; dayLabel: string; dayIndex: number; isHome: boolean } | null;
  competitions: { id: number; kind: string; name: string; stage: string; round: number; position: number; winnerId: number | null }[];
  squad: PlayerView[];
  juniors: PlayerView[];
  loanedOut: PlayerView[];
  news: { dayIndex: number; dayLabel: string; text: string; kind: string }[];
  auctions: AuctionView[];
  freeAgents: PlayerView[];
  records: CareerRecord[];
  seasonAwards: SeasonAward[];
}

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
  listedAt: number;
  claimableAt: number;
  player: PlayerView | null;
  fromClub: string;
  toClub: string | null;
  available: boolean;
  claimableIn: number;
}

export interface FinanceDetails {
  ticketPrices: [number, number, number, number];
  ticketBounds: { min: number; max: number }[];
  stadiumUpgrade: { clubId: number; startedDay: number; completesDay: number; newCapacity: number; cost: number; completed: boolean } | null;
  nextStadiumUpgradeCost: number;
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
  myMaxBid: number | null;
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
  amILeading: boolean;
}

export interface LivePlayer {
  id: number;
  name: string;
  position: number;
  tacPos: number;
  overall: number;
  energy: number;
  injuryDays: number;
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
}

export interface LiveState {
  matchId: number;
  fixtureId: number;
  competitionId: number;
  competitionName: string;
  dateLabel: string;
  homeClubId: number;
  awayClubId: number;
  home: string;
  away: string;
  homeKit: { primary: string; secondary: string };
  awayKit: { primary: string; secondary: string };
  homeScore: number;
  awayScore: number;
  minute: number;
  half: number;
  phase: "pregame" | "first" | "halftime" | "second" | "et1" | "et2" | "shootout" | "fulltime";
  extraTime: boolean;
  ended: boolean;
  shootout: { scores: [number, number]; winner: string } | null;
  stats: { possession: [number, number]; shots: [number, number]; onGoal: [number, number]; offTarget: [number, number]; fouls: [number, number]; corners: [number, number]; yellows: [number, number]; reds: [number, number]; tackles: [number, number]; wrongPasses: [number, number] };
  events: LiveEvent[];
  homeOn: LivePlayer[];
  awayOn: LivePlayer[];
  homeBench: LivePlayer[];
  awayBench: LivePlayer[];
  usedSubs: [number, number];
  humanSide: 0 | 1;
  homeManager: string;
  awayManager: string;
  homeFormation: string;
  awayFormation: string;
  homeFormationId: number;
  awayFormationId: number;
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
  squad: { id: number; name: string; position: number; overall: number; tacPosName: string; injuryDays: number; suspended: boolean }[];
}

export interface MatchEvents {
  match: {
    id: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    stats: { possession: [number, number]; shots: [number, number]; onGoal: [number, number]; offTarget: [number, number]; fouls: [number, number]; yellows: [number, number]; reds: [number, number]; tackles: [number, number]; wrongPasses: [number, number] };
    attendance: number;
    gateRevenue: number;
  };
  events: LiveEvent[];
}

export interface Settings {
  humanMatchDurationMinutes: number;
  maxContractSeasons?: number;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
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

export const api = {
  me: () => request<User>("/api/auth/me"),
  register: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // Multiplayer
  mpStatus: () => request<MpStatus>("/api/mp/status"),
  join: (payload: { clubName: string; country: string; timezone?: string | null; primaryColor?: string; secondaryColor?: string; stadiumName?: string }) =>
    request<{ ok: boolean; clubId: number }>("/api/mp/join", { method: "POST", body: JSON.stringify(payload) }),
  returnClub: () =>
    request<{ ok: boolean }>("/api/mp/return", { method: "POST" }),
  practice: () =>
    request<{ homeGoals: number; awayGoals: number; events: number; opponentName: string }>("/api/mp/practice", { method: "POST" }),
  myClub: () => request<{ snapshot: Snapshot }>("/api/mp/club"),
  pyramid: () => request<{ seasonKey: string | null; tiers: PyramidTier[] }>("/api/mp/pyramid"),
  divisionStandings: (id: number) =>
    request<{ competition: { id: number; name: string; tier: number; groupIndex: number }; standings: StandingsRow[] }>(`/api/mp/divisions/${id}/standings`),
  divisionFixtures: (id: number) => request<{ fixtures: FixtureView[] }>(`/api/mp/divisions/${id}/fixtures`),
  countries: () => request<{ featuredCountries: CountryOption[]; allCountries: CountryOption[] }>("/api/mp/countries"),
  history: () => request<{ seasons: SeasonHistoryView[] }>("/api/mp/history"),

  liveMatchInfo: () => request<{ match: { id: number; home: string; away: string } | null }>("/api/mp/live-match"),

  matchEvents: (matchId: number) => request<MatchEvents>(`/api/matches/${matchId}/events`),
  liveState: (matchId: number) => request<{ state: LiveState }>(`/api/matches/${matchId}/live`),
  liveTick: (matchId: number, minutes: number, resume = false) =>
    request<{ events: LiveEvent[]; state: LiveState }>(`/api/matches/${matchId}/tick`, { method: "POST", body: JSON.stringify({ minutes, resume }) }),
  liveSub: (matchId: number, outId: number, inId: number) =>
    request<{ event: LiveEvent | null; state: LiveState }>(`/api/matches/${matchId}/sub`, { method: "POST", body: JSON.stringify({ outId, inId }) }),
  liveFinish: (matchId: number) =>
    request<{ ok: boolean }>(`/api/matches/${matchId}/finish`, { method: "POST" }),
  liveWsUrl: (matchId: number) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/matches/${matchId}/ws`,
  getLineup: (auto?: boolean, formation?: number) =>
    request<LineupView>(`/api/club/lineup${auto ? "?auto=1" : ""}${formation !== undefined ? `&formation=${formation}` : ""}`),
  setLineup: (lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean }>("/api/club/lineup", { method: "POST", body: JSON.stringify(lineup) }),
  matchLineup: (matchId: number, lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean; state?: LiveState }>(`/api/matches/${matchId}/lineup`, { method: "POST", body: JSON.stringify(lineup) }),
  competitionTable: (compId: number) =>
    request<{ competition: { id: number; name: string; kind: string; stage: string }; table: StandingsRow[] }>(`/api/competitions/${compId}/table`),
  competitionFixtures: (compId: number) =>
    request<{ competition: { id: number; name: string }; fixtures: { id: number; round: number; roundLabel: string; leg: number; home: string; away: string; dayLabel: string; dayIndex: number; played: boolean; homeScore?: number; awayScore?: number; isHuman: boolean }[] }>(`/api/competitions/${compId}/fixtures`),

  sellPlayer: (playerId: number, openingPrice?: number) =>
    request<{ ok: boolean; listingId?: number; openingPrice?: number }>("/api/transfers/auctions", { method: "POST", body: JSON.stringify({ playerId, openingPrice }) }),
  listAuctions: () => request<{ auctions: AuctionView[] }>("/api/transfers/auctions"),
  listFreeAgents: () => request<{ signings: FreeAgentView[] }>("/api/transfers/free-agents"),
  bidFreeAgent: (listingId: number, maxBid: number) =>
    request<{ ok: boolean; currentPrice: number; leading: boolean }>(`/api/transfers/free-agents/${listingId}/bid`, { method: "POST", body: JSON.stringify({ maxBid }) }),
  bidAuction: (listingId: number, maxBid: number) =>
    request<{ ok: boolean; currentPrice: number; leading: boolean }>(`/api/transfers/auctions/${listingId}/bid`, { method: "POST", body: JSON.stringify({ maxBid }) }),
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

  renewContract: (playerId: number, length: number, salary: number) =>
    request<{ ok: boolean }>(`/api/players/${playerId}/contract`, { method: "POST", body: JSON.stringify({ length, salary }) }),
  setTrainingFocus: (focus: "assistant" | "primary" | "secondary") =>
    request<{ ok: boolean; trainingFocus: "assistant" | "primary" | "secondary" }>("/api/club/training", { method: "POST", body: JSON.stringify({ focus }) }),
  setTactics: (tactics: { style: number; pressing: number; direction: number }) =>
    request<{ ok: boolean }>("/api/club/tactics", { method: "POST", body: JSON.stringify(tactics) }),
  finances: () =>
    request<{ cash: number; income: LedgerEntry[]; expense: LedgerEntry[]; finance: FinanceSnapshot }>("/api/club/finances"),
  financeDetails: () => request<FinanceDetails>("/api/club/finance-details"),
  setTicketPrices: (prices: [number, number, number, number]) =>
    request<{ ok: boolean; prices: [number, number, number, number] }>("/api/club/tickets", { method: "POST", body: JSON.stringify({ prices }) }),
  startStadiumUpgrade: () =>
    request<{ ok: boolean; upgrade: FinanceDetails["stadiumUpgrade"] }>("/api/club/stadium-upgrade", { method: "POST" }),
  listLoans: () => request<{ loans: LoanView[] }>("/api/transfers/loans"),
  offerLoan: (playerId: number) =>
    request<{ ok: boolean }>("/api/transfers/loans", { method: "POST", body: JSON.stringify({ playerId }) }),
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
  records: () => request<{ records: CareerRecord[]; awards: SeasonAward[] }>("/api/records"),

  settings: () => request<Settings>("/api/settings"),
  updateSettings: (humanMatchDurationMinutes: number) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify({ humanMatchDurationMinutes }) }),
  updateTimezone: (timezone: string) =>
    request<{ ok: boolean; timezone: string }>("/api/account/timezone", { method: "PUT", body: JSON.stringify({ timezone }) }),

  // Admin (manual clock / settings)
  adminStatus: () =>
    request<{ world: { seasonKey: string; seasonStatus: string; completedRounds: number; joinState: string; joinLockRound: number; manualRound: number | null; realCompletedRounds: number; divisionCount: number; clubCount: number; humanClubCount: number; liveMatchCount: number } | null }>("/api/admin/status"),
  adminAdvanceRound: (round: number) =>
    request<{ ok: boolean; from: number; to: number; joinState: string; joinLockRound: number }>("/api/admin/advance-round", { method: "POST", body: JSON.stringify({ round }) }),
  adminSetRound: (round: number) =>
    request<{ ok: boolean; manualRound: number }>("/api/admin/set-round", { method: "POST", body: JSON.stringify({ round }) }),
  adminClearManual: () =>
    request<{ ok: boolean }>("/api/admin/clear-manual", { method: "POST" }),
  adminRollover: () =>
    request<{ ok: boolean; season: { seasonId: number; year: number; month: number } }>("/api/admin/rollover", { method: "POST" }),
};
