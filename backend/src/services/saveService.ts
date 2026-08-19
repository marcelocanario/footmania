import type { Prisma, PrismaClient } from "@prisma/client";
import type {
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
import { calculateBaseSalary, calculatePlayerValue, calculateReleaseClause, remainingSeasons } from "../game/economy";

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
  "trophy",
  "loan",
  "managerHistory",
  "seasonAward",
  "careerRecord",
  "clubTicketPrices",
  "stadiumUpgrade",
  "liveMatch",
  "marketBid",
  "transferAuction",
  "freeAgentListing",
  "marketReservation",
  "playerMarketTransaction",
  "aiEvaluation",
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

/** The single global multiplayer Save row (isGlobal = true). */
export async function ensureGlobalSave(prisma: PrismaClient): Promise<{ id: number; name: string }> {
  const existing = await prisma.save.findFirst({ where: { isGlobal: true } });
  if (existing) {
    if (existing.globalKey !== "GLOBAL") {
      await prisma.save.update({ where: { id: existing.id }, data: { globalKey: "GLOBAL" } });
    }
    return { id: existing.id, name: existing.name };
  }
  // The global save needs an owning user for the FK; use (or create) a
  // dedicated "system" user.
  let system = await prisma.user.findUnique({ where: { username: "__system__" } });
  if (!system) {
    try {
      system = await prisma.user.create({ data: { username: "__system__", passwordHash: "!" } });
    } catch (error) {
      // Multiple server processes can initialize the world concurrently. If
      // another process won the unique username race, reuse its system user.
      system = await prisma.user.findUnique({ where: { username: "__system__" } });
      if (!system) throw error;
    }
  }
  const world = generateWorld(Math.floor(Math.random() * 0x7fffffff));
  let save;
  try {
    save = await prisma.save.create({
      data: {
        userId: system.id,
        name: "Global Multiplayer",
        isGlobal: true,
        globalKey: "GLOBAL",
        year: world.year,
        dayIndex: world.dayIndex,
        humanClubId: null,
        seed: world.seed,
        rngState: BigInt(world.rng.state),
      },
    });
  } catch (error) {
    // Another process may have won the singleton race between findFirst and
    // create.  Return that row rather than creating a second world.
    const winner = await prisma.save.findFirst({ where: { isGlobal: true } });
    if (winner) return { id: winner.id, name: winner.name };
    throw error;
  }
  await persistWorld(prisma, save.id, save.userId, world);
  return { id: save.id, name: save.name };
}

export async function loadGlobalWorld(prisma: PrismaClient): Promise<{ save: { id: number; name: string; revision: number }; world: World } | null> {
  return prisma.$transaction(async (tx) => {
    const save = await tx.save.findFirst({ where: { isGlobal: true } });
    if (!save) return null;
    const world = await rebuildWorld(tx, save);
    return { save: { id: save.id, name: save.name, revision: save.revision }, world };
  });
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
          seasonHistoryJson: world.seasonHistory.length > 0 ? JSON.stringify(world.seasonHistory) : null,
          pendingEventsJson: world.pendingDayEvents ? JSON.stringify(world.pendingDayEvents) : null,
          pendingMatchIdsJson: world.pendingDayMatchIds ? JSON.stringify(world.pendingDayMatchIds) : null,
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
      await tx.fixture.createMany({ data: world.fixtures.map((f) => ({ id: f.id, saveId, competitionId: f.competitionId, round: f.round, homeClubId: f.homeClubId, awayClubId: f.awayClubId, dayIndex: f.dayIndex, played: f.played, leg: f.leg ?? null, tie: f.tie ?? null, kickoffAt: f.kickoffAt !== undefined ? BigInt(f.kickoffAt) : null, homeClubNameSnapshot: f.homeClubNameSnapshot ?? null, awayClubNameSnapshot: f.awayClubNameSnapshot ?? null })) });
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
    // Multiplayer transfer market (Phase 2+).
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
          saveId,
          marketType: b.marketType,
          listingId: b.listingId,
          clubId: b.clubId,
          maxBid: b.maxBid,
          capMultiplierAtSubmission: b.capMultiplierAtSubmission ?? null,
          maximumAllowedByRuleAtSubmission: b.maximumAllowedByRuleAtSubmission ?? null,
          buyerDivisionAtSubmission: b.buyerDivisionAtSubmission ?? null,
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
          softClosed: l.softClosed,
          softCloseExtensions: l.softCloseExtensions,
        })),
      });
    }
    if (world.marketReservations.length > 0) {
      await tx.marketReservation.createMany({
        data: world.marketReservations.map((r) => ({
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
    if (target.isGlobal && world.mp.seasonId !== 0) {
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
      // At most one season is active globally.  Archiving the previous row in
      // the same transaction prevents the normalized calendar from showing
      // two active seasons after a rollover retry.
      await tx.mpSeason.updateMany({
        where: { id: { not: world.mp.seasonId }, status: { in: ["ACTIVE", "INTERSEASON", "ROLLOVER"] } },
        data: { status: "COMPLETE", completedRounds: 14, joinState: "LOCKED" },
      });
    }
    // Multiplayer queue + allocations (idempotent unique constraints).
    if (target.isGlobal) {
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
      await tx.mpAudit.deleteMany({});
      if (world.mpAudits.length > 0) {
        await tx.mpAudit.createMany({
          data: world.mpAudits.map((audit) => ({
            seasonId: audit.seasonId,
            clubId: audit.clubId,
            userId: audit.userId,
            eventType: audit.eventType,
            occurredAt: new Date(audit.occurredAt),
            metadata: audit.metadata,
          })),
        });
      }
    }
    if (opts?.dailyExecutions && opts.dailyExecutions.length > 0) {
      // Upsert each execution independently. A duplicate marker must not cause
      // unrelated new markers in the same batch to be lost.
      for (const execution of opts.dailyExecutions) {
        await tx.dailyExecution.upsert({
          where: {
            saveId_seasonId_date_executionType: {
              saveId,
              seasonId: execution.seasonId,
              date: execution.date,
              executionType: execution.executionType,
            },
          },
          update: {},
          create: {
            saveId,
            seasonId: execution.seasonId,
            date: execution.date,
            executionType: execution.executionType,
          },
        });
      }
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
    level: c.level,
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
    referenceTimezone: c.referenceTimezone ?? null,
    status: c.status ?? "ACTIVE",
    configJson: JSON.stringify(c.config),
    winnersJson: JSON.stringify(c.winners),
    knockoutsJson: JSON.stringify(c.knockouts),
    groupStandingsJson: JSON.stringify(c.groupStandings),
  };
}

function statRow(m: Match, saveId: number) {
  const s: MatchStats = m.stats;
  return {
    saveId,
    matchId: m.id,
    homePossession: s.possession[0],
    awayPossession: s.possession[1],
    homeShots: s.shots[0],
    awayShots: s.shots[1],
    homeOnGoal: s.onGoal[0],
    awayOnGoal: s.onGoal[1],
    homeOffTarget: s.offTarget[0],
    awayOffTarget: s.offTarget[1],
    homeFouls: s.fouls[0],
    awayFouls: s.fouls[1],
    homeCorners: s.corners[0],
    awayCorners: s.corners[1],
    homeYellows: s.yellows[0],
    awayYellows: s.yellows[1],
    homeReds: s.reds[0],
    awayReds: s.reds[1],
    homeTackles: s.tackles[0],
    awayTackles: s.tackles[1],
    homeWrongPasses: s.wrongPasses[0],
    awayWrongPasses: s.wrongPasses[1],
  };
}

async function rebuildWorld(
  prisma: PrismaClient | Tx,
  saveRow: { id: number; seed: number; year: number; dayIndex: number; humanClubId: number | null; rngState: bigint; isGlobal?: boolean; mpStateJson?: string | null; seasonSummaryJson: string | null; pendingEventsJson: string | null; pendingMatchIdsJson: string | null }
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
    mpAuditRows,
    marketBidRows,
    transferAuctionRows,
    freeAgentListingRows,
    marketReservationRows,
    playerMarketTransactionRows,
    aiEvaluationRows,
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
    prisma.trophy.findMany({ where: { saveId: saveRow.id } }),
    prisma.managerHistory.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.seasonAward.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.careerRecord.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.clubTicketPrices.findMany({ where: { saveId: saveRow.id } }),
    prisma.stadiumUpgrade.findMany({ where: { saveId: saveRow.id } }),
    prisma.liveMatch.findMany({ where: { saveId: saveRow.id } }),
    saveRow.isGlobal ? prisma.mpQueue.findMany({ orderBy: { queuedAt: "asc" } }) : Promise.resolve([]),
    saveRow.isGlobal ? prisma.mpAllocation.findMany() : Promise.resolve([]),
    saveRow.isGlobal ? prisma.mpMembership.findMany() : Promise.resolve([]),
    saveRow.isGlobal ? prisma.mpClubSeason.findMany() : Promise.resolve([]),
    saveRow.isGlobal ? prisma.mpActivity.findMany({ orderBy: { id: "asc" } }) : Promise.resolve([]),
    saveRow.isGlobal ? prisma.mpAudit.findMany({ orderBy: { id: "asc" } }) : Promise.resolve([]),
    prisma.marketBid.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.transferAuction.findMany({ where: { saveId: saveRow.id } }),
    prisma.freeAgentListing.findMany({ where: { saveId: saveRow.id } }),
    prisma.marketReservation.findMany({ where: { saveId: saveRow.id } }),
    prisma.playerMarketTransaction.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.aiEvaluation.findMany({ where: { saveId: saveRow.id } }),
  ]);

  const clubs: Club[] = clubRows.map((r) => {
    const r2 = r as unknown as {
      ownerUserId: number | null;
      timezone: string | null;
      competitionState: string;
      lastMeaningfulActivityAt: bigint | null;
      liveMatchAt: bigint | null;
    };
    return {
      id: r.id,
      name: r.name,
      shortName: r.shortName,
      ownerUserId: r2.ownerUserId ?? null,
      timezone: r2.timezone ?? null,
      competitionState: (r2.competitionState ?? "ACTIVE") as Club["competitionState"],
      lastMeaningfulActivityAt: r2.lastMeaningfulActivityAt !== null ? Number(r2.lastMeaningfulActivityAt) : null,
      abandonmentEligibleAt: (r as unknown as { abandonmentEligibleAt: bigint | null }).abandonmentEligibleAt !== null ? Number((r as unknown as { abandonmentEligibleAt: bigint | null }).abandonmentEligibleAt) : null,
      inactivityWarningStage: (r as unknown as { inactivityWarningStage?: number }).inactivityWarningStage ?? 0,
      liveMatchAt: r2.liveMatchAt !== null ? Number(r2.liveMatchAt) : null,
      country: r.country,
      highestDivision: r.highestDivision,
      level: r.level,
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
    };
  });

  for (const player of players) {
    normalizePlayer(player, clubs.find((club) => club.id === player.clubId));
  }

  const competitions: Competition[] = competitionRows.map((r) => {
    const r2 = r as unknown as { seasonId: number | null; tier: number; groupIndex: number; referenceTimezone: string | null; status: string };
    return {
      id: r.id,
      kind: r.kind as Competition["kind"],
      name: r.name,
      round: r.round,
      stage: r.stage as Competition["stage"],
      seasonId: r2.seasonId ?? undefined,
      tier: r2.tier ?? 1,
      groupIndex: r2.groupIndex ?? 0,
      referenceTimezone: r2.referenceTimezone ?? null,
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
    const f2 = f as unknown as { kickoffAt: bigint | null; homeClubNameSnapshot: string | null; awayClubNameSnapshot: string | null };
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
      homeClubNameSnapshot: f2.homeClubNameSnapshot ?? undefined,
      awayClubNameSnapshot: f2.awayClubNameSnapshot ?? undefined,
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
        ? {
            possession: [s.homePossession, s.awayPossession],
            shots: [s.homeShots, s.awayShots],
            onGoal: [s.homeOnGoal, s.awayOnGoal],
            offTarget: [s.homeOffTarget, s.awayOffTarget],
            fouls: [s.homeFouls, s.awayFouls],
            corners: [s.homeCorners, s.awayCorners],
            yellows: [s.homeYellows, s.awayYellows],
            reds: [s.homeReds, s.awayReds],
            tackles: [s.homeTackles, s.awayTackles],
            wrongPasses: [s.homeWrongPasses, s.awayWrongPasses],
          }
        : { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
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

  const transferAuctions: World["transferAuctions"] = transferAuctionRows.map((a) => {
    const r = a as unknown as { createdAt: bigint; deadline: bigint; originalDeadline: bigint; completedAt: bigint | null; cancelledAt: bigint | null };
    return {
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
      createdAt: Number(r.createdAt),
      deadline: Number(r.deadline),
      originalDeadline: Number(r.originalDeadline),
      status: a.status as World["transferAuctions"][number]["status"],
      completedAt: r.completedAt !== null ? Number(r.completedAt) : null,
      winningClubId: a.winningClubId,
      finalPrice: a.finalPrice,
      cancelledAt: r.cancelledAt !== null ? Number(r.cancelledAt) : null,
      softClosed: a.softClosed,
      softCloseExtensions: a.softCloseExtensions,
    };
  });

  const marketBids: World["marketBids"] = marketBidRows.map((b) => {
    const r = b as unknown as { createdAt: bigint; updatedAt: bigint; initialPriorityAt: bigint };
    return {
      id: b.id,
      marketType: b.marketType as "TRANSFER" | "FREE_AGENT",
      listingId: b.listingId,
      clubId: b.clubId,
      maxBid: b.maxBid,
      capMultiplierAtSubmission: b.capMultiplierAtSubmission ?? undefined,
      maximumAllowedByRuleAtSubmission: b.maximumAllowedByRuleAtSubmission ?? undefined,
      buyerDivisionAtSubmission: b.buyerDivisionAtSubmission ?? undefined,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      initialPriorityAt: Number(r.initialPriorityAt),
    };
  });

  const freeAgentListings: World["freeAgentListings"] = freeAgentListingRows.map((l) => {
    const r = l as unknown as { createdAt: bigint; deadline: bigint; completedAt: bigint | null };
    return {
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
      createdAt: Number(r.createdAt),
      deadline: Number(r.deadline),
      status: l.status as World["freeAgentListings"][number]["status"],
      completedAt: r.completedAt !== null ? Number(r.completedAt) : null,
      winningClubId: l.winningClubId,
      finalPrice: l.finalPrice,
      previousListingId: l.previousListingId,
      softClosed: l.softClosed,
      softCloseExtensions: l.softCloseExtensions,
    };
  });

  const marketReservations: World["marketReservations"] = marketReservationRows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    listingId: r.listingId,
    marketType: r.marketType as "TRANSFER" | "FREE_AGENT",
    amount: r.amount,
    createdAt: Number((r as unknown as { createdAt: bigint }).createdAt),
    releasedAt: (r as unknown as { releasedAt: bigint | null }).releasedAt !== null ? Number((r as unknown as { releasedAt: bigint | null }).releasedAt) : null,
  }));

  const playerMarketHistory: World["playerMarketHistory"] = playerMarketTransactionRows.map((t) => ({
    id: t.id,
    playerId: t.playerId,
    listingId: t.listingId,
    type: t.type as World["playerMarketHistory"][number]["type"],
    fromClubId: t.fromClubId,
    toClubId: t.toClubId,
    price: t.price,
    seasonId: t.seasonId,
    seasonKey: t.seasonKey,
    matchday: t.matchday,
    timestamp: Number((t as unknown as { timestamp: bigint }).timestamp),
  }));

  const aiEvaluations: World["aiEvaluations"] = aiEvaluationRows.map((e) => ({
    marketType: e.marketType as "TRANSFER" | "FREE_AGENT",
    listingId: e.listingId,
    clubId: e.clubId,
    evaluatedAt: Number((e as unknown as { evaluatedAt: bigint }).evaluatedAt),
    decision: e.decision,
    maxBid: e.maxBid,
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
    loans: loanRows.map((l) => ({
      id: l.id,
      playerId: l.playerId,
      fromClubId: l.fromClubId,
      toClubId: l.toClubId,
      startDay: l.startDay,
      endDay: l.endDay,
      recalled: l.recalled,
      listedAt: Number((l as unknown as { listedAt: bigint }).listedAt),
      claimableAt: Number((l as unknown as { claimableAt: bigint }).claimableAt),
    })),
    marketBids,
    transferAuctions,
    freeAgentListings,
    marketReservations,
    playerMarketHistory,
    aiEvaluations,
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
      matchTimeMode: "GLOBAL_FIXED_KICKOFF",
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
  };
  world.mp.seasonId ??= 0;
  world.mp.seasonYear ??= saveRow.year;
  world.mp.seasonMonth ??= 1;
  world.mp.seasonStatus ??= "PREPARATION";
  world.mp.completedRounds ??= 0;
  world.mp.joinLockRound ??= 7;
  world.mp.joinThresholdPercent ??= 0.5;
  world.mp.inactivityThresholds ??= { 1: 42, 2: 35, default: 28 };
  world.mp.matchTimeMode ??= "GLOBAL_FIXED_KICKOFF";
  world.mp.matchKickoffHour ??= 20;
  world.mp.joinState ??= "OPEN";
  world.mp.lastProcessedGameDay ??= 0;
  world.mp.lastDailyTickDay ??= 0;
  world.mp.lastDailyTickDate ??= null;
  world.mp.manualRound ??= null;
  world.mp.rolloverPhase ??= null;
  world.rng.state = Number(saveRow.rngState);
  world.nextId =
    Math.max(
      1,
      ...[...clubs.map((c) => c.id), ...players.map((p) => p.id), ...competitions.map((c) => c.id), ...fixtures.map((f) => f.id), ...matches.map((m) => m.id), ...world.loans.map((l) => l.id), ...transferAuctions.map((a) => a.id), ...marketBids.map((b) => b.id), ...freeAgentListings.map((l) => l.id), ...marketReservations.map((r) => r.id), ...playerMarketHistory.map((t) => t.id)]
    ) + 1;
  world.liveMatches = (liveRow ?? []).map((r) => jsonOr<LiveMatchState | null>(r.stateJson, null)).filter((x): x is LiveMatchState => !!x);
  for (const st of world.liveMatches) {
    st.subbedIn ??= [[], []];
    st.possessionCounts ??= [0, 0];
    st.playerYellows ??= {};
    st.suspensionClears ??= [];
    st.lastAdvancedAt ??= Date.now();
    st.stats.tackles ??= [0, 0];
    st.stats.wrongPasses ??= [0, 0];
  }
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
  world.mpAudits = (mpAuditRows ?? []).map((a) => ({ seasonId: a.seasonId, clubId: a.clubId, userId: a.userId, eventType: a.eventType, occurredAt: a.occurredAt.getTime(), metadata: a.metadata }));
  world.seasonHistory = jsonOr<World["seasonHistory"]>((saveRow as unknown as { seasonHistoryJson?: string | null }).seasonHistoryJson, []);
  world.pendingDayEvents = jsonOr<string[] | undefined>(saveRow.pendingEventsJson, undefined);
  world.pendingDayMatchIds = jsonOr<number[] | undefined>(saveRow.pendingMatchIdsJson, undefined);
  return world;
}
