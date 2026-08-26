import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "./saveService";
import { seasonRefFor, seasonKey, joinLockRound } from "../game/clock";
import { MP_CONFIG, gameConfig, scaleReferenceSeasonFlow } from "../config";
import { initSeason } from "../game/multiplayer";
import { releaseAllReservations, purgeClubBids, settleTransferAuction } from "../game/market";
import { migrateActiveContractMarket } from "./contractMarketMigration";

export async function configuredInactivityThresholds(prisma: PrismaClient): Promise<{ 1: number; 2: number; default: number }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ["INACTIVITY_TIER_1", "INACTIVITY_TIER_2", "INACTIVITY_DEFAULT"] } } });
  const values = new Map(rows.map((row) => [row.key, Number(row.value)]));
  return {
    1: values.get("INACTIVITY_TIER_1") || MP_CONFIG.inactivityThresholds[1],
    2: values.get("INACTIVITY_TIER_2") || MP_CONFIG.inactivityThresholds[2],
    default: values.get("INACTIVITY_DEFAULT") || MP_CONFIG.inactivityThresholds.default,
  };
}

export async function configuredMatchTiming(prisma: PrismaClient): Promise<{ mode: typeof MP_CONFIG.matchTimeMode; kickoffHour: number }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ["MATCH_TIME_MODE", "MATCH_KICKOFF_HOUR_UTC"] } } });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const mode = values.get("MATCH_TIME_MODE");
  return {
    mode: mode === "GLOBAL_FIXED_KICKOFF" || mode === "DIVISION_LOCAL_KICKOFF" ? mode : MP_CONFIG.matchTimeMode,
    kickoffHour: Math.max(0, Math.min(23, Number(values.get("MATCH_KICKOFF_HOUR_UTC") ?? MP_CONFIG.matchKickoffHourUtc))),
  };
}

export async function setLeagueSettings(
  prisma: PrismaClient,
  opts: { joinThresholdPercent?: number; tier1InactivityDays?: number; tier2InactivityDays?: number; defaultInactivityDays?: number; matchTimeMode?: typeof MP_CONFIG.matchTimeMode; matchKickoffHourUtc?: number },
) {
  const current = await configuredInactivityThresholds(prisma);
  const values = {
    joinThresholdPercent: opts.joinThresholdPercent ?? MP_CONFIG.joinThresholdPercent,
    inactivityThresholds: {
      1: opts.tier1InactivityDays ?? current[1],
      2: opts.tier2InactivityDays ?? current[2],
      default: opts.defaultInactivityDays ?? current.default,
    },
  };
  const settings = [
    ["JOIN_THRESHOLD_PERCENT", String(values.joinThresholdPercent)],
    ["INACTIVITY_TIER_1", String(values.inactivityThresholds[1])],
    ["INACTIVITY_TIER_2", String(values.inactivityThresholds[2])],
    ["INACTIVITY_DEFAULT", String(values.inactivityThresholds.default)],
  ] as const;
  for (const [key, value] of settings) await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  if (opts.matchTimeMode !== undefined) await prisma.setting.upsert({ where: { key: "MATCH_TIME_MODE" }, update: { value: opts.matchTimeMode }, create: { key: "MATCH_TIME_MODE", value: opts.matchTimeMode } });
  if (opts.matchKickoffHourUtc !== undefined) await prisma.setting.upsert({ where: { key: "MATCH_KICKOFF_HOUR_UTC" }, update: { value: String(opts.matchKickoffHourUtc) }, create: { key: "MATCH_KICKOFF_HOUR_UTC", value: String(opts.matchKickoffHourUtc) } });
  return values;
}

/**
 * Multiplayer season lifecycle service.
 *
 * The MpSeason row is the authoritative season record; the in-memory World
 * keeps the runtime state (divisions, fixtures, standings). All season-affecting
 * operations run inside the global lock.
 */

export interface SeasonHandle {
  seasonId: number;
  year: number;
  month: number;
}

function seasonOrder(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Remove ephemeral filler clubs when a season's divisions are rebuilt.
 *
 * Mirrors `retireFillerClub`'s market reconciliation (plan §102.9): a removed
 * filler's own commitments are voided, and its active transfer listings are
 * force-settled to their leading surviving bidder (or cancelled without bids)
 * BEFORE the squad players are destroyed, so paid commitments are honored and
 * no listing references a deleted club or player.
 */
export function removeFillerClubs(world: World): void {
  const removed = new Set(world.clubs.filter((club) => club.ownerUserId === null && club.isHuman === false).map((club) => club.id));
  if (removed.size === 0) return;

  // 1. Void every removed club's own market commitments first so destroyed
  //    fillers can neither win nor influence surviving listings.
  for (const clubId of removed) {
    purgeClubBids(world, clubId);
  }

  // 2. Resolve listings owned by removed clubs while the sellers/players
  //    still exist: with surviving bids -> force settlement; without -> cancel.
  const now = Date.now();
  for (const listing of [...world.transferAuctions]) {
    if (listing.status !== "ACTIVE" || !removed.has(listing.sellerClubId)) continue;
    const hasBids = world.marketBids.some((bid) => bid.marketType === "TRANSFER" && bid.listingId === listing.id);
    if (hasBids) {
      const settled = settleTransferAuction(world, listing, now, { forceClose: true });
      if (settled.ok) continue;
    }
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = now;
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (player) player.onSale = false;
    if (hasBids) {
      world.news.push({
        dayIndex: world.dayIndex,
        text: `The auction for ${player?.name ?? "a player"} was cancelled because it could not be settled`,
        kind: "auction",
      });
    }
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE") continue;
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (!player || player.clubId === null || !removed.has(player.clubId)) continue;
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    listing.status = "CANCELLED";
    listing.completedAt = now;
  }

  // 3. Detach loaned-out players, then destroy the remaining rosters/clubs.
  //    Force-settled players now belong to their winners and survive.
  const loanIds = new Set(world.loans.filter((loan) => removed.has(loan.fromClubId) || (loan.toClubId !== null && removed.has(loan.toClubId))).map((loan) => loan.id));
  const removedPlayerIds = new Set(world.players.filter((player) => player.clubId !== null && removed.has(player.clubId)).map((player) => player.id));
  for (const player of world.players) {
    if (removedPlayerIds.has(player.id)) {
      player.clubId = null;
      player.loanId = null;
      player.starter = false;
      player.tacPos = -1;
    } else if (player.loanId !== null && loanIds.has(player.loanId)) {
      player.loanId = null;
      player.clubId = null;
      player.starter = false;
      player.tacPos = -1;
    }
  }
  world.players = world.players.filter((player) => !removedPlayerIds.has(player.id));
  world.loans = world.loans.filter((loan) => !loanIds.has(loan.id));
  world.clubs = world.clubs.filter((club) => !removed.has(club.id));
}

/** Find the MpSeason row for a calendar month, creating it if needed. */
export async function ensureSeasonRow(prisma: PrismaClient, ref: { year: number; month: number }): Promise<SeasonHandle> {
  const existing = await prisma.mpSeason.findFirst({ where: { year: ref.year, month: ref.month } });
  if (existing) return { seasonId: existing.id, year: existing.year, month: existing.month };
  const created = await prisma.mpSeason.create({
    data: {
      year: ref.year,
      month: ref.month,
      startsAt: new Date(Date.UTC(ref.year, ref.month - 1, 1)),
      endsAt: new Date(Date.UTC(ref.month === 12 ? ref.year + 1 : ref.year, ref.month % 12, 1)),
      joinLockRound: joinLockRound(),
      joinThresholdPercent: 0.5,
      status: "ACTIVE",
      completedRounds: 0,
      joinState: "OPEN",
    },
  });
  return { seasonId: created.id, year: created.year, month: created.month };
}

/**
 * Ensure the global world has an initialized season. Civil year/month values
 * are display metadata only; the durable game clock owns later boundaries.
 */
export async function ensureCurrentSeason(prisma: PrismaClient): Promise<SeasonHandle> {
  await ensureGlobalSave(prisma);
  let loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("Global world unavailable");
  let world = loaded.world;
  if ((world.mp.calendarMigrationVersion ?? 0) < 1) {
    for (const player of world.players) player.salary = scaleReferenceSeasonFlow(player.salary);
    for (const listing of world.freeAgentListings) {
      if (listing.salaryBaselineAtListing !== undefined) listing.salaryBaselineAtListing = scaleReferenceSeasonFlow(listing.salaryBaselineAtListing);
    }
    for (const allocation of world.seasonAllocations) allocation.amount = scaleReferenceSeasonFlow(allocation.amount);
    // The Division 1 budget is no longer persisted: it is a configured value
    // (game.config.jsonc firstDivisionSeasonBudget) and needs no migration.
    // Already-issued allocations above stay immutable; future ones use config.
    world.mp.calendarMigrationVersion = 1;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("Global world unavailable after calendar migration");
    world = loaded.world;
  }
  if (migrateActiveContractMarket(world, Date.now())) {
    await prisma.scheduledEvent.updateMany({
      where: { saveId: loaded.save.id, type: "AUCTION_END", status: { in: ["PENDING", "FAILED"] } },
      data: { status: "CANCELLED", version: { increment: 1 } },
    });
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    const { materializeSeasonEvents } = await import("./scheduler");
    await materializeSeasonEvents(prisma, loaded.save.id, world);
    loaded = await loadGlobalWorld(prisma);
    if (!loaded) throw new Error("Global world unavailable after contract market migration");
    world = loaded.world;
  }
  if (world.mp.rolloverPhase !== null) return rollover(prisma, { calendarBoundary: true });
  if (world.mp.seasonId === 0) {
    const ref = seasonRefFor(new Date());
    const season = await ensureSeasonRow(prisma, ref);
    initSeason(world, ref, season.seasonId);
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    return season;
  }
  return ensureSeasonRow(prisma, { year: world.mp.seasonYear, month: world.mp.seasonMonth });
}

/** Public compatibility entry point backed by the durable rollover coordinator. */
export async function rollover(prisma: PrismaClient, options: { calendarBoundary?: boolean; leaseHeld?: boolean } = {}): Promise<SeasonHandle> {
  const { runRolloverCoordinatorInLock } = await import("./scheduler");
  return runRolloverCoordinatorInLock(prisma, { ...options, ignoreDueTime: true, now: new Date() });
}

/** Issue the seasonal budget to a club (idempotent per type). */
export async function issueAllocation(
  prisma: PrismaClient,
  world: World,
  clubId: number,
  seasonId: number,
  tier: number,
  opts: { type: "ACTIVE_FULL" | "ACTIVE_PRORATED" | "PROVISIONAL_NEXT_SEASON"; remainingRounds?: number }
): Promise<number> {
  const existing = world.seasonAllocations.find((a) => a.clubId === clubId && a.seasonId === seasonId && a.type === opts.type);
  if (existing) return existing.amount;
  const { tierBudget, proratedBudget } = await import("../game/budget");
  const full = tierBudget(tier);
  const amount = opts.type === "ACTIVE_PRORATED"
    ? proratedBudget(full, opts.remainingRounds ?? gameConfig.roundsPerSeason, gameConfig.roundsPerSeason)
    : full;
  const club = world.clubs.find((c) => c.id === clubId);
  if (club) {
    club.cash += amount;
    club.ledger.income.push({ code: 13, amount, day: world.dayIndex, label: `Season ${seasonId} budget` });
  }
  world.seasonAllocations.push({ clubId, seasonId, type: opts.type, amount, issuedAt: Date.now() });
  return amount;
}
