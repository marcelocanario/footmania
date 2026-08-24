import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AuctionStatus,
  Club,
  ClubEloEvent,
  Competition,
  Fixture,
  FreeAgentListing,
  GroupStandings,
  Loan,
  LiveMatchState,
  MarketBid,
  MarketReservation,
  Match,
  MatchStats,
  MpFriendshipEntry,
  Player,
  PlayerMarketTransaction,
  CareerRecord,
  NewsItem,
  SeasonAward,
  StandingsRow,
  TransferAuction,
  World,
} from "../game/types";
import { generateWorld } from "../game/worldgen";
import { createRng } from "../game/rng";
import { backfillDevelopmentProfile, overallFromSkills } from "../game/player";
import { DEVELOPMENT } from "../game/constants";
import { parseStoredPresets } from "../game/automation";
import { deserializeClubKits, serializeClubKits } from "../game/kits";
import { MATCH_SIMULATOR_CONFIG as MS } from "../matchSimulatorConfig";
import { calculateBaseSalary, calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "../game/economy";
import { ELO_CONFIG, gameConfig, MP_CONFIG } from "../config";
import { calendarValues, phaseForSeasonDayIndex } from "./seasonCalendar";
import { ensureNamePools } from "./namePoolService";

type Tx = Prisma.TransactionClient;

interface CachedWorld {
  revision: number;
  world: World;
}

// Save.revision is the cross-process invalidation signal. Callers receive a
// clone so a mutation cannot expose partially changed state to a read route.
const worldCaches = new WeakMap<PrismaClient, Map<number, CachedWorld>>();
const mutationBaselines = new WeakMap<PrismaClient, Map<number, CachedWorld>>();

function cloneWorld(world: World): World {
  return structuredClone(world);
}

function rememberWorld(prisma: PrismaClient, saveId: number, revision: number, world: World): void {
  let cache = worldCaches.get(prisma);
  if (!cache) {
    cache = new Map<number, CachedWorld>();
    worldCaches.set(prisma, cache);
  }
  cache.set(saveId, { revision, world: cloneWorld(world) });
}

function changedWorldCollections(previous: World | undefined, world: World): Set<string> {
  if (!previous) return new Set(TABLE_NAMES);
  const changed = <K extends keyof World>(key: K): boolean => JSON.stringify(previous[key]) !== JSON.stringify(world[key]);
  const clubCore = (club: Club) => {
    const { ledger: _ledger, trophies: _trophies, ...core } = club;
    return core;
  };
  const clubsCoreChanged = JSON.stringify(previous.clubs.map(clubCore)) !== JSON.stringify(world.clubs.map(clubCore));
  const ledgersChanged = previous.clubs.some((club, index) => JSON.stringify(club.ledger) !== JSON.stringify(world.clubs[index]?.ledger));
  const trophiesChanged = previous.clubs.some((club, index) => JSON.stringify(club.trophies) !== JSON.stringify(world.clubs[index]?.trophies));
  const tables = new Set<string>();
  if (clubsCoreChanged) tables.add("club");
  if (ledgersChanged) {
    tables.add("ledgerEntry");
  }
  if (trophiesChanged) {
    tables.add("trophy");
  }
  if (changed("clubs")) {
    tables.add("club");
  }
  if (changed("players")) tables.add("player");
  if (changed("loans")) tables.add("loan");
  if (changed("competitions")) {
    tables.add("competition");
    tables.add("standingsRow");
  }
  if (changed("fixtures")) tables.add("fixture");
  if (changed("matches")) {
    tables.add("match");
    tables.add("matchStat");
    tables.add("matchEvent");
  }
  if (changed("clubEloEvents")) tables.add("clubEloEvent");
  if (changed("news")) tables.add("newsItem");
  if (changed("transferAuctions")) tables.add("transferAuction");
  if (changed("marketBids")) tables.add("marketBid");
  if (changed("freeAgentListings")) tables.add("freeAgentListing");
  if (changed("marketReservations")) tables.add("marketReservation");
  if (changed("playerMarketHistory")) tables.add("playerMarketTransaction");
  if (changed("seasonAwards")) tables.add("seasonAward");
  if (changed("records")) tables.add("careerRecord");
  if (changed("liveMatches")) tables.add("liveMatch");
  return tables;
}

export function invalidateWorldCache(prisma: PrismaClient, saveId?: number): void {
  if (saveId === undefined) {
    worldCaches.delete(prisma);
    mutationBaselines.delete(prisma);
  } else {
    worldCaches.get(prisma)?.delete(saveId);
    mutationBaselines.get(prisma)?.delete(saveId);
  }
}

/**
 * Friendships live in their own table outside the serialized world, but season
 * regrouping reads them through World.friendships, which is only materialized
 * when a world is rebuilt. Bump Save.revision — the cross-process invalidation
 * signal every load compares against its cache — and drop the local cache so
 * the next world load (here and in any other process) picks up the new edges
 * before the rollover groups divisions. Callers run this under withGlobalLock.
 */
export async function notifyFriendshipsChanged(prisma: PrismaClient): Promise<void> {
  await prisma.save.updateMany({ where: { isGlobal: true }, data: { revision: { increment: 1 } } });
  invalidateWorldCache(prisma);
}

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
  "clubEloEvent",
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
  "trophy",
  "loan",
  "seasonAward",
  "careerRecord",
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

type LoadedWorld = { save: { id: number; name: string; revision: number }; world: World };

async function loadGlobalWorldInternal(prisma: PrismaClient, cloneCached: boolean): Promise<LoadedWorld | null> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true } });
  if (!save) return null;
  if (process.env.NODE_ENV !== "test") {
    const cached = worldCaches.get(prisma)?.get(save.id);
    if (cached?.revision === save.revision) {
      return { save: { id: save.id, name: save.name, revision: save.revision }, world: cloneCached ? cloneWorld(cached.world) : cached.world };
    }
  }
  const world = await rebuildWorld(prisma, save);
  if (process.env.NODE_ENV !== "test") rememberWorld(prisma, save.id, save.revision, world);
  return { save: { id: save.id, name: save.name, revision: save.revision }, world };
}

export function loadGlobalWorld(prisma: PrismaClient): Promise<LoadedWorld | null> {
  return loadGlobalWorldInternal(prisma, true);
}

/** Read-only routes may share the cached immutable world and avoid cloning it. */
export function loadGlobalWorldReadOnly(prisma: PrismaClient): Promise<LoadedWorld | null> {
  return loadGlobalWorldInternal(prisma, false);
}

/**
 * Detach the cached world for an in-lock mutation. Readers keep using the last
 * committed cache while the caller mutates this detached instance; persistWorld
 * installs a fresh protected cache after the transaction succeeds.
 */
export async function loadGlobalWorldMutable(prisma: PrismaClient): Promise<LoadedWorld | null> {
  const loaded = await loadGlobalWorldInternal(prisma, false);
  if (loaded) {
    const cache = worldCaches.get(prisma);
    const cached = cache?.get(loaded.save.id);
    if (cached?.revision === loaded.save.revision) {
      let baselines = mutationBaselines.get(prisma);
      if (!baselines) {
        baselines = new Map<number, CachedWorld>();
        mutationBaselines.set(prisma, baselines);
      }
      baselines.set(loaded.save.id, cached);
    }
    cache?.delete(loaded.save.id);
  }
  return loaded;
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
    const loaded = await loadGlobalWorldMutable(prisma);
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
  const cached = expectedRevision === undefined
    ? undefined
    : worldCaches.get(prisma)?.get(saveId) ?? mutationBaselines.get(prisma)?.get(saveId);
  const previous = cached !== undefined && cached.revision === expectedRevision ? cached.world : undefined;
  const rewriteTables = changedWorldCollections(previous, world);
  const previousClubById = new Map((previous?.clubs ?? []).map((club) => [club.id, club]));
  const previousPlayerById = new Map((previous?.players ?? []).map((player) => [player.id, player]));
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
          seasonHistoryJson: world.seasonHistory.length > 0 ? JSON.stringify(world.seasonHistory) : null,
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
          seasonHistoryJson: world.seasonHistory.length > 0 ? JSON.stringify(world.seasonHistory) : null,
          pendingEventsJson: world.pendingDayEvents ? JSON.stringify(world.pendingDayEvents) : null,
          pendingMatchIdsJson: world.pendingDayMatchIds ? JSON.stringify(world.pendingDayMatchIds) : null,
          generationEventsJson: world.generationEvents ? JSON.stringify(world.generationEvents) : null,
          financialInterventionsJson: world.financialInterventions ? JSON.stringify(world.financialInterventions) : null,
          revision: { increment: 1 },
        },
      });
    }
    const stableDeltaTables = new Set<string>();
    if (previous) {
      if (rewriteTables.has("loan")) {
        await syncStableEntities(tx, "loan", saveId, previous.loans, world.loans, (entity) => loanRow(entity, saveId));
        stableDeltaTables.add("loan");
      }
      if (rewriteTables.has("competition")) {
        await syncStableEntities(tx, "competition", saveId, previous.competitions, world.competitions, (entity) => competitionRow(entity, saveId));
        stableDeltaTables.add("competition");
        const previousById = new Map(previous.competitions.map((competition) => [competition.id, competition]));
        const currentById = new Map(world.competitions.map((competition) => [competition.id, competition]));
        const standingsCompetitionIds = new Set<number>();
        for (const competition of previous.competitions) {
          const next = currentById.get(competition.id);
          if (!next || JSON.stringify(competition.standings) !== JSON.stringify(next.standings) || JSON.stringify(competition.groupStandings) !== JSON.stringify(next.groupStandings)) standingsCompetitionIds.add(competition.id);
        }
        for (const competition of world.competitions) {
          const old = previousById.get(competition.id);
          if (!old || JSON.stringify(old.standings) !== JSON.stringify(competition.standings) || JSON.stringify(old.groupStandings) !== JSON.stringify(competition.groupStandings)) standingsCompetitionIds.add(competition.id);
        }
        if (standingsCompetitionIds.size > 0) {
          await tx.standingsRow.deleteMany({ where: { saveId, competitionId: { in: [...standingsCompetitionIds] } } });
          const rows = world.competitions.filter((competition) => standingsCompetitionIds.has(competition.id)).flatMap((competition) => standingsRowsForCompetition(competition, saveId));
          if (rows.length > 0) await tx.standingsRow.createMany({ data: rows });
        }
        stableDeltaTables.add("standingsRow");
      }
      if (rewriteTables.has("fixture")) {
        await syncStableEntities(tx, "fixture", saveId, previous.fixtures, world.fixtures, (entity) => fixtureRow(entity, saveId));
        stableDeltaTables.add("fixture");
      }
      if (rewriteTables.has("match")) {
        await syncStableEntities(tx, "match", saveId, previous.matches, world.matches, (entity) => matchRow(entity, saveId));
        stableDeltaTables.add("match");
      }
      if (rewriteTables.has("matchStat")) {
        await syncStableEntities(tx, "matchStat", saveId, previous.matches, world.matches, (entity) => statRow(entity, saveId), "matchId", (idSaveId, id) => ({ saveId_matchId: { saveId: idSaveId, matchId: id } }));
        stableDeltaTables.add("matchStat");
      }
      if (rewriteTables.has("matchEvent")) {
        await syncMatchEvents(tx, saveId, previous.matches, world.matches);
        stableDeltaTables.add("matchEvent");
      }
      if (rewriteTables.has("clubEloEvent")) {
        await syncStableEntities(tx, "clubEloEvent", saveId, previous.clubEloEvents ?? [], world.clubEloEvents ?? [], (entity) => clubEloEventRow(entity, saveId), "id", (_saveId, id) => ({ id }));
        stableDeltaTables.add("clubEloEvent");
      }
      if (rewriteTables.has("transferAuction")) {
        await syncStableEntities(tx, "transferAuction", saveId, previous.transferAuctions, world.transferAuctions, (entity) => transferAuctionRow(entity, saveId));
        stableDeltaTables.add("transferAuction");
      }
      if (rewriteTables.has("marketBid")) {
        await syncStableEntities(tx, "marketBid", saveId, previous.marketBids, world.marketBids, (entity) => marketBidRow(entity, saveId), "id", (_saveId, id) => ({ id }));
        stableDeltaTables.add("marketBid");
      }
      if (rewriteTables.has("freeAgentListing")) {
        await syncStableEntities(tx, "freeAgentListing", saveId, previous.freeAgentListings, world.freeAgentListings, (entity) => freeAgentListingRow(entity, saveId));
        stableDeltaTables.add("freeAgentListing");
      }
      if (rewriteTables.has("marketReservation")) {
        await syncStableEntities(tx, "marketReservation", saveId, previous.marketReservations, world.marketReservations, (entity) => marketReservationRow(entity, saveId), "id", (_saveId, id) => ({ id }));
        stableDeltaTables.add("marketReservation");
      }
      if (rewriteTables.has("playerMarketTransaction")) {
        await syncStableEntities(tx, "playerMarketTransaction", saveId, previous.playerMarketHistory, world.playerMarketHistory, (entity) => playerMarketTransactionRow(entity, saveId), "id", (_saveId, id) => ({ id }));
        stableDeltaTables.add("playerMarketTransaction");
      }
      if (rewriteTables.has("newsItem")) {
        await syncAutoEntities(tx, "newsItem", saveId, previous.news, world.news, (entity) => newsRow(entity, saveId));
        stableDeltaTables.add("newsItem");
      }
      if (rewriteTables.has("seasonAward")) {
        await syncAutoEntities(tx, "seasonAward", saveId, previous.seasonAwards, world.seasonAwards, (entity) => seasonAwardRow(entity, saveId));
        stableDeltaTables.add("seasonAward");
      }
      if (rewriteTables.has("careerRecord")) {
        await syncAutoEntities(tx, "careerRecord", saveId, previous.records, world.records, (entity) => careerRecordRow(entity, saveId));
        stableDeltaTables.add("careerRecord");
      }
      if (rewriteTables.has("ledgerEntry")) {
        const ids = changedClubIds(previous.clubs, world.clubs, "ledger");
        if (ids.size > 0) {
          await tx.ledgerEntry.deleteMany({ where: { saveId, clubId: { in: [...ids] } } });
          const rows = world.clubs.filter((club) => ids.has(club.id)).flatMap((club) => ledgerRowsForClub(club, saveId));
          if (rows.length > 0) await tx.ledgerEntry.createMany({ data: rows });
        }
        stableDeltaTables.add("ledgerEntry");
      }
      if (rewriteTables.has("trophy")) {
        const ids = changedClubIds(previous.clubs, world.clubs, "trophies");
        if (ids.size > 0) {
          await tx.trophy.deleteMany({ where: { saveId, clubId: { in: [...ids] } } });
          const rows = world.clubs.filter((club) => ids.has(club.id)).flatMap((club) => trophyRowsForClub(club, saveId));
          if (rows.length > 0) await tx.trophy.createMany({ data: rows });
        }
        stableDeltaTables.add("trophy");
      }
      if (rewriteTables.has("club")) {
        const currentIds = world.clubs.map((club) => club.id);
        if (currentIds.length > 0) await tx.club.deleteMany({ where: { saveId, id: { notIn: currentIds } } });
        else await tx.club.deleteMany({ where: { saveId } });
        const creates: ReturnType<typeof clubRow>[] = [];
        for (const club of world.clubs) {
          const old = previousClubById.get(club.id);
          if (!old) creates.push(clubRow(club, saveId));
          else if (JSON.stringify(old) !== JSON.stringify(club)) {
            await tx.club.update({ where: { saveId_id: { saveId, id: club.id } }, data: clubRow(club, saveId) });
          }
        }
        if (creates.length > 0) await tx.club.createMany({ data: creates });
      }
      if (rewriteTables.has("player")) {
        const currentIds = world.players.map((player) => player.id);
        if (currentIds.length > 0) await tx.player.deleteMany({ where: { saveId, id: { notIn: currentIds } } });
        else await tx.player.deleteMany({ where: { saveId } });
        const creates: ReturnType<typeof playerRow>[] = [];
        for (const player of world.players) {
          const old = previousPlayerById.get(player.id);
          if (!old) creates.push(playerRow(player, saveId));
          else if (JSON.stringify(old) !== JSON.stringify(player)) {
            await tx.player.update({ where: { saveId_id: { saveId, id: player.id } }, data: playerRow(player, saveId) });
          }
        }
        if (creates.length > 0) await tx.player.createMany({ data: creates });
      }
    }
    for (const t of rewriteTables) {
      if (previous && (t === "club" || t === "player" || stableDeltaTables.has(t))) continue;
      await (tx as unknown as Record<string, { deleteMany: (args: { where: { saveId: number } }) => Promise<unknown> }>)[t].deleteMany({ where: { saveId } });
    }
    if (rewriteTables.has("club") && !previous && world.clubs.length > 0) {
      await tx.club.createMany({ data: world.clubs.map((c) => clubRow(c, saveId)) });
    }
    if (rewriteTables.has("player") && !previous && world.players.length > 0) {
      await tx.player.createMany({ data: world.players.map((p) => playerRow(p, saveId)) });
    }
      if (rewriteTables.has("loan") && world.loans.length > 0 && (!previous || !stableDeltaTables.has("loan"))) {
       await tx.loan.createMany({ data: world.loans.map((l) => ({ id: l.id, saveId, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled, feeAmount: Math.max(0, Math.round(l.feeAmount ?? 0)), listedAt: BigInt(l.listedAt), claimableAt: BigInt(l.claimableAt) })) });
      }
    if (rewriteTables.has("competition") && world.competitions.length > 0) {
      if (!previous || !stableDeltaTables.has("competition")) await tx.competition.createMany({ data: world.competitions.map((c) => competitionRow(c, saveId)) });
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
       if (rewriteTables.has("standingsRow") && (!previous || !stableDeltaTables.has("standingsRow"))) await tx.standingsRow.createMany({ data: rows });
    }
    if (rewriteTables.has("fixture") && world.fixtures.length > 0 && (!previous || !stableDeltaTables.has("fixture"))) {
      await tx.fixture.createMany({ data: world.fixtures.map((f) => ({ id: f.id, saveId, competitionId: f.competitionId, round: f.round, homeClubId: f.homeClubId, awayClubId: f.awayClubId, dayIndex: f.dayIndex, played: f.played, leg: f.leg ?? null, tie: f.tie ?? null, kickoffAt: f.kickoffAt !== undefined ? BigInt(f.kickoffAt) : null, scheduledSeasonDayIndex: f.scheduledSeasonDayIndex ?? null })) });
    }
    if (rewriteTables.has("match") && world.matches.length > 0) {
       if (!previous || !stableDeltaTables.has("match")) await tx.match.createMany({ data: world.matches.map((m) => matchRow(m, saveId)) });
         if (rewriteTables.has("matchStat") && (!previous || !stableDeltaTables.has("matchStat"))) await tx.matchStat.createMany({ data: world.matches.map((m) => statRow(m, saveId)) });
      const evRows: { saveId: number; matchId: number; minute: number; half: number; type: number; subtype: number; clubId: number; playerId: number | null; player2Id: number | null; goalType: number; ordinal: number }[] = [];
      for (const m of world.matches) {
        m.events.forEach((e, i) => {
          evRows.push({ saveId, matchId: m.id, minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, playerId: e.playerId, player2Id: e.player2Id, goalType: e.goalType, ordinal: i });
        });
      }
         if (rewriteTables.has("matchEvent") && (!previous || !stableDeltaTables.has("matchEvent")) && evRows.length > 0) await tx.matchEvent.createMany({ data: evRows });
      }
       if (rewriteTables.has("clubEloEvent") && (world.clubEloEvents ?? []).length > 0 && (!previous || !stableDeltaTables.has("clubEloEvent"))) {
        await tx.clubEloEvent.createMany({ data: (world.clubEloEvents ?? []).map((event) => ({ id: event.id, saveId, matchId: event.matchId, clubId: event.clubId, opponentClubId: event.opponentClubId, ratingBefore: event.ratingBefore, ratingAfter: event.ratingAfter, delta: event.delta, expectedScore: event.expectedScore, actualScore: event.actualScore, createdAt: new Date(event.createdAt) })) });
      }
    if (rewriteTables.has("newsItem") && world.news.length > 0 && (!previous || !stableDeltaTables.has("newsItem"))) {
      await tx.newsItem.createMany({ data: world.news.map((n) => ({ saveId, dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? null })) });
    }
    const ledgerRows: { saveId: number; clubId: number; direction: string; code: number; amount: number; day: number; label: string }[] = [];
    for (const club of world.clubs) {
      for (const e of club.ledger.income) ledgerRows.push({ saveId, clubId: club.id, direction: "income", code: e.code, amount: e.amount, day: e.day, label: e.label });
      for (const e of club.ledger.expense) ledgerRows.push({ saveId, clubId: club.id, direction: "expense", code: e.code, amount: e.amount, day: e.day, label: e.label });
    }
      if (rewriteTables.has("ledgerEntry") && ledgerRows.length > 0 && (!previous || !stableDeltaTables.has("ledgerEntry"))) await tx.ledgerEntry.createMany({ data: ledgerRows });
     const trophyRows: { saveId: number; clubId: number; competitionName: string; count: number }[] = [];
     for (const club of world.clubs) {
       for (const [name, count] of Object.entries(club.trophies)) {
         trophyRows.push({ saveId, clubId: club.id, competitionName: name, count });
       }
     }
       if (rewriteTables.has("trophy") && trophyRows.length > 0 && (!previous || !stableDeltaTables.has("trophy"))) await tx.trophy.createMany({ data: trophyRows });
       if (rewriteTables.has("seasonAward") && world.seasonAwards.length > 0 && (!previous || !stableDeltaTables.has("seasonAward"))) {
       await tx.seasonAward.createMany({ data: world.seasonAwards.map((a) => ({ saveId, season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })) });
     }
       if (rewriteTables.has("careerRecord") && world.records.length > 0 && (!previous || !stableDeltaTables.has("careerRecord"))) {
       await tx.careerRecord.createMany({ data: world.records.map((r) => ({ saveId, category: r.category, value: r.value, holderName: r.holderName })) });
    }
      if (rewriteTables.has("liveMatch") && world.liveMatches.length > 0) {
        await tx.liveMatch.createMany({ data: world.liveMatches.map((st) => ({ saveId, matchId: st.matchId, homeClubId: st.homeClubId, awayClubId: st.awayClubId, stateJson: JSON.stringify(st) })) });
     }
      // Normalized multiplayer transfer market (plan §55). Stable listing and
      // bid ids are synchronized above; resolved/cancelled rows are removed
      // when they disappear from the in-memory source of truth.
       if (rewriteTables.has("transferAuction") && world.transferAuctions.length > 0 && (!previous || !stableDeltaTables.has("transferAuction"))) {
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
            salaryBaselineAtListing: a.salaryBaselineAtListing ?? null,
            playerOverallAtListing: a.playerOverallAtListing ?? null,
            playerAgeAtListing: a.playerAgeAtListing ?? null,
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
            deadlineVersion: a.deadlineVersion ?? 0,
          })),
        });
      }
       if (rewriteTables.has("marketBid") && world.marketBids.length > 0 && (!previous || !stableDeltaTables.has("marketBid"))) {
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
            contractSeasons: b.contractSeasons ?? null,
            contractSalary: b.contractSalary ?? null,
            contractDemandAtSubmission: b.contractDemandAtSubmission ?? null,
           createdAt: BigInt(b.createdAt),
           updatedAt: BigInt(b.updatedAt),
           initialPriorityAt: BigInt(b.initialPriorityAt),
         })),
       });
     }
       if (rewriteTables.has("freeAgentListing") && world.freeAgentListings.length > 0 && (!previous || !stableDeltaTables.has("freeAgentListing"))) {
       await tx.freeAgentListing.createMany({
         data: world.freeAgentListings.map((l) => ({
           id: l.id,
           saveId,
           playerId: l.playerId,
           playerValueAtListing: l.playerValueAtListing,
           openingPrice: l.openingPrice,
           bidIncrement: l.bidIncrement,
            salaryBaselineAtListing: l.salaryBaselineAtListing ?? null,
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
             unclaimedSince: l.unclaimedSince !== undefined ? BigInt(l.unclaimedSince) : null,
             softClosed: l.softClosed,
           })),
        });
      }
       if (rewriteTables.has("marketReservation") && world.marketReservations.length > 0 && (!previous || !stableDeltaTables.has("marketReservation"))) {
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
       if (rewriteTables.has("playerMarketTransaction") && world.playerMarketHistory.length > 0 && (!previous || !stableDeltaTables.has("playerMarketTransaction"))) {
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
        seasonDayIndex: t.seasonDayIndex ?? (t as unknown as { matchday?: number }).matchday ?? 0,
            completedRounds: t.completedRounds ?? null,
             contractSeasons: t.contractSeasons ?? null,
             contractSalary: t.contractSalary ?? null,
            timestamp: BigInt(t.timestamp),
          })),
        });
      }
      if (world.mp.seasonId !== 0 && (!previous || JSON.stringify(previous.mp) !== JSON.stringify(world.mp))) {
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
    const mpQueueChanged = !previous || JSON.stringify(previous.mpQueue) !== JSON.stringify(world.mpQueue);
    const allocationsChanged = !previous || JSON.stringify(previous.seasonAllocations) !== JSON.stringify(world.seasonAllocations);
    const membershipsChanged = !previous || JSON.stringify(previous.mpMemberships) !== JSON.stringify(world.mpMemberships);
    const clubSeasonsChanged = !previous || JSON.stringify(previous.mpClubSeasons) !== JSON.stringify(world.mpClubSeasons);
    const activitiesChanged = !previous || JSON.stringify(previous.mpActivities) !== JSON.stringify(world.mpActivities);

    // Multiplayer queue + allocations (idempotent unique constraints).
    if (mpQueueChanged) await tx.mpQueue.deleteMany({});
    if (allocationsChanged) await tx.mpAllocation.deleteMany({});
    if (mpQueueChanged && world.mpQueue.length > 0) {
      await tx.mpQueue.createMany({
        data: world.mpQueue.map((q) => ({ clubId: q.clubId, source: q.source, queuedAt: new Date(q.queuedAt), preferredSeasonId: q.preferredSeasonId })),
      });
    }
    if (allocationsChanged && world.seasonAllocations.length > 0) {
      await tx.mpAllocation.createMany({
        data: world.seasonAllocations.map((a) => ({ clubId: a.clubId, seasonId: a.seasonId, type: a.type, amount: a.amount, issuedAt: new Date(a.issuedAt) })),
      });
    }
    // Normalized multiplayer records (plan §55). Memberships/season records are
    // disposable between seasons and fully rewritten each persist.
    if (membershipsChanged) await tx.mpMembership.deleteMany({});
    if (membershipsChanged && world.mpMemberships.length > 0) {
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
    if (clubSeasonsChanged) await tx.mpClubSeason.deleteMany({});
    if (clubSeasonsChanged && world.mpClubSeasons.length > 0) {
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
    if (activitiesChanged) await tx.mpActivity.deleteMany({});
    if (activitiesChanged && world.mpActivities.length > 0) {
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
  if (process.env.NODE_ENV !== "test" && expectedRevision !== undefined) {
    rememberWorld(prisma, saveId, expectedRevision + 1, world);
    mutationBaselines.get(prisma)?.delete(saveId);
  } else {
    invalidateWorldCache(prisma, saveId);
    mutationBaselines.get(prisma)?.delete(saveId);
  }
}

/** Persist transient live-match progress without rewriting the whole world. */
export async function persistLiveMatchState(
  prisma: PrismaClient,
  saveId: number,
  userId: number,
  state: LiveMatchState,
  rngState: number,
  expectedRevision?: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.save.findUnique({ where: { id: saveId }, select: { userId: true, isGlobal: true } });
    if (!target || (!target.isGlobal && target.userId !== userId)) throw new Error("Save not found");

    if (expectedRevision !== undefined) {
      const result = await tx.save.updateMany({
        where: { id: saveId, revision: expectedRevision },
        data: { rngState: BigInt(rngState), revision: { increment: 1 } },
      });
      if (result.count !== 1) {
        const fresh = await tx.save.findUnique({ where: { id: saveId }, select: { revision: true } });
        throw new StaleWorldError(saveId, expectedRevision, fresh?.revision ?? -1);
      }
    } else {
      await tx.save.update({ where: { id: saveId }, data: { rngState: BigInt(rngState), revision: { increment: 1 } } });
    }

    await tx.liveMatch.upsert({
      where: { saveId_matchId: { saveId, matchId: state.matchId } },
      update: { homeClubId: state.homeClubId, awayClubId: state.awayClubId, stateJson: JSON.stringify(state) },
      create: { saveId, matchId: state.matchId, homeClubId: state.homeClubId, awayClubId: state.awayClubId, stateJson: JSON.stringify(state) },
    });
  });
  if (process.env.NODE_ENV !== "test" && expectedRevision !== undefined) {
    const cached = worldCaches.get(prisma)?.get(saveId) ?? mutationBaselines.get(prisma)?.get(saveId);
    if (cached?.revision === expectedRevision) {
      const next = cloneWorld(cached.world);
      next.rng.state = rngState;
      const index = next.liveMatches.findIndex((match) => match.matchId === state.matchId);
      if (index >= 0) next.liveMatches[index] = structuredClone(state);
      else next.liveMatches.push(structuredClone(state));
      rememberWorld(prisma, saveId, expectedRevision + 1, next);
      mutationBaselines.get(prisma)?.delete(saveId);
    }
  } else {
    invalidateWorldCache(prisma, saveId);
  }
}

function clubRow(c: Club, saveId: number) {
   return {
     id: c.id,
     saveId,
     ownerUserId: c.ownerUserId,
     // Legacy migration marker (plan 9): rebuildWorld converts local slots to
     // UTC exactly once for rows still carrying a timezone. Writing null here
     // (both the create and the per-club UPDATE delta path flow through this
     // row factory) makes that conversion idempotent across reload/persist
     // cycles. The column itself stays until a later cleanup migration.
     timezone: null,
     friendGroupingOptIn: c.friendGroupingOptIn !== false,
     preferredHoursJson: c.preferredHours ? JSON.stringify(c.preferredHours) : null,
     competitionState: c.competitionState,
     lastMeaningfulActivityAt: c.lastMeaningfulActivityAt !== null ? BigInt(c.lastMeaningfulActivityAt) : null,
     abandonmentEligibleAt: c.abandonmentEligibleAt !== null ? BigInt(c.abandonmentEligibleAt) : null,
     liveMatchAt: c.liveMatchAt !== null ? BigInt(c.liveMatchAt) : null,
     name: c.name,
     shortName: c.shortName,
     country: c.country,
     highestDivision: c.highestDivision,
     cash: c.cash,
     stadiumName: c.stadiumName,
       primaryColor: c.primaryColor,
       secondaryColor: c.secondaryColor,
       kitJson: serializeClubKits(c.kits),
       logoVariant: c.logoVariant ?? 0,
       customLogoMime: c.customLogo?.mime ?? null,
       customLogoData: c.customLogo?.data ?? null,
       customLogoStatus: c.customLogo?.status ?? "ACTIVE",
        automationPresetsJson: c.automationPresets ? JSON.stringify(c.automationPresets) : null,
        coachName: c.coachName,
        coachNameChangedSeasonKey: c.coachNameChangedSeasonKey ?? null,
      isHuman: c.isHuman,
      captainId: c.captainId,
      penaltyTakerId: c.penaltyTakerId,
      tacticsFormation: c.tactics.formation,
      tacticsStyle: c.tactics.style,
      tacticsPressing: c.tactics.pressing,
      tacticsDirection: c.tactics.direction,
      trainingFocus: c.trainingFocus,
       savedLineupJson: c.savedLineup ? JSON.stringify(c.savedLineup) : null,
       eloRating: c.eloRating,
       eloRatedMatches: c.eloRatedMatches,
   };
 }

function playerRow(p: Player, saveId: number) {
  return {
    id: p.id,
    saveId,
    clubId: p.clubId,
    name: p.name,
    nickname: p.nickname ?? null,
    country: p.country,
    age: p.age,
    position: p.position,
    side: p.side,
    overall: p.overall,
    potential: p.potential,
    energy: p.energy,
    recentLoad: p.recentLoad ?? 0,
    salary: p.salary,
    payrollPaidThroughDay: p.payrollPaidThroughDay,
    payrollPaidAmount: p.payrollPaidAmount,
    payrollPeriodStartDay: p.payrollPeriodStartDay,
    value: p.value,
    releaseClause: p.releaseClause,
    injuryDays: p.injuryDays,
    injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
    injuryInitialGameDays: p.injuryInitialGameDays ?? null,
    injuryEquivalentRealDays: p.injuryEquivalentRealDays ?? null,
    injuryCause: p.injuryCause ?? null,
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
     squadNumber: p.squadNumber ?? null,
     onSale: p.onSale,
     suspendedGames: p.suspendedGames,
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

function loanRow(l: Loan, saveId: number) {
  return { id: l.id, saveId, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled, feeAmount: Math.max(0, Math.round(l.feeAmount ?? 0)), listedAt: BigInt(l.listedAt), claimableAt: BigInt(l.claimableAt) };
}

function fixtureRow(f: Fixture, saveId: number) {
  return { id: f.id, saveId, competitionId: f.competitionId, round: f.round, homeClubId: f.homeClubId, awayClubId: f.awayClubId, dayIndex: f.dayIndex, played: f.played, leg: f.leg ?? null, tie: f.tie ?? null, kickoffAt: f.kickoffAt !== undefined ? BigInt(f.kickoffAt) : null, scheduledSeasonDayIndex: f.scheduledSeasonDayIndex ?? null };
}

function matchRow(m: Match, saveId: number) {
  return { id: m.id, saveId, fixtureId: m.fixtureId, competitionId: m.competitionId, homeClubId: m.homeClubId, awayClubId: m.awayClubId, homeScore: m.homeScore, awayScore: m.awayScore, penaltyWinnerId: m.penaltyWinnerId, penaltyScoreJson: m.penaltyScore ? JSON.stringify(m.penaltyScore) : null, extraTime: m.extraTime ?? false, scheduledAt: m.scheduledAt !== undefined ? BigInt(m.scheduledAt) : null, homeWasHuman: m.homeWasHuman ?? false, awayWasHuman: m.awayWasHuman ?? false, eloProcessed: m.eloProcessed ?? false };
}

function clubEloEventRow(event: ClubEloEvent, saveId: number) {
  return { id: event.id, saveId, matchId: event.matchId, clubId: event.clubId, opponentClubId: event.opponentClubId, ratingBefore: event.ratingBefore, ratingAfter: event.ratingAfter, delta: event.delta, expectedScore: event.expectedScore, actualScore: event.actualScore, createdAt: new Date(event.createdAt) };
}

function transferAuctionRow(a: TransferAuction, saveId: number) {
  return { id: a.id, saveId, playerId: a.playerId, sellerClubId: a.sellerClubId, playerValueAtListing: a.playerValueAtListing, openingPrice: a.openingPrice, bidIncrement: a.bidIncrement, sellerDivisionAtListing: a.sellerDivisionAtListing, totalDivisionsAtListing: a.totalDivisionsAtListing, salaryBaselineAtListing: a.salaryBaselineAtListing ?? null, playerOverallAtListing: a.playerOverallAtListing ?? null, playerAgeAtListing: a.playerAgeAtListing ?? null, currentPrice: a.currentPrice, leadingClubId: a.leadingClubId, createdAt: BigInt(a.createdAt), deadline: BigInt(a.deadline), originalDeadline: BigInt(a.originalDeadline), status: a.status, completedAt: a.completedAt !== null ? BigInt(a.completedAt) : null, winningClubId: a.winningClubId, finalPrice: a.finalPrice, cancelledAt: a.cancelledAt !== null ? BigInt(a.cancelledAt) : null, softClosed: a.softClosed, deadlineVersion: a.deadlineVersion ?? 0 };
}

function marketBidRow(b: MarketBid, saveId: number) {
  return { id: b.id, saveId, marketType: b.marketType, listingId: b.listingId, clubId: b.clubId, maxBid: b.maxBid, capMultiplierAtSubmission: b.capMultiplierAtSubmission ?? null, maximumAllowedByRuleAtSubmission: b.maximumAllowedByRuleAtSubmission ?? null, buyerDivisionAtSubmission: b.buyerDivisionAtSubmission ?? null, contractSeasons: b.contractSeasons ?? null, contractSalary: b.contractSalary ?? null, contractDemandAtSubmission: b.contractDemandAtSubmission ?? null, createdAt: BigInt(b.createdAt), updatedAt: BigInt(b.updatedAt), initialPriorityAt: BigInt(b.initialPriorityAt) };
}

function freeAgentListingRow(l: FreeAgentListing, saveId: number) {
  return { id: l.id, saveId, playerId: l.playerId, playerValueAtListing: l.playerValueAtListing, openingPrice: l.openingPrice, bidIncrement: l.bidIncrement, salaryBaselineAtListing: l.salaryBaselineAtListing ?? null, currentPrice: l.currentPrice, leadingClubId: l.leadingClubId, relistStage: l.relistStage, createdAt: BigInt(l.createdAt), deadline: BigInt(l.deadline), status: l.status, completedAt: l.completedAt !== null ? BigInt(l.completedAt) : null, winningClubId: l.winningClubId, finalPrice: l.finalPrice, previousListingId: l.previousListingId, blockedClubId: l.blockedClubId, unclaimedSince: l.unclaimedSince !== undefined ? BigInt(l.unclaimedSince) : null, softClosed: l.softClosed };
}

function marketReservationRow(r: MarketReservation, saveId: number) {
  return { id: r.id, saveId, clubId: r.clubId, listingId: r.listingId, marketType: r.marketType, amount: r.amount, createdAt: BigInt(r.createdAt), releasedAt: r.releasedAt !== null ? BigInt(r.releasedAt) : null };
}

function playerMarketTransactionRow(t: PlayerMarketTransaction, saveId: number) {
  return { id: t.id, saveId, playerId: t.playerId, listingId: t.listingId, type: t.type, fromClubId: t.fromClubId, toClubId: t.toClubId, price: t.price, seasonId: t.seasonId, seasonKey: t.seasonKey, seasonDayIndex: t.seasonDayIndex ?? (t as unknown as { matchday?: number }).matchday ?? 0, completedRounds: t.completedRounds ?? null, contractSeasons: t.contractSeasons ?? null, contractSalary: t.contractSalary ?? null, timestamp: BigInt(t.timestamp) };
}

type StableEntity = { id: number };
type StableModel = {
  deleteMany: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
  createMany: (args: unknown) => Promise<unknown>;
};

function newsRow(item: NewsItem, saveId: number) {
  return { ...(item.id !== undefined ? { id: item.id } : {}), saveId, dayIndex: item.dayIndex, text: item.text, kind: item.kind, clubId: item.clubId ?? null };
}

function seasonAwardRow(item: SeasonAward, saveId: number) {
  return { ...(item.id !== undefined ? { id: item.id } : {}), saveId, season: item.season, category: item.category, competitionId: item.competitionId, playerId: item.playerId, clubId: item.clubId, playerNameSnapshot: item.playerNameSnapshot, detail: item.detail };
}

function careerRecordRow(item: CareerRecord, saveId: number) {
  return { ...(item.id !== undefined ? { id: item.id } : {}), saveId, category: item.category, value: item.value, holderName: item.holderName };
}

function ledgerRowsForClub(club: Club, saveId: number) {
  return [
    ...club.ledger.income.map((entry) => ({ saveId, clubId: club.id, direction: "income", code: entry.code, amount: entry.amount, day: entry.day, label: entry.label })),
    ...club.ledger.expense.map((entry) => ({ saveId, clubId: club.id, direction: "expense", code: entry.code, amount: entry.amount, day: entry.day, label: entry.label })),
  ];
}

function trophyRowsForClub(club: Club, saveId: number) {
  return Object.entries(club.trophies).map(([competitionName, count]) => ({ saveId, clubId: club.id, competitionName, count }));
}

function changedClubIds(previous: Club[], current: Club[], field: "ledger" | "trophies") {
  const previousById = new Map(previous.map((club) => [club.id, club]));
  const currentById = new Map(current.map((club) => [club.id, club]));
  const ids = new Set<number>();
  for (const club of previous) {
    const next = currentById.get(club.id);
    if (!next || JSON.stringify(club[field]) !== JSON.stringify(next[field])) ids.add(club.id);
  }
  for (const club of current) {
    const old = previousById.get(club.id);
    if (!old || JSON.stringify(old[field]) !== JSON.stringify(club[field])) ids.add(club.id);
  }
  return ids;
}

function standingsRowsForCompetition(competition: Competition, saveId: number) {
  const rows: { saveId: number; competitionId: number; clubId: number; played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; points: number; groupName: string | null }[] = [];
  for (const row of Object.values(competition.standings)) rows.push({ saveId, competitionId: competition.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: null });
  for (const group of competition.groupStandings) for (const row of Object.values(group.rows)) rows.push({ saveId, competitionId: competition.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: group.groupName });
  return rows;
}

type AutoEntity = { id?: number };

async function syncAutoEntities<T extends AutoEntity>(
  tx: Tx,
  table: string,
  saveId: number,
  previous: T[] | undefined,
  current: T[],
  rowFor: (entity: T) => Record<string, unknown>,
): Promise<void> {
  if (!previous) return;
  const model = (tx as unknown as Record<string, StableModel>)[table];
  const currentIds = current.flatMap((entity) => entity.id === undefined ? [] : [entity.id]);
  await model.deleteMany({ where: currentIds.length > 0 ? { saveId, id: { notIn: currentIds } } : { saveId } });
  const previousById = new Map(previous.flatMap((entity) => entity.id === undefined ? [] : [[entity.id, entity] as const]));
  const unmatchedPrevious = new Set(previousById.keys());
  const creates: Record<string, unknown>[] = [];
  for (const entity of current) {
    let old = entity.id === undefined ? undefined : previousById.get(entity.id);
    if (!old && entity.id === undefined) {
      old = previous.find((candidate) => unmatchedPrevious.has(candidate.id!) && JSON.stringify(candidate) === JSON.stringify(entity));
      if (old?.id !== undefined) entity.id = old.id;
    }
    if (!old) creates.push(rowFor(entity));
    else {
      unmatchedPrevious.delete(old.id!);
      if (JSON.stringify(old) !== JSON.stringify(entity)) await model.update({ where: { id: old.id }, data: rowFor(entity) });
    }
  }
  if (creates.length > 0) await model.createMany({ data: creates });
}

async function syncStableEntities<T extends StableEntity>(
  tx: Tx,
  table: string,
  saveId: number,
  previous: T[] | undefined,
  current: T[],
  rowFor: (entity: T) => Record<string, unknown>,
  keyField = "id",
  updateWhere: (idSaveId: number, id: number) => Record<string, unknown> = (idSaveId, id) => ({ saveId_id: { saveId: idSaveId, id } }),
): Promise<void> {
  if (!previous) return;
  const model = (tx as unknown as Record<string, StableModel>)[table];
  const currentIds = current.map((entity) => entity.id);
  await model.deleteMany({ where: currentIds.length > 0 ? { saveId, [keyField]: { notIn: currentIds } } : { saveId } });
  const previousById = new Map(previous.map((entity) => [entity.id, entity]));
  const creates: Record<string, unknown>[] = [];
  for (const entity of current) {
    const old = previousById.get(entity.id);
    if (!old) creates.push(rowFor(entity));
    else if (JSON.stringify(old) !== JSON.stringify(entity)) await model.update({ where: updateWhere(saveId, entity.id), data: rowFor(entity) });
  }
  if (creates.length > 0) await model.createMany({ data: creates });
}

async function syncMatchEvents(tx: Tx, saveId: number, previous: Match[] | undefined, current: Match[]): Promise<void> {
  if (!previous) return;
  const previousById = new Map(previous.map((match) => [match.id, match]));
  const currentById = new Map(current.map((match) => [match.id, match]));
  const affectedIds = new Set<number>();
  for (const old of previous) {
    const next = currentById.get(old.id);
    if (!next || JSON.stringify(old.events) !== JSON.stringify(next.events)) affectedIds.add(old.id);
  }
  for (const next of current) {
    if (!previousById.has(next.id)) affectedIds.add(next.id);
  }
  if (affectedIds.size === 0) return;
  const ids = [...affectedIds];
  await tx.matchEvent.deleteMany({ where: { saveId, matchId: { in: ids } } });
  const rows: { saveId: number; matchId: number; minute: number; half: number; type: number; subtype: number; clubId: number; playerId: number | null; player2Id: number | null; goalType: number; ordinal: number }[] = [];
  for (const match of current) {
    if (!affectedIds.has(match.id)) continue;
    match.events.forEach((event, ordinal) => rows.push({ saveId, matchId: match.id, minute: event.minute, half: event.half, type: event.type, subtype: event.subtype, clubId: event.clubId, playerId: event.playerId, player2Id: event.player2Id, goalType: event.goalType, ordinal }));
  }
  if (rows.length > 0) await tx.matchEvent.createMany({ data: rows });
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

/**
 * Current UTC offset of an IANA zone in minutes. Only used by the one-time
 * legacy preferredHours local→UTC migration in rebuildWorld; the server itself
 * never interprets a timezone.
 */
function legacyIanaOffsetMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date());
    const value = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? "0");
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return 0;
  }
}

/**
 * Zone offset quantized to whole half-hour slots. Shared by both conversion
 * directions so they are exact inverses on the slot ring (:45-offset zones
 * land consistently instead of drifting one slot per round trip).
 */
function offsetToSlots(offsetMinutes: number): number {
  return Math.round(offsetMinutes / MP_CONFIG.preferredSlotMinutes);
}

/** Shift local half-hour slots onto the UTC grid (rounded to nearest slot). */
function legacyLocalSlotsToUtc(slots: number[], offsetMinutes: number): number[] {
  const shift = offsetToSlots(offsetMinutes);
  const perDay = MP_CONFIG.slotsPerDay;
  return [...new Set(slots.map((slot) => (((slot - shift) % perDay) + perDay) % perDay))].sort((a, b) => a - b);
}

/**
 * Preferred hours of a club row, applying the one-time legacy local→UTC
 * conversion while the row still carries its timezone marker (plan 9). Shared
 * by rebuildWorld AND read paths so an un-migrated row can never serve local
 * wall-clock slots mislabeled as UTC.
 */
export function preferredHoursFromClubRow(timeZone: string | null | undefined, preferredHoursJson: string | null | undefined): number[] | null {
  const stored = jsonOr<number[] | null>(preferredHoursJson, null);
  if (!stored || stored.length === 0) return null;
  return timeZone ? legacyLocalSlotsToUtc(stored, legacyIanaOffsetMinutes(timeZone)) : stored;
}

async function rebuildWorld(
  prisma: PrismaClient,
  saveRow: { id: number; seed: number; year: number; dayIndex: number; humanClubId: number | null; rngState: bigint; mpStateJson?: string | null; seasonSummaryJson: string | null; seasonHistoryJson?: string | null; pendingEventsJson: string | null; pendingMatchIdsJson: string | null; generationEventsJson?: string | null; financialInterventionsJson?: string | null }
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
     trophyRows,
     awardRows,
     recordRows,
     liveRow,
     mpQueueRows,
     mpAllocationRows,
     mpMembershipRows,
      mpClubSeasonRows,
      mpActivityRows,
      clubEloEventRows,
      friendshipRows,
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
      prisma.trophy.findMany({ where: { saveId: saveRow.id } }),
      prisma.seasonAward.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.careerRecord.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
     prisma.liveMatch.findMany({ where: { saveId: saveRow.id } }),
     prisma.mpQueue.findMany({ orderBy: { queuedAt: "asc" } }),
     prisma.mpAllocation.findMany(),
     prisma.mpMembership.findMany(),
     prisma.mpClubSeason.findMany(),
       prisma.mpActivity.findMany({ orderBy: { id: "asc" } }),
       prisma.clubEloEvent.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
       prisma.friendship.findMany({ orderBy: { id: "asc" } }),
   ]);

    const clubs: Club[] = clubRows.map((r) => {
     const r2 = r as unknown as {
       ownerUserId: number | null;
       timezone: string | null;
       preferredHoursJson: string | null;
       friendGroupingOptIn: boolean;
       competitionState: string;
       lastMeaningfulActivityAt: bigint | null;
       abandonmentEligibleAt: bigint | null;
       liveMatchAt: bigint | null;
        highestDivision: number | null;
        eloRating: number | null;
        eloRatedMatches: number | null;
       logoVariant: number | null;
       customLogoMime: string | null;
       customLogoData: string | null;
       customLogoStatus: string | null;
       automationPresetsJson: string | null;
     };
     const customLogo =
       r2.customLogoData && r2.customLogoMime
         ? { mime: r2.customLogoMime, data: r2.customLogoData, status: r2.customLogoStatus ?? "ACTIVE" }
         : null;
      // One-time legacy migration (plan 9): preferredHours were stored as LOCAL
      // wall-clock slots while the row still carried the owner's IANA timezone.
      // Shift them onto the UTC grid once; clubRow writes timezone back as null
      // so this branch can never run twice for the same row.
      const preferredHours = preferredHoursFromClubRow(r2.timezone, r2.preferredHoursJson);
     return {
       id: r.id,
       name: r.name,
       shortName: r.shortName,
       ownerUserId: r2.ownerUserId ?? null,
       preferredHours,
       friendGroupingOptIn: r2.friendGroupingOptIn !== false,
       competitionState: (r2.competitionState ?? "ACTIVE") as Club["competitionState"],
       lastMeaningfulActivityAt: r2.lastMeaningfulActivityAt !== null && r2.lastMeaningfulActivityAt !== undefined ? Number(r2.lastMeaningfulActivityAt) : null,
       abandonmentEligibleAt: r2.abandonmentEligibleAt !== null && r2.abandonmentEligibleAt !== undefined ? Number(r2.abandonmentEligibleAt) : null,
       liveMatchAt: r2.liveMatchAt !== null && r2.liveMatchAt !== undefined ? Number(r2.liveMatchAt) : null,
       country: r.country,
        highestDivision: r2.highestDivision ?? 1,
        eloRating: r2.eloRating ?? ELO_CONFIG.initial,
        eloRatedMatches: r2.eloRatedMatches ?? 0,
       cash: r.cash,
       stadiumName: r.stadiumName,
       primaryColor: r.primaryColor,
       secondaryColor: r.secondaryColor,
       kits: deserializeClubKits((r as unknown as { kitJson?: string | null }).kitJson),
       logoVariant: r2.logoVariant ?? 0,
       customLogo,
        automationPresets: parseStoredPresets(jsonOr<unknown>(r2.automationPresetsJson, null), r.tacticsFormation),
        coachName: r.coachName,
        coachNameChangedSeasonKey: (r2 as unknown as { coachNameChangedSeasonKey?: string | null }).coachNameChangedSeasonKey ?? null,
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
    const clubById = new Map(clubs.map((club) => [club.id, club]));

    const migrationAbsoluteGameDay = jsonOr<Partial<World["mp"]>>(saveRow.mpStateJson ?? null, {}).absoluteGameDay ?? saveRow.dayIndex;
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
      const persistedUntil = (r as typeof r & { injuryUntilAbsoluteGameDay?: number | null }).injuryUntilAbsoluteGameDay;
      const legacyInjuryDays = r.injuryDays ?? 0;
      const injuryUntil = persistedUntil ?? (legacyInjuryDays > 0 ? migrationAbsoluteGameDay + Math.max(1, legacyInjuryDays) : null);
      return {
        id: r.id,
        name: r.name,
        nickname: (r as unknown as { nickname?: string | null }).nickname ?? null,
        country: r.country,
        age: r.age,
        position: r.position as Player["position"],
        side: r.side,
        skills: { gol: r.skillGol, vel: r.skillVel, tec: r.skillTec, pas: r.skillPas, des: r.skillDes, arm: r.skillArm, fin: r.skillFin },
        overall: r.overall,
        potential: r.potential,
        energy: r.energy,
        salary: r.salary,
        payrollPaidThroughDay: (r as typeof r & { payrollPaidThroughDay?: number }).payrollPaidThroughDay ?? 0,
        payrollPaidAmount: (r as typeof r & { payrollPaidAmount?: number }).payrollPaidAmount ?? 0,
        payrollPeriodStartDay: (r as typeof r & { payrollPeriodStartDay?: number }).payrollPeriodStartDay ?? 0,
        value: r.value,
        releaseClause: r.releaseClause,
        injuryDays: r.injuryDays,
        recentLoad: (r as typeof r & { recentLoad?: number }).recentLoad ?? 0,
        injuryUntilAbsoluteGameDay: injuryUntil,
        injuryInitialGameDays: (r as typeof r & { injuryInitialGameDays?: number | null }).injuryInitialGameDays ?? (legacyInjuryDays > 0 ? Math.max(1, legacyInjuryDays) : null),
        injuryEquivalentRealDays: (r as typeof r & { injuryEquivalentRealDays?: number | null }).injuryEquivalentRealDays ?? null,
        injuryCause: ((r as typeof r & { injuryCause?: string | null }).injuryCause as Player["injuryCause"]) ?? null,
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
        squadNumber: (r as unknown as { squadNumber?: number | null }).squadNumber ?? null,
        onSale: r.onSale,
        suspendedGames: r.suspendedGames,
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
     normalizePlayer(player, player.clubId === null ? undefined : clubById.get(player.clubId));
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
    const competitionById = new Map(competitions.map((competition) => [competition.id, competition]));

   for (const r of standingsRows) {
     const comp = competitionById.get(r.competitionId);
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
     const f2 = f as unknown as { kickoffAt: bigint | null; scheduledSeasonDayIndex: number | null };
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
      scheduledSeasonDayIndex: f2.scheduledSeasonDayIndex ?? undefined,
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
      events: eventsByMatch.get(r.id) ?? [],
      stats: s
        ? jsonOr<MatchStats>(
            (s as unknown as { statsJson?: string | null }).statsJson,
            legacyStatRowToMatchStats(s)
          )
        : emptyMatchStats(),
       extraTime: r.extraTime,
       homeWasHuman: (r as typeof r & { homeWasHuman?: boolean }).homeWasHuman ?? false,
       awayWasHuman: (r as typeof r & { awayWasHuman?: boolean }).awayWasHuman ?? false,
       eloProcessed: (r as typeof r & { eloProcessed?: boolean }).eloProcessed ?? false,
       minuteEvents: [],
      scheduledAt: (r as unknown as { scheduledAt: bigint | null }).scheduledAt !== null && (r as unknown as { scheduledAt: bigint | null }).scheduledAt !== undefined ? Number((r as unknown as { scheduledAt: bigint | null }).scheduledAt) : undefined,
    };
  });

   for (const l of ledgerRows) {
     const club = clubById.get(l.clubId);
    if (!club) continue;
    const entry = { code: l.code, amount: l.amount, day: l.day, label: l.label };
    if (l.direction === "income") club.ledger.income.push(entry);
    else club.ledger.expense.push(entry);
  }

   for (const t of trophyRows) {
     const club = clubById.get(t.clubId);
    if (club) club.trophies[t.competitionName] = t.count;
  }

    const bidsByListing = new Map<string, typeof marketBidRows>();
    for (const bid of marketBidRows) {
      const key = `${bid.marketType}:${bid.listingId}`;
      const bids = bidsByListing.get(key) ?? [];
      bids.push(bid);
      bidsByListing.set(key, bids);
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
      salaryBaselineAtListing: a.salaryBaselineAtListing ?? undefined,
      playerOverallAtListing: a.playerOverallAtListing ?? undefined,
      playerAgeAtListing: a.playerAgeAtListing ?? undefined,
      currentPrice: a.currentPrice,
     leadingClubId: a.leadingClubId,
       bids: (bidsByListing.get(`TRANSFER:${a.id}`) ?? []).map((b) => ({
        clubId: b.clubId,
        maxBid: b.maxBid,
        contractSeasons: b.contractSeasons ?? undefined,
        contractSalary: b.contractSalary ?? undefined,
        initialPriorityAt: Number(b.initialPriorityAt),
      })),
     createdAt: Number(a.createdAt),
     deadline: Number(a.deadline),
     originalDeadline: Number(a.originalDeadline),
     status: (a.status as AuctionStatus) ?? "ACTIVE",
     completedAt: a.completedAt !== null ? Number(a.completedAt) : null,
     winningClubId: a.winningClubId,
     finalPrice: a.finalPrice,
     cancelledAt: a.cancelledAt !== null ? Number(a.cancelledAt) : null,
      softClosed: a.softClosed,
      deadlineVersion: (a as unknown as { deadlineVersion: number }).deadlineVersion ?? 0,
    }));

   const freeAgentListings = freeAgentListingRows.map((l) => ({
     id: l.id,
     playerId: l.playerId,
     playerValueAtListing: l.playerValueAtListing,
     openingPrice: l.openingPrice,
     bidIncrement: l.bidIncrement,
      // Legacy rows stored a listing-wide demanded salary before the frozen
      // per-listing baseline existed; map it once on load.
      salaryBaselineAtListing: l.salaryBaselineAtListing ?? (l as unknown as { demandedSalary?: number | null }).demandedSalary ?? undefined,
     currentPrice: l.currentPrice,
     leadingClubId: l.leadingClubId,
     relistStage: l.relistStage,
       bids: (bidsByListing.get(`FREE_AGENT:${l.id}`) ?? []).map((b) => ({
        clubId: b.clubId,
        maxBid: b.maxBid,
        contractSeasons: b.contractSeasons ?? undefined,
        contractSalary: b.contractSalary ?? undefined,
        initialPriorityAt: Number(b.initialPriorityAt),
      })),
     createdAt: Number(l.createdAt),
     deadline: Number(l.deadline),
     status: (l.status as AuctionStatus) ?? "ACTIVE",
     completedAt: l.completedAt !== null ? Number(l.completedAt) : null,
     winningClubId: l.winningClubId,
     finalPrice: l.finalPrice,
      previousListingId: l.previousListingId,
      blockedClubId: l.blockedClubId ?? null,
      unclaimedSince: l.unclaimedSince !== null ? Number(l.unclaimedSince) : Number(l.createdAt),
      softClosed: l.softClosed,
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
      contractSeasons: b.contractSeasons ?? undefined,
      contractSalary: b.contractSalary ?? undefined,
      contractDemandAtSubmission: b.contractDemandAtSubmission ?? undefined,
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
       seasonDayIndex: t.seasonDayIndex ?? (t as unknown as { matchday?: number }).matchday ?? 0,
      completedRounds: (t as unknown as { completedRounds?: number | null }).completedRounds ?? undefined,
      contractSeasons: t.contractSeasons,
      contractSalary: t.contractSalary,
     timestamp: Number(t.timestamp),
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
      clubEloEvents: [],
     news: newsRows.map((n) => ({ id: n.id, dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? undefined })),
     transferAuctions: auctions,
     marketBids: marketBidsList,
     freeAgentListings,
     marketReservations,
     playerMarketHistory,
     loans: loanRows.map((l) => ({ id: l.id, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled, feeAmount: (l as unknown as { feeAmount?: number | null }).feeAmount ?? 0, listedAt: Number(l.listedAt), claimableAt: Number(l.claimableAt) })),
      seasonAwards: awardRows.map((a) => ({ id: a.id, season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })),
      records: recordRows.map((r) => ({ id: r.id, category: r.category, value: r.value, holderName: r.holderName })),
     humanClubId: saveRow.humanClubId,
     seasonSummary: jsonOr(saveRow.seasonSummaryJson, null),
     rng: createRng(saveRow.seed),
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
       pendingSeasonRetirees: null,
       populationHistory: [],
       ...jsonOr<Partial<World["mp"]>>((saveRow as unknown as { mpStateJson?: string | null }).mpStateJson, {}),
     },
     mpQueue: [],
     liveMatches: [],
     seasonAllocations: [],
     mpMemberships: [],
     mpClubSeasons: [],
     mpActivities: [],
     mpAudits: [],
      seasonHistory: jsonOr<World["seasonHistory"]>((saveRow as { seasonHistoryJson?: string | null }).seasonHistoryJson, []),
      generationEvents: [],
      financialInterventions: [],
  };
  world.rng.state = Number(saveRow.rngState);
   world.nextId =
     Math.max(
       1,
        ...[...clubs.map((c) => c.id), ...players.map((p) => p.id), ...competitions.map((c) => c.id), ...fixtures.map((f) => f.id), ...matches.map((m) => m.id), ...(world.clubEloEvents ?? []).map((event) => event.id), ...auctions.map((a) => a.id), ...freeAgentListings.map((l) => l.id), ...world.loans.map((l) => l.id)]
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
    world.friendships = (friendshipRows ?? []).map((friendship) => ({ userAId: friendship.userAId, userBId: friendship.userBId })) as MpFriendshipEntry[];
   world.clubEloEvents = (clubEloEventRows ?? []).map((event) => ({
     id: event.id,
     matchId: event.matchId,
     clubId: event.clubId,
     opponentClubId: event.opponentClubId,
     ratingBefore: event.ratingBefore,
     ratingAfter: event.ratingAfter,
     delta: event.delta,
     expectedScore: event.expectedScore,
     actualScore: event.actualScore,
     createdAt: event.createdAt.getTime(),
   })) as ClubEloEvent[];
   world.pendingDayEvents = jsonOr<string[] | undefined>(saveRow.pendingEventsJson, undefined);
   world.pendingDayMatchIds = jsonOr<number[] | undefined>(saveRow.pendingMatchIdsJson, undefined);
   world.generationEvents = jsonOr<string[]>(saveRow.generationEventsJson, []);
   world.financialInterventions = jsonOr<World["financialInterventions"]>((saveRow as unknown as { financialInterventionsJson?: string | null }).financialInterventionsJson, []);
   const persistedIds = [
     ...marketBidRows.map((row) => row.id),
      ...marketReservationRows.map((row) => row.id),
      ...playerMarketTransactionRows.map((row) => row.id),
      ...(world.clubEloEvents ?? []).map((event) => event.id),
      ...world.financialInterventions.map((event) => event.id),
    ];
    if (persistedIds.length > 0) world.nextId = Math.max(world.nextId, Math.max(...persistedIds) + 1);
    world.mp.seasonDayIndex ??= Math.max(0, Math.min(gameConfig.seasonDays - 1, world.dayIndex));
    world.mp.phase = phaseForSeasonDayIndex(world.mp.seasonDayIndex, gameConfig);
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
  st.ballCarrierId ??= null;
  st.ballActionSequence ??= 0;
  st.lastBallAction ??= null;
  st.possessionHighRecovery ??= false;
  st.opponentControlSeconds ??= [0, 0];
  st.pressureWindowAdvancedStates ??= [0, 0];
  st.pressureWindowStartSeconds ??= [0, 0];
  st.pendingRestart ??= null;
  st.possessionFirstAction ??= null;
  st.automationFiredRuleIds ??= [];
  st.automationDisabled ??= [false, false];
  st.withBall ??= 0;
  st.coinTossWinner ??= (st.withBall as 0 | 1) ?? 0;
  st.firstHalfAddedMinutes ??= 0;
  st.secondHalfAddedMinutes ??= 0;
  st.halftimeStartedAt ??= null;
  st.halftimeReady ??= [false, false];
  // Live-match tactics cooldown: legacy live states predate the lock and start
  // with both sides unchanged (first change free).
  st.tacticsChangedAtMinute ??= [null, null];
  // Backfill coin-toss event for old saves that predate it (minute 0, half 0).
  if (!st.events.some((e) => e.type === 9)) {
    const winnerId = st.coinTossWinner === 0 ? st.homeClubId : st.awayClubId;
    st.events.unshift({ minute: 0, half: 0, type: 9, subtype: 0, clubId: winnerId, playerId: null, player2Id: null, goalType: 0 });
  }
  st.playerEnergy ??= {};
  // Live states persisted before the Energy/Injury overhaul have no calendar
  // anchor. Without stamping it, any injury occurring in a resumed match would
  // be recorded against absolute game day 0 and expire immediately.
  st.absoluteGameDay ??= world.mp.absoluteGameDay ?? world.dayIndex;
  st.roundsPerSeason ??= calendarValues().roundsPerSeason;
  st.matchSpacingDays ??= calendarValues().matchSpacingDays;
  const playerIds = new Set([...st.homeXI, ...st.awayXI, ...st.homeSubs, ...st.awaySubs, ...st.homeOn, ...st.awayOn]);
  for (const id of playerIds) {
    if (typeof st.playerEnergy[id] !== "number") {
      const player = world.players.find((candidate) => candidate.id === id);
      if (player) st.playerEnergy[id] = player.energy;
    }
  }
}
