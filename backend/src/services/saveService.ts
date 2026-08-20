import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AuctionStatus,
  Club,
  Competition,
  GroupStandings,
  LiveMatchState,
  Match,
  MatchStats,
  Player,
  StandingsRow,
  World,
} from "../game/types";
import { generateWorld } from "../game/worldgen";
import { createRng } from "../game/rng";
import { backfillDevelopmentProfile, overallFromSkills } from "../game/player";
import { DEVELOPMENT } from "../game/constants";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { calculateBaseSalary, calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "../game/economy";
import { ensureNamePools } from "./namePoolService";

type Tx = Prisma.TransactionClient;

/** Thrown when a persist targets a stale revision (another process wrote first). */
export class StaleWorldError extends Error {
  constructor(public readonly saveId: number, public readonly expectedRevision: number, public readonly actualRevision: number) {
    super(`Stale world write (save ${saveId}): expected revision ${expectedRevision}, found ${actualRevision}`);
    this.name = "StaleWorldError";
  }
}

const TABLE_NAMES = [
  "matchEvent",
  "matchStat",
  "match",
  "standingsRow",
  "fixture",
  "competition",
  "player",
  "club",
  "newsItem",
  "ledgerEntry",
  "transferAuction",
  "marketBid",
  "freeAgentListing",
  "marketReservation",
  "playerMarketTransaction",
  "aiEvaluation",
  "trophy",
  "loan",
  "managerHistory",
  "seasonAward",
  "careerRecord",
  "clubTicketPrices",
  "stadiumUpgrade",
  "liveMatch",
] as const;

function jsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Trust no persisted JSON: keep finite minutes, clamp, and cap the window. */
function sanitizeRecentMinutes(raw: string | null | undefined): number[] {
  const parsed = jsonOr<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(300, Math.round(v))) : null))
    .filter((v): v is number => v !== null)
    .slice(0, DEVELOPMENT.recentMatchWindow);
}

function normalizePlayer(player: Player, club: Club | undefined): void {
  player.skills ??= { gol: 1, vel: 1, tec: 1, pas: 1, des: 1, arm: 1, fin: 1 };
  for (const key of ["gol", "vel", "tec", "pas", "des", "arm", "fin"] as const) {
    const value = Number(player.skills?.[key] ?? 1);
    player.skills[key] = Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 1;
  }
  // Migration rule (spec §27): existing saves keep their stored attributes and
  // OVR. Only derive from skills when the stored value is absent or corrupt.
  if (!Number.isFinite(player.overall)) {
    player.overall = overallFromSkills(player.position, player.skills);
  }
  player.overall = Math.max(1, Math.min(100, Math.round(player.overall)));
  player.potential = Math.max(player.overall, Math.min(100, Number(player.potential) || player.overall));
  const acc = Array.isArray(player.skillAcc) ? player.skillAcc : [];
  const hasLegacyClickProgress = acc.some((value) => !Number.isFinite(value) || Math.abs(value) >= 1);
  player.skillAcc = hasLegacyClickProgress ? [0, 0, 0, 0, 0, 0, 0] : Array.from({ length: 7 }, (_, i) => Number(acc[i] ?? 0));
  if (!Number.isFinite(player.contractDays) || player.contractDays < 0) player.contractDays = 0;
  if (!Number.isFinite(player.payrollPaidThroughDay) || player.payrollPaidThroughDay < 0) player.payrollPaidThroughDay = 0;
  if (!Number.isFinite(player.payrollPaidAmount) || player.payrollPaidAmount < 0) player.payrollPaidAmount = 0;
  if (!Number.isFinite(player.payrollPeriodStartDay) || player.payrollPeriodStartDay < 0) player.payrollPeriodStartDay = 0;
  // Preserve the persisted market value/salary when present and sane; only
  // backfill them when missing. Salaries are contractual and are never
  // recomputed on load.
  if (!Number.isFinite(player.value) || player.value <= 0) {
    player.value = calculatePlayerValue(player.overall, player.age, remainingSeasons(player.contractDays));
  }
  if (!Number.isFinite(player.salary) || player.salary <= 0) {
    player.salary = calculateBaseSalary(player.overall, player.age);
  }
  player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
}

/** Normalize a save written by the old single-column worldJson format. */
export function deserializeWorld(json: string): World {
  const world = JSON.parse(json) as World;
  const legacyLiveMatch = (world as World & { liveMatch?: LiveMatchState | null }).liveMatch;
  world.seed ??= 0;
  world.year ??= 1;
  world.dayIndex ??= 0;
  world.dayOfWeek ??= ((world.dayIndex % 7) + 7) % 7;
  world.nextId ??= 1;
   world.clubs ??= [];
   world.players ??= [];
   world.competitions ??= [];
   world.fixtures ??= [];
   world.matches ??= [];
   world.news ??= [];
   world.loans ??= [];
   world.seasonAwards ??= [];
   world.records ??= [];
   world.managerHistory ??= [];
   world.ticketPrices ??= {};
   world.stadiumUpgrades ??= [];
   world.humanClubId ??= null;
   world.seasonSummary ??= null;
   world.contractWarnings ??= [];
   world.rng ??= createRng(world.seed);
   world.mp ??= {
     seasonId: 0,
     seasonYear: world.year,
     seasonMonth: 1,
     seasonStatus: "PREPARATION",
     completedRounds: 0,
     joinLockRound: 7,
     joinState: "OPEN",
     joinThresholdPercent: 0.5,
     inactivityThresholds: { 1: 42, 2: 35, default: 28 },
     matchTimeMode: "DIVISION_LOCAL_KICKOFF",
     matchKickoffHour: 20,
     lastProcessedGameDay: 0,
     lastDailyTickDay: 0,
     lastDailyTickDate: null,
     manualRound: null,
     rolloverPhase: null,
   };
   world.marketBids ??= [];
   world.transferAuctions ??= [];
   world.freeAgentListings ??= [];
   world.marketReservations ??= [];
   world.playerMarketHistory ??= [];
   world.aiEvaluations ??= [];
   world.financialInterventions ??= [];
   world.mpQueue ??= [];
   world.liveMatches ??= legacyLiveMatch ? [legacyLiveMatch] : [];
   world.seasonAllocations ??= [];
   world.mpMemberships ??= [];
   world.mpClubSeasons ??= [];
   world.mpActivities ??= [];
   world.mpAudits ??= [];
   world.seasonHistory ??= [];
   world.generationEvents ??= [];

  for (const club of world.clubs) {
    club.ledger ??= { income: [], expense: [] };
    club.trophies ??= {};
    club.trainingFocus ??= "assistant";
    club.country ??= "BRA"; // defensive: pre-country legacy rows would otherwise violate the NOT NULL column
    club.ownerUserId ??= null;
    club.timezone ??= null;
    club.competitionState ??= "ACTIVE";
    club.lastMeaningfulActivityAt ??= null;
    club.abandonmentEligibleAt ??= null;
    club.liveMatchAt ??= null;
  }
  for (const player of world.players) {
    const legacy = player as Player & { suspended?: boolean };
    player.skillAcc ??= [0, 0, 0, 0, 0, 0, 0];
    player.suspendedGames ??= legacy.suspended ? 1 : 0;
    player.morale ??= 50;
    player.loanId ??= null;
    if (!player.developmentProfile) {
      player.developmentProfile = backfillDevelopmentProfile(world.seed, player.id);
    }
    player.recentMinutes ??= [];
    normalizePlayer(player, world.clubs.find((club) => club.id === player.clubId));
  }
  for (const match of world.matches) {
    match.events ??= [];
    match.minuteEvents ??= [];
    match.stats = normalizeMatchStats(match.stats);
    match.extraTime ??= false;
  }
  if (world.liveMatches) {
    for (const st of world.liveMatches) hydrateLiveMatchState(st, world);
  }
  return world;
}

/** Coerce a persisted/legacy stats object into the new nested MatchStats shape. */
function normalizeMatchStats(stats: unknown): MatchStats {
  if (!stats || typeof stats !== "object") return emptyMatchStats();
  const s = stats as MatchStats & {
    possession?: [number, number];
    shots?: [number, number];
    onGoal?: [number, number];
    offTarget?: [number, number];
    fouls?: [number, number];
    corners?: [number, number];
    yellows?: [number, number];
    reds?: [number, number];
    tackles?: [number, number];
    wrongPasses?: [number, number];
  };
  // New nested shape already present.
  if (s.home && s.away && typeof s.home.shots === "number" && typeof s.away.shots === "number") {
    return { home: { ...emptyTeamStats(), ...s.home }, away: { ...emptyTeamStats(), ...s.away } };
  }
  // Legacy flat per-side arrays.
  const h = s.shots?.[0] ?? 0;
  const a = s.shots?.[1] ?? 0;
  return {
    home: {
      ...emptyTeamStats(),
      shots: h,
      shotsOnTarget: s.onGoal?.[0] ?? 0,
      fouls: s.fouls?.[0] ?? 0,
      corners: s.corners?.[0] ?? 0,
      yellows: s.yellows?.[0] ?? 0,
      reds: s.reds?.[0] ?? 0,
    },
    away: {
      ...emptyTeamStats(),
      shots: a,
      shotsOnTarget: s.onGoal?.[1] ?? 0,
      fouls: s.fouls?.[1] ?? 0,
      corners: s.corners?.[1] ?? 0,
      yellows: s.yellows?.[1] ?? 0,
      reds: s.reds?.[1] ?? 0,
    },
  };
}

export async function createSaveRecord(
  prisma: PrismaClient,
  userId: number,
  name: string,
  seed?: number
): Promise<{ id: number }> {
  const world = generateWorld(seed ?? Math.floor(Math.random() * 0x7fffffff));
  const save = await prisma.save.create({
    data: {
      userId,
      name,
      year: world.year,
      dayIndex: world.dayIndex,
      humanClubId: world.humanClubId,
      seed: world.seed,
      rngState: BigInt(world.rng.state),
    },
  });
  await persistWorld(prisma, save.id, userId, world);
  return { id: save.id };
}

/** The single global multiplayer Save row (isGlobal = true). */
export async function ensureGlobalSave(prisma: PrismaClient): Promise<{ id: number; name: string }> {
  const existing = await prisma.save.findFirst({ where: { isGlobal: true } });
  if (existing) return { id: existing.id, name: existing.name };
  // The global save needs an owning user for the FK; use (or create) a
  // dedicated "system" user.
  let system = await prisma.user.findUnique({ where: { username: "__system__" } });
  if (!system) {
    system = await prisma.user.create({ data: { username: "__system__", passwordHash: "!" } });
  }
  // Name pools must be ready before the first world is generated so the
  // deterministic RNG draws from the database source of truth.
  await ensureNamePools(prisma);
  const world = generateWorld(Math.floor(Math.random() * 0x7fffffff));
  const save = await prisma.save.create({
    data: {
      userId: system.id,
      name: "Global Multiplayer",
      isGlobal: true,
      year: world.year,
      dayIndex: world.dayIndex,
      humanClubId: null,
      seed: world.seed,
      rngState: BigInt(world.rng.state),
    },
  });
  await persistWorld(prisma, save.id, save.userId, world);
  return { id: save.id, name: save.name };
}

export async function loadGlobalWorld(prisma: PrismaClient): Promise<{ save: { id: number; name: string; revision: number }; world: World } | null> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true } });
  if (!save) return null;
  const world = await rebuildWorld(prisma, save);
  return { save: { id: save.id, name: save.name, revision: save.revision }, world };
}

/**
 * Load the global world, apply a mutation, and persist it with optimistic
 * concurrency. On a stale write (another process mutated the world between
 * load and persist), the world is reloaded and the mutation re-run.
 *
 * NOTE: callers should still run inside `withGlobalLock` so the in-process
 * worker/routes serialize; the revision check protects against OTHER processes
 * racing the local lock (plan §80/§81).
 */
export async function mutateGlobalWorld<T>(
  prisma: PrismaClient,
  mutate: (world: World) => T | Promise<T>,
  maxRetries = 3
): Promise<{ result: T; saveId: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("Global world unavailable");
    const { save, world } = loaded;
    const result = await mutate(world);
    try {
      await persistWorld(prisma, save.id, save.id, world, save.revision);
      return { result, saveId: save.id };
    } catch (err) {
      if (err instanceof StaleWorldError && attempt < maxRetries) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function persistWorld(
  prisma: PrismaClient,
  saveId: number,
  userId: number,
  world: World,
  expectedRevision?: number,
  opts?: { dailyExecutions?: { seasonId: number; date: string; executionType: string }[] }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.save.findUnique({ where: { id: saveId }, select: { userId: true, isGlobal: true } });
    if (!target || (!target.isGlobal && target.userId !== userId)) {
      throw new Error("Save not found");
    }
    // Multiplayer: the global save is updated by id (userId param is ignored
    // for the global row; single-player saves were retired with the redesign).
    // Optimistic concurrency: when the caller captured a revision at load time,
    // the save row is only updated if the revision still matches, atomically
    // bumping it. A concurrent writer in another process therefore cannot
    // silently overwrite this world (plan §58/§80/§81).
    if (expectedRevision !== undefined) {
      const res = await tx.save.updateMany({
        where: { id: saveId, revision: expectedRevision },
        data: {
          year: world.year,
          dayIndex: world.dayIndex,
          humanClubId: world.humanClubId,
          seed: world.seed,
          rngState: BigInt(world.rng.state),
          mpStateJson: JSON.stringify(world.mp),
          seasonSummaryJson: world.seasonSummary ? JSON.stringify(world.seasonSummary) : null,
          pendingEventsJson: world.pendingDayEvents ? JSON.stringify(world.pendingDayEvents) : null,
          pendingMatchIdsJson: world.pendingDayMatchIds ? JSON.stringify(world.pendingDayMatchIds) : null,
          generationEventsJson: world.generationEvents ? JSON.stringify(world.generationEvents) : null,
          financialInterventionsJson: world.financialInterventions ? JSON.stringify(world.financialInterventions) : null,
          revision: { increment: 1 },
        },
      });
      if (res.count !== 1) {
        const fresh = await tx.save.findUnique({ where: { id: saveId }, select: { revision: true } });
        throw new StaleWorldError(saveId, expectedRevision, fresh?.revision ?? -1);
      }
    } else {
      await tx.save.update({
        where: { id: saveId },
        data: {
          year: world.year,
          dayIndex: world.dayIndex,
          humanClubId: world.humanClubId,
          seed: world.seed,
          rngState: BigInt(world.rng.state),
          mpStateJson: JSON.stringify(world.mp),
          seasonSummaryJson: world.seasonSummary ? JSON.stringify(world.seasonSummary) : null,
          pendingEventsJson: world.pendingDayEvents ? JSON.stringify(world.pendingDayEvents) : null,
          pendingMatchIdsJson: world.pendingDayMatchIds ? JSON.stringify(world.pendingDayMatchIds) : null,
          generationEventsJson: world.generationEvents ? JSON.stringify(world.generationEvents) : null,
          financialInterventionsJson: world.financialInterventions ? JSON.stringify(world.financialInterventions) : null,
          revision: { increment: 1 },
        },
      });
    }
    for (const t of TABLE_NAMES) {
      await (tx as unknown as Record<string, { deleteMany: (args: { where: { saveId: number } }) => Promise<unknown> }>)[t].deleteMany({ where: { saveId } });
    }
    if (world.clubs.length > 0) {
      await tx.club.createMany({ data: world.clubs.map((c) => clubRow(c, saveId)) });
    }
    if (world.players.length > 0) {
      await tx.player.createMany({ data: world.players.map((p) => playerRow(p, saveId)) });
    }
     if (world.loans.length > 0) {
       await tx.loan.createMany({ data: world.loans.map((l) => ({ id: l.id, saveId, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled, listedAt: BigInt(l.listedAt), claimableAt: BigInt(l.claimableAt) })) });
     }
    if (world.competitions.length > 0) {
      await tx.competition.createMany({ data: world.competitions.map((c) => competitionRow(c, saveId)) });
      const rows: { saveId: number; competitionId: number; clubId: number; played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; points: number; groupName: string | null }[] = [];
      for (const comp of world.competitions) {
        for (const row of Object.values(comp.standings)) {
          rows.push({ saveId, competitionId: comp.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: null });
        }
        for (const g of comp.groupStandings) {
          for (const row of Object.values(g.rows)) {
            rows.push({ saveId, competitionId: comp.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: g.groupName });
          }
        }
      }
      await tx.standingsRow.createMany({ data: rows });
    }
    if (world.fixtures.length > 0) {
      await tx.fixture.createMany({ data: world.fixtures.map((f) => ({ id: f.id, saveId, competitionId: f.competitionId, round: f.round, homeClubId: f.homeClubId, awayClubId: f.awayClubId, dayIndex: f.dayIndex, played: f.played, leg: f.leg ?? null, tie: f.tie ?? null, kickoffAt: f.kickoffAt !== undefined ? BigInt(f.kickoffAt) : null })) });
    }
    if (world.matches.length > 0) {
      await tx.match.createMany({ data: world.matches.map((m) => ({ id: m.id, saveId, fixtureId: m.fixtureId, competitionId: m.competitionId, homeClubId: m.homeClubId, awayClubId: m.awayClubId, homeScore: m.homeScore, awayScore: m.awayScore, penaltyWinnerId: m.penaltyWinnerId, penaltyScoreJson: m.penaltyScore ? JSON.stringify(m.penaltyScore) : null, attendance: m.attendance, gateRevenue: m.gateRevenue, extraTime: m.extraTime ?? false })) });
      await tx.matchStat.createMany({ data: world.matches.map((m) => statRow(m, saveId)) });
      const evRows: { saveId: number; matchId: number; minute: number; half: number; type: number; subtype: number; clubId: number; playerId: number | null; player2Id: number | null; goalType: number; ordinal: number }[] = [];
      for (const m of world.matches) {
        m.events.forEach((e, i) => {
          evRows.push({ saveId, matchId: m.id, minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, playerId: e.playerId, player2Id: e.player2Id, goalType: e.goalType, ordinal: i });
        });
      }
      if (evRows.length > 0) await tx.matchEvent.createMany({ data: evRows });
    }
    if (world.news.length > 0) {
      await tx.newsItem.createMany({ data: world.news.map((n) => ({ saveId, dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? null })) });
    }
    const ledgerRows: { saveId: number; clubId: number; direction: string; code: number; amount: number; day: number; label: string }[] = [];
    for (const club of world.clubs) {
      for (const e of club.ledger.income) ledgerRows.push({ saveId, clubId: club.id, direction: "income", code: e.code, amount: e.amount, day: e.day, label: e.label });
      for (const e of club.ledger.expense) ledgerRows.push({ saveId, clubId: club.id, direction: "expense", code: e.code, amount: e.amount, day: e.day, label: e.label });
    }
     if (ledgerRows.length > 0) await tx.ledgerEntry.createMany({ data: ledgerRows });
     const trophyRows: { saveId: number; clubId: number; competitionName: string; count: number }[] = [];
     for (const club of world.clubs) {
       for (const [name, count] of Object.entries(club.trophies)) {
         trophyRows.push({ saveId, clubId: club.id, competitionName: name, count });
       }
     }
     if (trophyRows.length > 0) await tx.trophy.createMany({ data: trophyRows });
     if (world.managerHistory.length > 0) {
       await tx.managerHistory.createMany({ data: world.managerHistory.map((m) => ({ saveId, clubId: m.clubId, name: m.name, appointedDay: m.appointedDay, departedDay: m.departedDay, gamesInCharge: m.gamesInCharge, reason: m.reason })) });
     }
     if (world.seasonAwards.length > 0) {
       await tx.seasonAward.createMany({ data: world.seasonAwards.map((a) => ({ saveId, season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })) });
     }
     if (world.records.length > 0) {
       await tx.careerRecord.createMany({ data: world.records.map((r) => ({ saveId, category: r.category, value: r.value, holderName: r.holderName })) });
    }
    if (Object.keys(world.ticketPrices).length > 0) {
      await tx.clubTicketPrices.createMany({ data: Object.entries(world.ticketPrices).map(([clubId, p]) => ({ saveId, clubId: Number(clubId), sector0: p[0], sector1: p[1], sector2: p[2], sector3: p[3] })) });
    }
    if (world.stadiumUpgrades.length > 0) {
      await tx.stadiumUpgrade.createMany({ data: world.stadiumUpgrades.map((u) => ({ saveId, clubId: u.clubId, startedDay: u.startedDay, completesDay: u.completesDay, newCapacity: u.newCapacity, cost: u.cost, completed: u.completed })) });
    }
     if (world.liveMatches.length > 0) {
       await tx.liveMatch.createMany({ data: world.liveMatches.map((st) => ({ saveId, matchId: st.matchId, stateJson: JSON.stringify(st) })) });
     }
     // Normalized multiplayer transfer market (plan §55). Full rewrite each
     // persist: the in-memory World is the source of truth for active
     // listings/bids; resolved/cancelled rows are simply no longer present.
     if (world.transferAuctions.length > 0) {
       await tx.transferAuction.createMany({
         data: world.transferAuctions.map((a) => ({
           id: a.id,
           saveId,
           playerId: a.playerId,
           sellerClubId: a.sellerClubId,
           playerValueAtListing: a.playerValueAtListing,
           openingPrice: a.openingPrice,
           bidIncrement: a.bidIncrement,
           sellerDivisionAtListing: a.sellerDivisionAtListing,
           totalDivisionsAtListing: a.totalDivisionsAtListing,
           currentPrice: a.currentPrice,
           leadingClubId: a.leadingClubId,
           createdAt: BigInt(a.createdAt),
           deadline: BigInt(a.deadline),
           originalDeadline: BigInt(a.originalDeadline),
           status: a.status,
           completedAt: a.completedAt !== null ? BigInt(a.completedAt) : null,
           winningClubId: a.winningClubId,
           finalPrice: a.finalPrice,
           cancelledAt: a.cancelledAt !== null ? BigInt(a.cancelledAt) : null,
           softClosed: a.softClosed,
           softCloseExtensions: a.softCloseExtensions,
         })),
       });
     }
     if (world.marketBids.length > 0) {
       await tx.marketBid.createMany({
         data: world.marketBids.map((b) => ({
           id: b.id,
           saveId,
           marketType: b.marketType,
           listingId: b.listingId,
           clubId: b.clubId,
           maxBid: b.maxBid,
           capMultiplierAtSubmission: b.capMultiplierAtSubmission !== undefined ? b.capMultiplierAtSubmission : null,
           maximumAllowedByRuleAtSubmission: b.maximumAllowedByRuleAtSubmission !== undefined ? b.maximumAllowedByRuleAtSubmission : null,
           buyerDivisionAtSubmission: b.buyerDivisionAtSubmission !== undefined ? b.buyerDivisionAtSubmission : null,
           createdAt: BigInt(b.createdAt),
           updatedAt: BigInt(b.updatedAt),
           initialPriorityAt: BigInt(b.initialPriorityAt),
         })),
       });
     }
     if (world.freeAgentListings.length > 0) {
       await tx.freeAgentListing.createMany({
         data: world.freeAgentListings.map((l) => ({
           id: l.id,
           saveId,
           playerId: l.playerId,
           playerValueAtListing: l.playerValueAtListing,
           openingPrice: l.openingPrice,
           bidIncrement: l.bidIncrement,
           demandedSalary: l.demandedSalary,
           demandedContractDays: l.demandedContractDays,
           currentPrice: l.currentPrice,
           leadingClubId: l.leadingClubId,
           relistStage: l.relistStage,
           createdAt: BigInt(l.createdAt),
           deadline: BigInt(l.deadline),
           status: l.status,
           completedAt: l.completedAt !== null ? BigInt(l.completedAt) : null,
            winningClubId: l.winningClubId,
            finalPrice: l.finalPrice,
            previousListingId: l.previousListingId,
            blockedClubId: l.blockedClubId,
            softClosed: l.softClosed,
            softCloseExtensions: l.softCloseExtensions,
          })),
        });
      }
      if (world.marketReservations.length > 0) {
       await tx.marketReservation.createMany({
         data: world.marketReservations.map((r) => ({
           id: r.id,
           saveId,
           clubId: r.clubId,
           listingId: r.listingId,
           marketType: r.marketType,
           amount: r.amount,
           createdAt: BigInt(r.createdAt),
           releasedAt: r.releasedAt !== null ? BigInt(r.releasedAt) : null,
         })),
       });
     }
     if (world.playerMarketHistory.length > 0) {
       await tx.playerMarketTransaction.createMany({
         data: world.playerMarketHistory.map((t) => ({
           id: t.id,
           saveId,
           playerId: t.playerId,
           listingId: t.listingId,
           type: t.type,
           fromClubId: t.fromClubId,
           toClubId: t.toClubId,
           price: t.price,
           seasonId: t.seasonId,
           seasonKey: t.seasonKey,
           matchday: t.matchday,
           timestamp: BigInt(t.timestamp),
         })),
       });
     }
      if (world.aiEvaluations.length > 0) {
        await tx.aiEvaluation.createMany({
          data: world.aiEvaluations.map((e) => ({
            saveId,
            marketType: e.marketType,
            listingId: e.listingId,
            clubId: e.clubId,
            evaluatedAt: BigInt(e.evaluatedAt),
            decision: e.decision,
            maxBid: e.maxBid,
          })),
        });
      }
      if (world.mp.seasonId !== 0) {
       await tx.mpSeason.updateMany({
        where: { id: world.mp.seasonId },
        data: {
          completedRounds: world.mp.completedRounds,
          joinLockRound: world.mp.joinLockRound,
          joinThresholdPercent: world.mp.joinThresholdPercent,
          joinState: world.mp.joinState,
          status: world.mp.seasonStatus,
        },
      });
    }
    // Multiplayer queue + allocations (idempotent unique constraints).
    await tx.mpQueue.deleteMany({});
    await tx.mpAllocation.deleteMany({});
    if (world.mpQueue.length > 0) {
      await tx.mpQueue.createMany({
        data: world.mpQueue.map((q) => ({ clubId: q.clubId, source: q.source, queuedAt: new Date(q.queuedAt), preferredSeasonId: q.preferredSeasonId })),
      });
    }
    if (world.seasonAllocations.length > 0) {
      await tx.mpAllocation.createMany({
        data: world.seasonAllocations.map((a) => ({ clubId: a.clubId, seasonId: a.seasonId, type: a.type, amount: a.amount, issuedAt: new Date(a.issuedAt) })),
      });
    }
    // Normalized multiplayer records (plan §55). Memberships/season records are
    // disposable between seasons and fully rewritten each persist.
    await tx.mpMembership.deleteMany({});
    if (world.mpMemberships.length > 0) {
      await tx.mpMembership.createMany({
        data: world.mpMemberships.map((m) => ({
          divisionId: m.divisionId,
          clubId: m.clubId,
          slotNumber: m.slotNumber,
          isFillerAI: m.isFillerAI,
          replacedClubId: m.replacedClubId,
          joinedAt: new Date(m.joinedAt),
        })),
      });
    }
    await tx.mpClubSeason.deleteMany({});
    if (world.mpClubSeasons.length > 0) {
      await tx.mpClubSeason.createMany({
        data: world.mpClubSeasons.map((cs) => ({
          clubId: cs.clubId,
          seasonId: cs.seasonId,
          divisionId: cs.divisionId,
          tier: cs.tier,
          played: cs.played,
          wins: cs.wins,
          draws: cs.draws,
          losses: cs.losses,
          goalsFor: cs.goalsFor,
          goalsAgainst: cs.goalsAgainst,
          points: cs.points,
          promotionStatus: cs.promotionStatus,
          relegationStatus: cs.relegationStatus,
        })),
      });
    }
    await tx.mpActivity.deleteMany({});
    if (world.mpActivities.length > 0) {
      await tx.mpActivity.createMany({
        data: world.mpActivities.map((a) => ({ userId: a.userId, clubId: a.clubId, activityType: a.activityType, occurredAt: new Date(a.occurredAt), metadata: a.metadata })),
      });
    }
    for (const execution of opts?.dailyExecutions ?? []) {
      await tx.dailyExecution.upsert({
        where: { saveId_seasonId_date_executionType: { saveId, seasonId: execution.seasonId, date: execution.date, executionType: execution.executionType } },
        update: {},
        create: { saveId, seasonId: execution.seasonId, date: execution.date, executionType: execution.executionType },
      });
    }
  });
}

function clubRow(c: Club, saveId: number) {
   return {
     id: c.id,
     saveId,
     ownerUserId: c.ownerUserId,
     timezone: c.timezone,
     competitionState: c.competitionState,
     lastMeaningfulActivityAt: c.lastMeaningfulActivityAt !== null ? BigInt(c.lastMeaningfulActivityAt) : null,
     abandonmentEligibleAt: c.abandonmentEligibleAt !== null ? BigInt(c.abandonmentEligibleAt) : null,
     inactivityWarningStage: c.inactivityWarningStage ?? 0,
     liveMatchAt: c.liveMatchAt !== null ? BigInt(c.liveMatchAt) : null,
     name: c.name,
     shortName: c.shortName,
     country: c.country,
     highestDivision: c.highestDivision,
     cash: c.cash,
     stadiumName: c.stadiumName,
     stadiumCapacity: c.stadiumCapacity,
     primaryColor: c.primaryColor,
     secondaryColor: c.secondaryColor,
     coachName: c.coachName,
     isHuman: c.isHuman,
     captainId: c.captainId,
     penaltyTakerId: c.penaltyTakerId,
     tacticsFormation: c.tactics.formation,
     tacticsStyle: c.tactics.style,
     tacticsPressing: c.tactics.pressing,
     tacticsDirection: c.tactics.direction,
     trainingFocus: c.trainingFocus,
     savedLineupJson: c.savedLineup ? JSON.stringify(c.savedLineup) : null,
   };
 }

function playerRow(p: Player, saveId: number) {
  return {
    id: p.id,
    saveId,
    clubId: p.clubId,
    name: p.name,
    country: p.country,
    age: p.age,
    position: p.position,
    side: p.side,
    overall: p.overall,
    potential: p.potential,
    tier: p.tier,
    characteristic1: p.characteristic1,
    characteristic2: p.characteristic2,
    energy: p.energy,
    salary: p.salary,
    payrollPaidThroughDay: p.payrollPaidThroughDay,
    payrollPaidAmount: p.payrollPaidAmount,
    payrollPeriodStartDay: p.payrollPeriodStartDay,
    value: p.value,
    releaseClause: p.releaseClause,
    injuryDays: p.injuryDays,
    contractDays: p.contractDays,
    isYouth: p.isYouth,
    starter: p.starter,
    growthAcc: p.growthAcc,
    potentialAcc: p.potentialAcc,
    careerGoals: p.careerGoals,
    careerAssists: p.careerAssists,
    seasonGoals: p.seasonGoals,
    seasonAssists: p.seasonAssists,
    yellows: p.yellows,
    reds: p.reds,
    tacPos: p.tacPos,
     onSale: p.onSale,
     suspendedGames: p.suspendedGames,
    morale: p.morale,
    loanId: p.loanId,
    skillGol: p.skills.gol,
    skillVel: p.skills.vel,
    skillTec: p.skills.tec,
    skillPas: p.skills.pas,
    skillDes: p.skills.des,
    skillArm: p.skills.arm,
    skillFin: p.skills.fin,
    skillAccJson: JSON.stringify(p.skillAcc),
    declineStartAge: p.developmentProfile?.declineStartAge ?? null,
    developmentRate: p.developmentProfile?.developmentRate ?? null,
    developmentVolatility: p.developmentProfile?.developmentVolatility ?? null,
    recentMinutesJson: JSON.stringify(p.recentMinutes ?? []),
    generatedClubId: p.generatedClubId ?? null,
    generatedDivision: p.generatedDivision ?? null,
    generatedSeasonId: p.generatedSeasonId ?? null,
    generationType: p.generationType ?? null,
    generatedClubHighestDivision: p.generatedClubHighestDivision ?? null,
    rawZ: p.rawZ ?? null,
    financialInterventionGeneratedSeasonId: p.financialInterventionGeneratedSeasonId ?? null,
  };
}

function competitionRow(c: Competition, saveId: number) {
  return {
    id: c.id,
    saveId,
    kind: c.kind,
    name: c.name,
    round: c.round,
    stage: c.stage,
    seasonId: c.seasonId ?? null,
    tier: c.tier ?? 1,
    groupIndex: c.groupIndex ?? 0,
    status: c.status ?? "ACTIVE",
    configJson: JSON.stringify(c.config),
    winnersJson: JSON.stringify(c.winners),
    knockoutsJson: JSON.stringify(c.knockouts),
    groupStandingsJson: JSON.stringify(c.groupStandings),
  };
}

function emptyTeamStats(): MatchStats["home"] {
  return {
    controlledBallSeconds: 0,
    attackingThirdControlledSeconds: 0,
    possessions: 0,
    passes: 0,
    crosses: 0,
    carries: 0,
    dribbles: 0,
    turnovers: 0,
    highRecoveries: 0,
    counterattacks: 0,
    counterattackShots: 0,
    boxEntries: 0,
    shots: 0,
    shotsOnTarget: 0,
    xG: 0,
    corners: 0,
    fouls: 0,
    yellows: 0,
    reds: 0,
    offsides: 0,
    penalties: 0,
    injuries: 0,
  };
}

function emptyMatchStats(): MatchStats {
  return { home: emptyTeamStats(), away: emptyTeamStats() };
}

/** Convert a pre-overhaul MatchStat row (per-team int columns) into the new
 *  per-team object shape, so old saves without statsJson still load. */
function legacyStatRowToMatchStats(s: Record<string, unknown>): MatchStats {
  const num = (k: string) => (typeof s[k] === "number" ? s[k] as number : 0);
  return {
    home: {
      ...emptyTeamStats(),
      shots: num("homeShots"),
      shotsOnTarget: num("homeOnGoal"),
      fouls: num("homeFouls"),
      corners: num("homeCorners"),
      yellows: num("homeYellows"),
      reds: num("homeReds"),
    },
    away: {
      ...emptyTeamStats(),
      shots: num("awayShots"),
      shotsOnTarget: num("awayOnGoal"),
      fouls: num("awayFouls"),
      corners: num("awayCorners"),
      yellows: num("awayYellows"),
      reds: num("awayReds"),
    },
  };
}

function statRow(m: Match, saveId: number) {
  const s: MatchStats = m.stats;
  return {
    saveId,
    matchId: m.id,
    statsJson: JSON.stringify(s),
  };
}

async function rebuildWorld(
  prisma: PrismaClient,
  saveRow: { id: number; seed: number; year: number; dayIndex: number; humanClubId: number | null; rngState: bigint; mpStateJson?: string | null; seasonSummaryJson: string | null; pendingEventsJson: string | null; pendingMatchIdsJson: string | null; generationEventsJson?: string | null; financialInterventionsJson?: string | null }
): Promise<World> {
   const [
     clubRows,
     playerRows,
     loanRows,
     competitionRows,
     standingsRows,
     fixtureRows,
     matchRows,
     statRows,
     eventRows,
     newsRows,
     ledgerRows,
     transferAuctionRows,
     marketBidRows,
     freeAgentListingRows,
     marketReservationRows,
     playerMarketTransactionRows,
     aiEvaluationRows,
     trophyRows,
     managerRows,
     awardRows,
     recordRows,
     ticketRows,
     upgradeRows,
     liveRow,
     mpQueueRows,
     mpAllocationRows,
     mpMembershipRows,
     mpClubSeasonRows,
     mpActivityRows,
   ] = await Promise.all([
     prisma.club.findMany({ where: { saveId: saveRow.id } }),
     prisma.player.findMany({ where: { saveId: saveRow.id } }),
     prisma.loan.findMany({ where: { saveId: saveRow.id } }),
     prisma.competition.findMany({ where: { saveId: saveRow.id } }),
     prisma.standingsRow.findMany({ where: { saveId: saveRow.id } }),
     prisma.fixture.findMany({ where: { saveId: saveRow.id } }),
     prisma.match.findMany({ where: { saveId: saveRow.id } }),
     prisma.matchStat.findMany({ where: { saveId: saveRow.id } }),
     prisma.matchEvent.findMany({ where: { saveId: saveRow.id }, orderBy: { ordinal: "asc" } }),
     prisma.newsItem.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.ledgerEntry.findMany({ where: { saveId: saveRow.id } }),
     prisma.transferAuction.findMany({ where: { saveId: saveRow.id } }),
     prisma.marketBid.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.freeAgentListing.findMany({ where: { saveId: saveRow.id } }),
     prisma.marketReservation.findMany({ where: { saveId: saveRow.id } }),
     prisma.playerMarketTransaction.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.aiEvaluation.findMany({ where: { saveId: saveRow.id } }),
     prisma.trophy.findMany({ where: { saveId: saveRow.id } }),
     prisma.managerHistory.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.seasonAward.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.careerRecord.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.clubTicketPrices.findMany({ where: { saveId: saveRow.id } }),
     prisma.stadiumUpgrade.findMany({ where: { saveId: saveRow.id } }),
     prisma.liveMatch.findMany({ where: { saveId: saveRow.id } }),
     prisma.mpQueue.findMany({ orderBy: { queuedAt: "asc" } }),
     prisma.mpAllocation.findMany(),
     prisma.mpMembership.findMany(),
     prisma.mpClubSeason.findMany(),
     prisma.mpActivity.findMany({ orderBy: { id: "asc" } }),
   ]);

  const clubs: Club[] = clubRows.map((r) => {
    const r2 = r as unknown as {
      ownerUserId: number | null;
      timezone: string | null;
      competitionState: string;
      lastMeaningfulActivityAt: bigint | null;
      abandonmentEligibleAt: bigint | null;
      inactivityWarningStage: number | null;
      liveMatchAt: bigint | null;
      highestDivision: number | null;
    };
    return {
      id: r.id,
      name: r.name,
      shortName: r.shortName,
      ownerUserId: r2.ownerUserId ?? null,
      timezone: r2.timezone ?? null,
      competitionState: (r2.competitionState ?? "ACTIVE") as Club["competitionState"],
      lastMeaningfulActivityAt: r2.lastMeaningfulActivityAt !== null && r2.lastMeaningfulActivityAt !== undefined ? Number(r2.lastMeaningfulActivityAt) : null,
      abandonmentEligibleAt: r2.abandonmentEligibleAt !== null && r2.abandonmentEligibleAt !== undefined ? Number(r2.abandonmentEligibleAt) : null,
      inactivityWarningStage: r2.inactivityWarningStage ?? 0,
      liveMatchAt: r2.liveMatchAt !== null && r2.liveMatchAt !== undefined ? Number(r2.liveMatchAt) : null,
      country: r.country,
      highestDivision: r2.highestDivision ?? 1,
      cash: r.cash,
      stadiumName: r.stadiumName,
      stadiumCapacity: r.stadiumCapacity,
      primaryColor: r.primaryColor,
      secondaryColor: r.secondaryColor,
      coachName: r.coachName,
      tactics: { formation: r.tacticsFormation, style: r.tacticsStyle, pressing: r.tacticsPressing, direction: r.tacticsDirection },
      trainingFocus: ((r as unknown as { trainingFocus?: string }).trainingFocus ?? "assistant") as Club["trainingFocus"],
      captainId: r.captainId,
      penaltyTakerId: r.penaltyTakerId,
      savedLineup: jsonOr<Club["savedLineup"]>(r.savedLineupJson, null),
      isHuman: r.isHuman,
      ledger: { income: [], expense: [] },
      trophies: {},
    };
  });

   const players: Player[] = playerRows.map((r) => {
     const saved = r as unknown as { declineStartAge: number | null; developmentRate: number | null; developmentVolatility: number | null; recentMinutesJson: string | null };
     // Backfill deterministically unless the whole profile is present and sane;
     // never silently substitute arbitrary defaults for a partial profile.
     const profileValid =
       saved.declineStartAge !== null && saved.declineStartAge !== undefined &&
       saved.developmentRate !== null && saved.developmentRate !== undefined &&
       saved.developmentVolatility !== null && saved.developmentVolatility !== undefined &&
       Number.isFinite(saved.declineStartAge) && Number.isFinite(saved.developmentRate) && Number.isFinite(saved.developmentVolatility);
     const profile = profileValid
       ? {
           declineStartAge: saved.declineStartAge as number,
           developmentRate: saved.developmentRate as number,
           developmentVolatility: saved.developmentVolatility as number,
         }
       : backfillDevelopmentProfile(saveRow.seed, r.id);
     return {
       id: r.id,
       name: r.name,
       country: r.country,
       age: r.age,
       position: r.position as Player["position"],
       side: r.side,
       skills: { gol: r.skillGol, vel: r.skillVel, tec: r.skillTec, pas: r.skillPas, des: r.skillDes, arm: r.skillArm, fin: r.skillFin },
       overall: r.overall,
       potential: r.potential,
       tier: r.tier,
       characteristic1: r.characteristic1,
       characteristic2: r.characteristic2,
       energy: r.energy,
       salary: r.salary,
       payrollPaidThroughDay: (r as typeof r & { payrollPaidThroughDay?: number }).payrollPaidThroughDay ?? 0,
       payrollPaidAmount: (r as typeof r & { payrollPaidAmount?: number }).payrollPaidAmount ?? 0,
       payrollPeriodStartDay: (r as typeof r & { payrollPeriodStartDay?: number }).payrollPeriodStartDay ?? 0,
       value: r.value,
       releaseClause: r.releaseClause,
       injuryDays: r.injuryDays,
       contractDays: r.contractDays,
       isYouth: r.isYouth,
       starter: r.starter,
       growthAcc: r.growthAcc,
       potentialAcc: r.potentialAcc,
       skillAcc: jsonOr<number[]>(r.skillAccJson, [0, 0, 0, 0, 0, 0, 0]),
       careerGoals: r.careerGoals,
       careerAssists: r.careerAssists,
       seasonGoals: r.seasonGoals,
       seasonAssists: r.seasonAssists,
       yellows: r.yellows,
       reds: r.reds,
       clubId: r.clubId,
       tacPos: r.tacPos,
       onSale: r.onSale,
       suspendedGames: r.suspendedGames,
       morale: r.morale,
       loanId: r.loanId,
        developmentProfile: profile,
        recentMinutes: sanitizeRecentMinutes(saved.recentMinutesJson),
        generatedClubId: (r as unknown as { generatedClubId?: number | null }).generatedClubId ?? null,
        generatedDivision: (r as unknown as { generatedDivision?: number | null }).generatedDivision ?? null,
        generatedSeasonId: (r as unknown as { generatedSeasonId?: number | null }).generatedSeasonId ?? null,
        generationType: (r as unknown as { generationType?: string | null }).generationType ?? null,
        generatedClubHighestDivision: (r as unknown as { generatedClubHighestDivision?: number | null }).generatedClubHighestDivision ?? null,
        rawZ: (r as unknown as { rawZ?: number | null }).rawZ ?? null,
        financialInterventionGeneratedSeasonId: (r as unknown as { financialInterventionGeneratedSeasonId?: number | null }).financialInterventionGeneratedSeasonId ?? null,
      } as Player;
   });

  for (const player of players) {
    normalizePlayer(player, clubs.find((club) => club.id === player.clubId));
  }

  const competitions: Competition[] = competitionRows.map((r) => {
    const r2 = r as unknown as { seasonId: number | null; tier: number; groupIndex: number; status: string };
    return {
      id: r.id,
      kind: r.kind as Competition["kind"],
      name: r.name,
      round: r.round,
      stage: r.stage as Competition["stage"],
      seasonId: r2.seasonId ?? undefined,
      tier: r2.tier ?? 1,
      groupIndex: r2.groupIndex ?? 0,
      status: r2.status ?? "ACTIVE",
      config: jsonOr(r.configJson, { clubs: [], turns: 2, groups: [], bracket: [], promoted: 0, relegated: 0, groupQualifiers: 0 }),
      winners: jsonOr<number[]>(r.winnersJson, []),
      knockouts: jsonOr(r.knockoutsJson, []),
      groupStandings: jsonOr<GroupStandings[]>(r.groupStandingsJson, []),
      standings: {},
    };
  });

  for (const r of standingsRows) {
    const comp = competitions.find((c) => c.id === r.competitionId);
    if (!comp) continue;
    const row: StandingsRow = { clubId: r.clubId, played: r.played, wins: r.wins, draws: r.draws, losses: r.losses, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, points: r.points };
    if (r.groupName !== null && r.groupName !== undefined) {
      let g = comp.groupStandings.find((x) => x.groupName === r.groupName);
      if (!g) {
        g = { groupName: r.groupName, rows: {} };
        comp.groupStandings.push(g);
      }
      g.rows[r.clubId] = row;
    } else {
      comp.standings[r.clubId] = row;
    }
  }

  const fixtures = fixtureRows.map((f) => {
    const f2 = f as unknown as { kickoffAt: bigint | null };
    return {
      id: f.id,
      competitionId: f.competitionId,
      round: f.round,
      homeClubId: f.homeClubId,
      awayClubId: f.awayClubId,
      dayIndex: f.dayIndex,
      played: f.played,
      leg: f.leg ?? undefined,
      tie: f.tie ?? undefined,
      kickoffAt: f2.kickoffAt !== null && f2.kickoffAt !== undefined ? Number(f2.kickoffAt) : undefined,
    };
  });

  const statByMatch = new Map(statRows.map((s) => [s.matchId, s]));
  const eventsByMatch = new Map<number, Match["events"]>();
  for (const e of eventRows) {
    const list = eventsByMatch.get(e.matchId) ?? [];
    list.push({ minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, playerId: e.playerId, player2Id: e.player2Id, goalType: e.goalType });
    eventsByMatch.set(e.matchId, list);
  }
  const matches: Match[] = matchRows.map((r) => {
    const s = statByMatch.get(r.id);
    return {
      id: r.id,
      fixtureId: r.fixtureId,
      competitionId: r.competitionId,
      homeClubId: r.homeClubId,
      awayClubId: r.awayClubId,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      penaltyWinnerId: r.penaltyWinnerId,
      penaltyScore: jsonOr<[number, number] | undefined>(r.penaltyScoreJson, undefined),
      attendance: r.attendance,
      gateRevenue: r.gateRevenue,
      events: eventsByMatch.get(r.id) ?? [],
      stats: s
        ? jsonOr<MatchStats>(
            (s as unknown as { statsJson?: string | null }).statsJson,
            legacyStatRowToMatchStats(s)
          )
        : emptyMatchStats(),
      extraTime: r.extraTime,
      minuteEvents: [],
    };
  });

  for (const l of ledgerRows) {
    const club = clubs.find((c) => c.id === l.clubId);
    if (!club) continue;
    const entry = { code: l.code, amount: l.amount, day: l.day, label: l.label };
    if (l.direction === "income") club.ledger.income.push(entry);
    else club.ledger.expense.push(entry);
  }

  for (const t of trophyRows) {
    const club = clubs.find((c) => c.id === t.clubId);
    if (club) club.trophies[t.competitionName] = t.count;
  }

   const auctions = transferAuctionRows.map((a) => ({
     id: a.id,
     playerId: a.playerId,
     sellerClubId: a.sellerClubId,
     playerValueAtListing: a.playerValueAtListing,
     openingPrice: a.openingPrice,
     bidIncrement: a.bidIncrement,
     sellerDivisionAtListing: a.sellerDivisionAtListing,
     totalDivisionsAtListing: a.totalDivisionsAtListing,
     currentPrice: a.currentPrice,
     leadingClubId: a.leadingClubId,
     bids: marketBidRows.filter((b) => b.listingId === a.id && b.marketType === "TRANSFER").map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: Number(b.initialPriorityAt) })),
     createdAt: Number(a.createdAt),
     deadline: Number(a.deadline),
     originalDeadline: Number(a.originalDeadline),
     status: (a.status as AuctionStatus) ?? "ACTIVE",
     completedAt: a.completedAt !== null ? Number(a.completedAt) : null,
     winningClubId: a.winningClubId,
     finalPrice: a.finalPrice,
     cancelledAt: a.cancelledAt !== null ? Number(a.cancelledAt) : null,
     softClosed: a.softClosed,
     softCloseExtensions: a.softCloseExtensions,
   }));

   const freeAgentListings = freeAgentListingRows.map((l) => ({
     id: l.id,
     playerId: l.playerId,
     playerValueAtListing: l.playerValueAtListing,
     openingPrice: l.openingPrice,
     bidIncrement: l.bidIncrement,
     demandedSalary: l.demandedSalary,
     demandedContractDays: l.demandedContractDays,
     currentPrice: l.currentPrice,
     leadingClubId: l.leadingClubId,
     relistStage: l.relistStage,
     bids: marketBidRows.filter((b) => b.listingId === l.id && b.marketType === "FREE_AGENT").map((b) => ({ clubId: b.clubId, maxBid: b.maxBid, initialPriorityAt: Number(b.initialPriorityAt) })),
     createdAt: Number(l.createdAt),
     deadline: Number(l.deadline),
     status: (l.status as AuctionStatus) ?? "ACTIVE",
     completedAt: l.completedAt !== null ? Number(l.completedAt) : null,
     winningClubId: l.winningClubId,
     finalPrice: l.finalPrice,
     previousListingId: l.previousListingId,
     blockedClubId: l.blockedClubId ?? null,
     softClosed: l.softClosed,
     softCloseExtensions: l.softCloseExtensions,
   }));

   const marketBidsList = marketBidRows.map((b) => ({
     id: b.id,
     marketType: (b.marketType as "TRANSFER" | "FREE_AGENT"),
     listingId: b.listingId,
     clubId: b.clubId,
     maxBid: b.maxBid,
     capMultiplierAtSubmission: b.capMultiplierAtSubmission ?? undefined,
     maximumAllowedByRuleAtSubmission: b.maximumAllowedByRuleAtSubmission ?? undefined,
     buyerDivisionAtSubmission: b.buyerDivisionAtSubmission ?? undefined,
     createdAt: Number(b.createdAt),
     updatedAt: Number(b.updatedAt),
     initialPriorityAt: Number(b.initialPriorityAt),
   }));

   const marketReservations = marketReservationRows.map((r) => ({
     id: r.id,
     clubId: r.clubId,
     listingId: r.listingId,
     marketType: (r.marketType as "TRANSFER" | "FREE_AGENT"),
     amount: r.amount,
     createdAt: Number(r.createdAt),
     releasedAt: r.releasedAt !== null ? Number(r.releasedAt) : null,
   }));

   const playerMarketHistory = playerMarketTransactionRows.map((t) => ({
     id: t.id,
     playerId: t.playerId,
     listingId: t.listingId,
     type: (t.type as "TRANSFER" | "FREE_AGENT_SIGNING" | "LOAN"),
     fromClubId: t.fromClubId,
     toClubId: t.toClubId,
     price: t.price,
     seasonId: t.seasonId,
     seasonKey: t.seasonKey,
     matchday: t.matchday,
     timestamp: Number(t.timestamp),
   }));

   const aiEvaluations = aiEvaluationRows.map((e) => ({
     marketType: (e.marketType as "TRANSFER" | "FREE_AGENT"),
     listingId: e.listingId,
     clubId: e.clubId,
     evaluatedAt: Number(e.evaluatedAt),
     decision: e.decision,
     maxBid: e.maxBid ?? null,
   }));

   const world: World = {
     seed: saveRow.seed,
     year: saveRow.year,
     dayIndex: saveRow.dayIndex,
     dayOfWeek: ((saveRow.dayIndex % 7) + 7) % 7,
     nextId: 1,
     clubs,
     players,
     competitions,
    fixtures,
    matches,
    news: newsRows.map((n) => ({ dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? undefined })),
     transferAuctions: auctions,
     marketBids: marketBidsList,
     freeAgentListings,
     marketReservations,
     playerMarketHistory,
     aiEvaluations,
     loans: loanRows.map((l) => ({ id: l.id, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled, listedAt: Number(l.listedAt), claimableAt: Number(l.claimableAt) })),
     seasonAwards: awardRows.map((a) => ({ season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })),
     records: recordRows.map((r) => ({ category: r.category, value: r.value, holderName: r.holderName })),
     managerHistory: managerRows.map((m) => ({ clubId: m.clubId, name: m.name, appointedDay: m.appointedDay, departedDay: m.departedDay, gamesInCharge: m.gamesInCharge, reason: m.reason })),
     ticketPrices: Object.fromEntries(ticketRows.map((t) => [t.clubId, [t.sector0, t.sector1, t.sector2, t.sector3]])),
    stadiumUpgrades: upgradeRows.map((u) => ({ clubId: u.clubId, startedDay: u.startedDay, completesDay: u.completesDay, newCapacity: u.newCapacity, cost: u.cost, completed: u.completed })),
     humanClubId: saveRow.humanClubId,
     seasonSummary: jsonOr(saveRow.seasonSummaryJson, null),
     rng: createRng(saveRow.seed),
     contractWarnings: [],
     mp: {
       seasonId: 0,
       seasonYear: saveRow.year,
       seasonMonth: 1,
       seasonStatus: "PREPARATION",
       completedRounds: 0,
       joinLockRound: 7,
       joinState: "OPEN",
       joinThresholdPercent: 0.5,
       inactivityThresholds: { 1: 42, 2: 35, default: 28 },
       matchTimeMode: "DIVISION_LOCAL_KICKOFF",
       matchKickoffHour: 20,
       lastProcessedGameDay: 0,
       lastDailyTickDay: 0,
       lastDailyTickDate: null,
       manualRound: null,
       rolloverPhase: null,
       ...jsonOr<Partial<World["mp"]>>((saveRow as unknown as { mpStateJson?: string | null }).mpStateJson, {}),
     },
     mpQueue: [],
     liveMatches: [],
     seasonAllocations: [],
     mpMemberships: [],
     mpClubSeasons: [],
     mpActivities: [],
     mpAudits: [],
      seasonHistory: [],
      generationEvents: [],
      financialInterventions: [],
  };
  world.rng.state = Number(saveRow.rngState);
   world.nextId =
     Math.max(
       1,
       ...[...clubs.map((c) => c.id), ...players.map((p) => p.id), ...competitions.map((c) => c.id), ...fixtures.map((f) => f.id), ...matches.map((m) => m.id), ...auctions.map((a) => a.id), ...freeAgentListings.map((l) => l.id), ...world.loans.map((l) => l.id)]
     ) + 1;
   world.liveMatches = (liveRow ?? []).map((r) => jsonOr<LiveMatchState | null>(r.stateJson, null)).filter((x): x is LiveMatchState => !!x);
   for (const st of world.liveMatches) hydrateLiveMatchState(st, world);
  world.mpQueue = (mpQueueRows ?? []).map((q) => ({ clubId: q.clubId, source: q.source as "NEW_CLUB" | "RETURNING_CLUB", queuedAt: q.queuedAt.getTime(), preferredSeasonId: q.preferredSeasonId }));
  world.seasonAllocations = (mpAllocationRows ?? []).map((a) => ({ clubId: a.clubId, seasonId: a.seasonId, type: a.type as "ACTIVE_FULL" | "ACTIVE_PRORATED" | "PROVISIONAL_NEXT_SEASON", amount: a.amount, issuedAt: a.issuedAt.getTime() }));
  world.mpMemberships = (mpMembershipRows ?? []).map((m) => ({ divisionId: m.divisionId, clubId: m.clubId, slotNumber: m.slotNumber, isFillerAI: m.isFillerAI, replacedClubId: m.replacedClubId, joinedAt: m.joinedAt.getTime() }));
  world.mpClubSeasons = (mpClubSeasonRows ?? []).map((cs) => ({
    clubId: cs.clubId,
    seasonId: cs.seasonId,
    divisionId: cs.divisionId,
    tier: cs.tier,
    played: cs.played,
    wins: cs.wins,
    draws: cs.draws,
    losses: cs.losses,
    goalsFor: cs.goalsFor,
    goalsAgainst: cs.goalsAgainst,
    points: cs.points,
    promotionStatus: cs.promotionStatus,
    relegationStatus: cs.relegationStatus,
  }));
  world.mpActivities = (mpActivityRows ?? []).map((a) => ({ userId: a.userId, clubId: a.clubId, activityType: a.activityType, occurredAt: a.occurredAt.getTime(), metadata: a.metadata }));
   world.pendingDayEvents = jsonOr<string[] | undefined>(saveRow.pendingEventsJson, undefined);
   world.pendingDayMatchIds = jsonOr<number[] | undefined>(saveRow.pendingMatchIdsJson, undefined);
   world.generationEvents = jsonOr<string[]>(saveRow.generationEventsJson, []);
   world.financialInterventions = jsonOr<World["financialInterventions"]>((saveRow as unknown as { financialInterventionsJson?: string | null }).financialInterventionsJson, []);
   const persistedIds = [
     ...marketBidRows.map((row) => row.id),
     ...marketReservationRows.map((row) => row.id),
     ...playerMarketTransactionRows.map((row) => row.id),
     ...world.financialInterventions.map((event) => event.id),
   ];
   if (persistedIds.length > 0) world.nextId = Math.max(world.nextId, Math.max(...persistedIds) + 1);
   return world;
}

/** Hydrate one live match in one place for both JSON and relational saves. */
function hydrateLiveMatchState(st: LiveMatchState, world: World): void {
  st.compKind ??= "division";
  st.year ??= world.year;
  st.subbedIn ??= [[], []];
  st.possessionCounts ??= [0, 0];
  st.playerYellows ??= {};
  st.subSlots ??= { gn: [[-1, -1, -1], [-1, -1, -1]], gm: [[-1, -1, -1, -1], [-1, -1, -1, -1]] };
  st.suspensionClears ??= [];
  st.lastAdvancedAt ??= Date.now();
  st.firstHalfLen ??= MS.timing.firstHalfEndSeconds / 60;
  st.secondHalfLen ??= (MS.timing.regulationSeconds - MS.timing.firstHalfEndSeconds) / 60;

  st.stats = normalizeMatchStats(st.stats);
  st.teamStats = normalizeMatchStats(st.teamStats ?? st.stats);

  // Pre-overhaul live states only had half/minute. Convert that progress before
  // applying defaults; assigning zero here would replay the match from kickoff
  // after a server restart.
  if (typeof st.matchClockSeconds !== "number") {
    const firstHalf = st.firstHalfLen;
    const legacyHalf = st.half === 1 ? 1 : 0;
    const legacyMinute = Math.max(0, typeof st.minute === "number" ? st.minute : 0);
    st.matchClockSeconds = ((legacyHalf === 1 ? firstHalf : 0) + legacyMinute) * 60;
    st.period = legacyHalf === 1 ? 2 : 1;
  } else {
    st.period ??= 1;
  }
  st.rngState ??= { seed: world.seed, state: world.rng?.state ?? 0 };
  st.controlledBallSeconds ??= [0, 0];
  st.attackingThirdControlledSeconds ??= [0, 0];
  st.phase ??= "BUILD_UP";
  st.zone ??= "DEF_CENTRAL";
  st.lane ??= "CENTRE";
  st.possessionStartType ??= "OPEN_PLAY";
  st.possessionAgeSeconds ??= 0;
  st.homeTactics ??= { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 };
  st.awayTactics ??= { formation: 4, style: "CONTROL", pressing: 0, direction: "CENTRE", familiarity: 50 };
  st.homeDefensiveOrganisation ??= 0;
  st.awayDefensiveOrganisation ??= 0;
  st.homeBaselineOrganisation ??= 0;
  st.awayBaselineOrganisation ??= 0;
  st.homeOrganisationRecoveryTime ??= 1;
  st.awayOrganisationRecoveryTime ??= 1;
  st.cards ??= [];
  st.injuries ??= [];
  st.substitutions ??= [];
  st.isCounter ??= false;
  st.possessionHighRecovery ??= false;
  st.opponentControlSeconds ??= [0, 0];
  st.pressureWindowAdvancedStates ??= [0, 0];
  st.pressureWindowStartSeconds ??= [0, 0];
  st.pendingRestart ??= null;
  st.possessionFirstAction ??= null;
  st.withBall ??= 0;
  st.playerEnergy ??= {};
  const playerIds = new Set([...st.homeXI, ...st.awayXI, ...st.homeSubs, ...st.awaySubs, ...st.homeOn, ...st.awayOn]);
  for (const id of playerIds) {
    if (typeof st.playerEnergy[id] !== "number") {
      const player = world.players.find((candidate) => candidate.id === id);
      if (player) st.playerEnergy[id] = player.energy;
    }
  }
}
