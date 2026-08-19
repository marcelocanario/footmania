import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "./saveService";
import { seasonRefFor, seasonKey, joinLockRound } from "../game/clock";
import { MP_CONFIG } from "../config";
import { initSeason, rebuildTierDivisions, computeNextTierAssignments, resetDivisionStandings, divisionsInSeason, tierOf, humanCount, fillerCount, createDivision, ensureDivisionFull, generateDivisionFixtures, syncMemberships, syncClubSeasons } from "../game/multiplayer";
import { rolloverSeason } from "../game/season";
import { advanceLiveMatches, playFixtureInstant } from "../game/world";
import { releaseAllReservations, settleDueTransferAuctions } from "../game/market";

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

/** Remove ephemeral filler clubs when a season's divisions are rebuilt. */
function removeFillerClubs(world: World): void {
  const removed = new Set(world.clubs.filter((club) => club.ownerUserId === null && club.isHuman === false).map((club) => club.id));
  if (removed.size === 0) return;

  const removedPlayerIds = new Set(world.players.filter((player) => player.clubId !== null && removed.has(player.clubId)).map((player) => player.id));
  const loanIds = new Set(world.loans.filter((loan) => removed.has(loan.fromClubId) || (loan.toClubId !== null && removed.has(loan.toClubId))).map((loan) => loan.id));
  for (const player of world.players) {
    if (player.clubId !== null && removed.has(player.clubId)) {
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
  for (const listing of world.transferAuctions) {
    if (listing.status !== "ACTIVE" || (!removedPlayerIds.has(listing.playerId) && !removed.has(listing.sellerClubId))) continue;
    releaseAllReservations(world, listing.id, "TRANSFER");
    listing.status = "CANCELLED";
    listing.cancelledAt = Date.now();
    const player = world.players.find((candidate) => candidate.id === listing.playerId);
    if (player) player.onSale = false;
  }
  for (const listing of world.freeAgentListings) {
    if (listing.status !== "ACTIVE" || !removedPlayerIds.has(listing.playerId)) continue;
    releaseAllReservations(world, listing.id, "FREE_AGENT");
    listing.status = "CANCELLED";
    listing.completedAt = Date.now();
  }
  world.clubs = world.clubs.filter((club) => !removed.has(club.id));
  for (const id of removed) delete world.ticketPrices[id];
  world.stadiumUpgrades = world.stadiumUpgrades.filter((upgrade) => !removed.has(upgrade.clubId));
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
 * Ensure the in-memory world is initialized for the current real month: the
 * correct MpSeason row is referenced and a Division 1 exists with fixtures.
 */
export async function ensureCurrentSeason(prisma: PrismaClient): Promise<SeasonHandle> {
  const now = Date.now();
  const ref = seasonRefFor(new Date(now));
  const season = await ensureSeasonRow(prisma, ref);
  await ensureGlobalSave(prisma);
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("Global world unavailable");
  const world = loaded.world;
  const worldOrder = seasonOrder(world.mp.seasonYear, world.mp.seasonMonth);
  const realOrder = seasonOrder(ref.year, ref.month);

  // Resumable rollover (plan §58): if a previous rollover crashed mid-way, the
  // phase marker is still set. Resume it rather than leaving a half-rebuilt
  // pyramid in place.
  if (world.mp.rolloverPhase !== null) {
    await rollover(prisma);
    return ensureSeasonRow(prisma, ref);
  }

  if (worldOrder > realOrder) {
    // An admin rollover can intentionally move the test world into the next
    // calendar month before the host clock reaches it. Do not roll it back or
    // reset its standings just because a status/join request arrives.
    return ensureSeasonRow(prisma, { year: world.mp.seasonYear, month: world.mp.seasonMonth });
  }
  const isCurrentCalendarSeason = world.mp.seasonYear === ref.year && world.mp.seasonMonth === ref.month;
  if (!isCurrentCalendarSeason) {
    // Do not silently call initSeason for an existing world from a previous
    // month: that would leave the old clubs without promotion/relegation and
    // discard the opportunity to place queued clubs. Catch the world up
    // through the normal rollover pipeline instead.
    if (world.mp.seasonId !== 0) {
      await rollover(prisma);
      return ensureSeasonRow(prisma, ref);
    } else {
      initSeason(world, ref, season.seasonId);
      await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    }
  } else if (world.mp.seasonId !== season.seasonId) {
    // The normalized season row may have been recreated while the in-memory
    // world still has the same calendar month. Reattach it without rebuilding
    // the active competition.
    world.mp.seasonId = season.seasonId;
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
  }
  return season;
}

/**
 * Season rollover: finalize the old season, compute tier movement, rebuild
 * divisions for the new month, activate provisional clubs, issue budgets.
 */
export async function rollover(prisma: PrismaClient): Promise<SeasonHandle> {
  const now = Date.now();
  const ref = seasonRefFor(new Date(now));
  const loaded = await loadGlobalWorld(prisma);
  if (!loaded) throw new Error("Global world unavailable");
  const world = loaded.world;
  const realOrder = seasonOrder(ref.year, ref.month);
  const worldOrder = seasonOrder(world.mp.seasonYear, world.mp.seasonMonth);
  // If the persisted world is behind the host calendar (server downtime),
  // catch it up into the current month. Otherwise this is an explicit/admin
  // rollover and the target is the month after the current world month.
  const nextRef = worldOrder < realOrder
    ? ref
    : seasonRefFor(new Date(ref.endsAt));
  const newSeason = await ensureSeasonRow(prisma, nextRef);

  // Idempotency for forced/admin rollover and retries: if the world already
  // points at the requested next month, do not rebuild/reset that season.
  if (seasonOrder(world.mp.seasonYear, world.mp.seasonMonth) >= seasonOrder(nextRef.year, nextRef.month)) {
    return ensureSeasonRow(prisma, { year: world.mp.seasonYear, month: world.mp.seasonMonth });
  }

  // Finish work that may have been missed while the server was offline before
  // calculating movement. Timestamp auctions must not be lost at rollover,
  // and incomplete fixtures still need to contribute to final standings.
  settleDueTransferAuctions(world, now);
  advanceLiveMatches(world, now);
  const oldSeasonDivisions = divisionsInSeason(world, world.mp.seasonId).filter((division) => division.status !== "ARCHIVED");
  for (const division of oldSeasonDivisions) {
    for (const fixture of world.fixtures.filter((candidate) => candidate.competitionId === division.id && !candidate.played)) {
      playFixtureInstant(world, fixture);
    }
  }

  let revision = loaded.save.revision;
  const persist = async () => {
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, revision);
    revision++;
  };

  // 1. Compute next-tier assignments for all active humans (must run while
  //    the old divisions are still non-archived).
  const oldSeasonId = world.mp.seasonId;
  world.mp.rolloverPhase = "ROLL_OVER_STARTED";
  await persist();
  const { assignments, abandonedClubIds } = computeNextTierAssignments(world, oldSeasonId);
  world.mp.rolloverPhase = "MOVEMENTS_CALCULATED";
  await persist();

  // 2a. Abandoned clubs become DORMANT at rollover (plan §45): removed from the
  //     pyramid but never deleted. Roster, money, facilities and history are
  //     preserved; the club can return (plan §46).
  for (const clubId of abandonedClubIds) {
    const club = world.clubs.find((c) => c.id === clubId);
    if (!club) continue;
    club.competitionState = "DORMANT";
    club.abandonmentEligibleAt = null;
    club.lastMeaningfulActivityAt = null;
    world.news.push({ dayIndex: world.dayIndex, text: `${club.name} was moved to dormant status and will re-enter at the lowest tier if you return`, kind: "mp", clubId: club.id });
  }

  // 2. Finalize old season standings / prizes (light version).
  const oldDivisions = divisionsInSeason(world, oldSeasonId);
  for (const d of oldDivisions) {
    if (d.status !== "ARCHIVED") d.status = "ARCHIVED";
  }
  removeFillerClubs(world);

  // 3. Move humans to their new tiers, activate provisional clubs at lowest tier.
  const activeIds = [...assignments.keys()];
  const provisional = world.clubs.filter((c) => c.competitionState === "PROVISIONAL" && c.ownerUserId !== null);
  const lowestTier = activeIds.length > 0 ? Math.max(...assignments.values()) : 1;
  const byTier = new Map<number, { clubId: number; timezone: string | null }[]>();
  for (const [clubId, tier] of assignments) {
    if (!byTier.has(tier)) byTier.set(tier, []);
    const club = world.clubs.find((c) => c.id === clubId);
    byTier.get(tier)!.push({ clubId, timezone: club?.timezone ?? null });
  }
  // Provisional clubs enter at the lowest active tier + 1 (bottom of pyramid).
  const humansAtLowestTier = byTier.get(lowestTier)?.length ?? 0;
  // A provisional club joins the bottom edge without being promoted above
  // active clubs. If the current bottom tier is full of humans, create the
  // next tier; otherwise it can occupy the remaining bottom-division slots.
  const provisionalTier = humansAtLowestTier > 0 && humansAtLowestTier % 8 === 0 ? lowestTier + 1 : lowestTier;
  if (provisional.length > 0) {
    if (!byTier.has(provisionalTier)) byTier.set(provisionalTier, []);
    for (const club of provisional) {
      club.competitionState = "ACTIVE";
      byTier.get(provisionalTier)!.push({ clubId: club.id, timezone: club.timezone });
      world.mpQueue = world.mpQueue.filter((q) => q.clubId !== club.id);
    }
  }

  // 4. Rebuild divisions per tier (fresh season context).
  for (const [tier, humans] of byTier.entries()) {
    rebuildTierDivisions(world, newSeason.seasonId, tier, humans, nextRef);
  }
  world.mp.rolloverPhase = "DIVISIONS_CREATED";

  // A world with no human clubs still needs the launch state: one Division 1
  // containing filler AI. `rebuildTierDivisions([], ...)` intentionally makes
  // no groups, so create that bootstrap division explicitly.
  if (byTier.size === 0) {
    const div = createDivision(world, { tier: 1, groupIndex: 0, seasonId: newSeason.seasonId, ref: nextRef });
    ensureDivisionFull(world, div);
    world.fixtures.push(...generateDivisionFixtures(world, div, nextRef));
  }

  // 5. Reset world mp state to the new season.
  world.mp.seasonId = newSeason.seasonId;
  world.mp.seasonYear = newSeason.year;
  world.mp.seasonMonth = newSeason.month;
  world.mp.seasonStatus = "ACTIVE";
  world.mp.completedRounds = 0;
  world.mp.joinState = "OPEN";
  world.mp.lastProcessedGameDay = 0;
  // A fresh season starts with the real clock (or admin re-arms manual mode).
  world.mp.manualRound = null;
  // Fresh season standings already created by rebuildTierDivisions.
  // Season rollover housekeeping on players (aging, contracts) — reuses the
  // existing single-player rollover minus structure rebuild.
  rolloverSeason(world.rng, world);
  world.fixtures = world.fixtures.filter((f) => divisionsInSeason(world, newSeason.seasonId).some((d) => d.id === f.competitionId));
  world.matches = [];
  world.liveMatches = [];

  // Issue the new season's full allocation exactly once. Provisional clubs
  // already received PROVISIONAL_NEXT_SEASON for this season, so do not pay
  // them a second time as ACTIVE_FULL when they enter the pyramid.
  for (const [tier, humans] of byTier.entries()) {
    for (const entry of humans) {
      const alreadyReserved = world.seasonAllocations.some(
        (a) => a.clubId === entry.clubId && a.seasonId === newSeason.seasonId && a.type === "PROVISIONAL_NEXT_SEASON"
      );
      if (!alreadyReserved) await issueAllocation(prisma, world, entry.clubId, newSeason.seasonId, tier, { type: "ACTIVE_FULL" });
    }
  }

  // Refresh the normalized per-division memberships and per-club-season records
  // for the freshly rebuilt pyramid (plan §55).
  syncMemberships(world, newSeason.seasonId);
  syncClubSeasons(world, newSeason.seasonId);

  // Rollover complete: clear the resumable-phase marker.
  world.mp.rolloverPhase = null;

  await persist();
  return newSeason;
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
  const full = await tierBudget(prisma, tier);
  const amount = opts.type === "ACTIVE_PRORATED" ? proratedBudget(full, opts.remainingRounds ?? 14, 14) : full;
  const club = world.clubs.find((c) => c.id === clubId);
  if (club) {
    club.cash += amount;
    club.ledger.income.push({ code: 13, amount, day: world.dayIndex, label: `Season ${seasonId} budget` });
  }
  world.seasonAllocations.push({ clubId, seasonId, type: opts.type, amount, issuedAt: Date.now() });
  return amount;
}
