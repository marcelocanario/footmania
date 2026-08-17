export interface User {
  id: number;
  username: string;
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
  potential: number;
  tier: number;
  skills: SkillSet;
  energy: number;
  value: number;
  salary: number;
  contractDays: number;
  injuryDays: number;
  isYouth: boolean;
  isStar: boolean;
  worldClass: boolean;
  seasonGoals: number;
  seasonAssists: number;
  careerGoals: number;
  careerAssists: number;
  yellows: number;
  reds: number;
  characteristic1: number;
  characteristic2: number;
  onSale: boolean;
  salePrice: number | null;
  suspended: boolean;
  suspendedGames: number;
  morale: number;
  loanId: number | null;
  releaseClause: number;
  signingBonus?: number;
}

export interface Snapshot {
  save: { year: number; dayIndex: number; dateLabel: string; dayOfWeek: string; seasonDays: number };
  seasonSummary: {
    leagueChampion: string | null;
    leagueRunnerUp: string | null;
  } | null;
  club: {
    id: number;
    name: string;
    shortName: string;
    country: string;
    reputation: number;
    level: number;
    cash: number;
    loanBalance: number;
    stadiumName: string;
    stadiumCapacity: number;
    primaryColor: string;
    secondaryColor: string;
    coachName: string;
    boardConfidence: number;
    fanConfidence: number;
    trainingFocus: "assistant" | "primary" | "secondary";
    tactics: { formation: number; style: number; pressing: number; direction: number; formationName: string; styleName: string; pressingName: string; directionName: string } | null;
    trophies: Record<string, number>;
    ledger: { income: LedgerEntry[]; expense: LedgerEntry[] };
  } | null;
  nextFixture: { id: number; home: string; away: string; dayLabel: string; dayIndex: number; isHome: boolean } | null;
  competitions: { id: number; kind: string; name: string; stage: string; round: number; position: number; winnerId: number | null }[];
  squad: PlayerView[];
  juniors: PlayerView[];
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
  player: PlayerView | null;
  fromClub: string;
  toClub: string | null;
  available: boolean;
}

export interface FinanceDetails {
  ticketPrices: [number, number, number, number];
  ticketBounds: { min: number; max: number }[];
  stadiumUpgrade: { clubId: number; startedDay: number; completesDay: number; newCapacity: number; cost: number; completed: boolean } | null;
  tvDeal: { clubId: number; season: number; baseAmount: number; positionBonus: number } | null;
  records: CareerRecord[];
  awards: SeasonAward[];
}

export interface LedgerEntry {
  code: number;
  amount: number;
  day: number;
  label: string;
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
  minBid: number;
  deadlineDay: number;
  deadlineLabel: string;
  currentBid: number;
  sellerClubId: number | null;
  myBid: number;
}

export interface DayResult {
  dayIndex: number;
  dateLabel: string;
  events: string[];
  news: { dayIndex: number; kind: string; text: string }[];
  playedMatches: {
    id: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    competitionId: number;
    isHuman: boolean;
  }[];
  humanMatch: { id: number; home: string; away: string; homeScore: number; awayScore: number } | null;
  matchPending: boolean;
  seasonEnded: boolean;
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

export interface TableRow {
  clubId: number;
  clubName: string;
  clubShort: string;
  colors: { primary: string; secondary: string };
  isHuman: boolean;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
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

  listSaves: () =>
    request<{ id: number; name: string; year: number; dayIndex: number; hasHuman: boolean; updatedAt: string }[]>("/api/saves"),
  createSave: (name: string, seed?: number) =>
    request<{ id: number }>("/api/saves", { method: "POST", body: JSON.stringify({ name, seed }) }),
  deleteSave: (id: number) => request<{ ok: boolean }>(`/api/saves/${id}`, { method: "DELETE" }),
  saveSummary: (id: number) =>
    request<{ id: number; name: string; year: number; dayIndex: number; dateLabel: string; hasHuman: boolean; clubName: string | null }>(`/api/saves/${id}/summary`),
  saveState: (id: number) =>
    request<{ started: boolean; snapshot?: Snapshot; featuredCountries?: CountryOption[]; allCountries?: CountryOption[] }>(`/api/saves/${id}/state`),
  startSave: (id: number, country: string, name?: string) =>
    request<{ ok: boolean; clubId: number }>(`/api/saves/${id}/start`, { method: "POST", body: JSON.stringify({ country, name }) }),
  advance: (id: number) => request<DayResult>(`/api/saves/${id}/advance`, { method: "POST" }),
  liveMatchInfo: (id: number) =>
    request<{ match: { id: number; home: string; away: string } | null }>(`/api/saves/${id}/live`),

  matchEvents: (saveId: number, matchId: number) => request<MatchEvents>(`/api/matches/${matchId}/events?saveId=${saveId}`),
  liveState: (saveId: number, matchId: number) => request<{ state: LiveState }>(`/api/matches/${matchId}/live?saveId=${saveId}`),
  liveTick: (saveId: number, matchId: number, minutes: number, resume = false) =>
    request<{ events: LiveEvent[]; state: LiveState }>(`/api/matches/${matchId}/tick?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ minutes, resume }) }),
  liveSub: (saveId: number, matchId: number, outId: number, inId: number) =>
    request<{ event: LiveEvent | null; state: LiveState }>(`/api/matches/${matchId}/sub?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ outId, inId }) }),
  liveFinish: (saveId: number, matchId: number) =>
    request<{ dayResult: DayResult }>(`/api/matches/${matchId}/finish?saveId=${saveId}`, { method: "POST" }),
  liveWsUrl: (saveId: number, matchId: number) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/matches/${matchId}/ws?saveId=${saveId}`,
  getLineup: (saveId: number, auto?: boolean, formation?: number) =>
    request<LineupView>(`/api/club/lineup?saveId=${saveId}${auto ? "&auto=1" : ""}${formation !== undefined ? `&formation=${formation}` : ""}`),
  setLineup: (saveId: number, lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean }>(`/api/club/lineup?saveId=${saveId}`, { method: "POST", body: JSON.stringify(lineup) }),
  matchLineup: (saveId: number, matchId: number, lineup: { formation: number; starters: number[]; subs: number[]; penaltyTakerId: number | null; freeKickTakerId: number | null }) =>
    request<{ ok: boolean; state?: LiveState }>(`/api/matches/${matchId}/lineup?saveId=${saveId}`, { method: "POST", body: JSON.stringify(lineup) }),
  competitionTable: (saveId: number, compId: number) =>
    request<{ competition: { id: number; name: string; kind: string; stage: string }; table: TableRow[] | { groupName: string; rows: TableRow[] }[] }>(`/api/competitions/${compId}/table?saveId=${saveId}`),
  competitionFixtures: (saveId: number, compId: number) =>
    request<{ competition: { id: number; name: string }; fixtures: { id: number; round: number; roundLabel: string; leg: number; home: string; away: string; dayLabel: string; dayIndex: number; played: boolean; homeScore?: number; awayScore?: number; isHuman: boolean }[] }>(`/api/competitions/${compId}/fixtures?saveId=${saveId}`),
  competitionBracket: (saveId: number, compId: number) =>
    request<{ competition: { id: number; name: string }; bracket: { round: number; ties: { home: string; away: string; leg1: string | null; leg2: string | null; pen: string | null; winner: string; played: boolean }[] }[] }>(`/api/competitions/${compId}/bracket?saveId=${saveId}`),

  sellPlayer: (saveId: number, playerId: number, mode: "auction" | "fixed", price?: number) =>
    request<{ ok: boolean; listingId?: number; price?: number }>(`/api/transfers/sell?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ playerId, mode, price }) }),
  bidPlayer: (saveId: number, playerId: number, bid: number) =>
    request<{ accepted: boolean; price?: number; counter?: number; signingBonus?: number }>(`/api/transfers/bid?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ playerId, bid }) }),
  listAuctions: (saveId: number) => request<{ auctions: AuctionView[] }>(`/api/transfers/auctions?saveId=${saveId}`),
  bidAuction: (saveId: number, listingId: number, amount: number) =>
    request<{ ok: boolean; currentBid: number }>(`/api/auctions/${listingId}/bid?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ amount }) }),

  renewContract: (saveId: number, playerId: number, length: number, salary: number) =>
    request<{ ok: boolean }>(`/api/players/${playerId}/contract?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ length, salary }) }),
  setTrainingFocus: (saveId: number, focus: "assistant" | "primary" | "secondary") =>
    request<{ ok: boolean; trainingFocus: "assistant" | "primary" | "secondary" }>(`/api/club/training?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ focus }) }),
  setTactics: (saveId: number, tactics: { style: number; pressing: number; direction: number }) =>
    request<{ ok: boolean }>(`/api/club/tactics?saveId=${saveId}`, { method: "POST", body: JSON.stringify(tactics) }),
  finances: (saveId: number) =>
    request<{ cash: number; loanBalance: number; loanLimit: number; loanInterestPercent: number; income: LedgerEntry[]; expense: LedgerEntry[] }>(`/api/club/finances?saveId=${saveId}`),
  loan: (saveId: number, action: "take" | "repay") =>
    request<{ ok: boolean; cash: number; loanBalance: number }>(`/api/club/loan?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ action }) }),
  financeDetails: (saveId: number) => request<FinanceDetails>(`/api/club/finance-details?saveId=${saveId}`),
  setTicketPrices: (saveId: number, prices: [number, number, number, number]) =>
    request<{ ok: boolean; prices: [number, number, number, number] }>(`/api/club/tickets?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ prices }) }),
  startStadiumUpgrade: (saveId: number) =>
    request<{ ok: boolean; upgrade: FinanceDetails["stadiumUpgrade"] }>(`/api/club/stadium-upgrade?saveId=${saveId}`, { method: "POST" }),
  listLoans: (saveId: number) => request<{ loans: LoanView[] }>(`/api/transfers/loans?saveId=${saveId}`),
  loanPlayer: (saveId: number, playerId: number, action: "offer" | "take" | "recall") =>
    request<{ ok: boolean }>(`/api/players/${playerId}/loan?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ action }) }),
  academyAction: (saveId: number, playerId: number, action: "promote" | "dismiss") =>
    request<{ ok: boolean }>(`/api/players/${playerId}/academy?saveId=${saveId}`, { method: "POST", body: JSON.stringify({ action }) }),
  contractDemand: (saveId: number, playerId: number) =>
    request<{ demand: number; salary: number; contractDays: number }>(`/api/players/${playerId}/contract?saveId=${saveId}`),
  records: (saveId: number) => request<{ records: CareerRecord[]; awards: SeasonAward[] }>(`/api/records?saveId=${saveId}`),
};
