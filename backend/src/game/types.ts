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
  value: number;
  releaseClause: number;
  injuryDays: number;
  contractDays: number;
  isYouth: boolean;
  isStar: boolean;
  worldClass: boolean;
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
  stateCode: string;
  division: number;
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
  tactics: Tactics;
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
  kind: "league" | "cup" | "state";
  division: number;
  stateCode: string;
  name: string;
  round: number;
  stage: "group" | "knockout" | "finished";
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
  compKind: "league" | "cup" | "state";
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
  shootout?: { scores: [number, number]; winner: number };
  ended: boolean;
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
  cupChampionId: number | null;
  stateChampionId: number | null;
  promoted: number[];
  relegated: number[];
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
  liveMatch?: LiveMatchState | null;
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
