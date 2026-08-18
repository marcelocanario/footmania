import type { PrismaClient } from "@prisma/client";
import type { World } from "../game/types";
import { loadGlobalWorld, persistWorld, ensureGlobalSave } from "./saveService";
import { seasonRefFor, seasonKey } from "../game/clock";
import { auditMultiplayerEvent, initSeason, rebuildTierDivisions, computeNextTierAssignments, resetDivisionStandings, divisionsInSeason, tierOf, groupIndexOf, humanCount, fillerCount, createDivision, ensureDivisionFull, generateDivisionFixtures, simulateDivisionThroughRound, syncMemberships, syncClubSeasons, ROUNDS_PER_SEASON } from "../game/multiplayer";
import { awardLeaguePrizes, awardTvPositionBonuses, rolloverSeason } from "../game/season";
import { advanceLiveMatches, playFixtureInstant, settleDueAuctions, syncCompletedRounds } from "../game/world";
import { standingsTiebreak } from "../game/league";
import { readNumberSetting, writeNumberSetting } from "../game/budget";
import { MP_CONFIG } from "../config";

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
  joinLockRound: number;
  joinThresholdPercent: number;
}

export const JOIN_THRESHOLD_SETTING = "JOIN_THRESHOLD_PERCENT";
export const INACTIVITY_TIER1_SETTING = "INACTIVITY_TIER1_DAYS";
export const INACTIVITY_TIER2_SETTING = "INACTIVITY_TIER2_DAYS";
export const INACTIVITY_DEFAULT_SETTING = "INACTIVITY_DEFAULT_DAYS";
export const MATCH_TIME_MODE_SETTING = "MATCH_TIME_MODE";
export const MATCH_KICKOFF_HOUR_SETTING = "MATCH_KICKOFF_HOUR_UTC";

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
  world.auctions = world.auctions.filter((auction) => !removedPlayerIds.has(auction.playerId) && (auction.sellerClubId === null || !removed.has(auction.sellerClubId)));
  world.clubs = world.clubs.filter((club) => !removed.has(club.id));
  for (const id of removed) delete world.ticketPrices[id];
  world.stadiumUpgrades = world.stadiumUpgrades.filter((upgrade) => !removed.has(upgrade.clubId));
  world.tvDeals = world.tvDeals.filter((deal) => !removed.has(deal.clubId));
}

/** Find the MpSeason row for a calendar month, creating it if needed. */
export async function ensureSeasonRow(prisma: PrismaClient, ref: { year: number; month: number }): Promise<SeasonHandle> {
  const configuredThreshold = Math.max(0, Math.min(1, await readNumberSetting(prisma, JOIN_THRESHOLD_SETTING, MP_CONFIG.joinThresholdPercent)));
  const configuredLock = Math.floor(ROUNDS_PER_SEASON * configuredThreshold);
  const season = await prisma.mpSeason.upsert({
    where: { year_month: { year: ref.year, month: ref.month } },
    update: {},
    create: {
        year: ref.year,
        month: ref.month,
        startsAt: new Date(Date.UTC(ref.year, ref.month - 1, 1)),
        endsAt: new Date(Date.UTC(ref.month === 12 ? ref.year + 1 : ref.year, ref.month % 12, 1)),
         joinLockRound: configuredLock,
         joinThresholdPercent: configuredThreshold,
        status: "ACTIVE",
        completedRounds: 0,
        joinState: "OPEN",
    },
  });
  return { seasonId: season.id, year: season.year, month: season.month, joinLockRound: season.joinLockRound, joinThresholdPercent: season.joinThresholdPercent };
}

export async function configuredInactivityThresholds(prisma: PrismaClient): Promise<{ 1: number; 2: number; default: number }> {
  return {
    1: Math.max(1, await readNumberSetting(prisma, INACTIVITY_TIER1_SETTING, MP_CONFIG.inactivityThresholds[1])),
    2: Math.max(1, await readNumberSetting(prisma, INACTIVITY_TIER2_SETTING, MP_CONFIG.inactivityThresholds[2])),
    default: Math.max(1, await readNumberSetting(prisma, INACTIVITY_DEFAULT_SETTING, MP_CONFIG.inactivityThresholds.default)),
  };
}

export async function configuredMatchTiming(prisma: PrismaClient): Promise<{ mode: "GLOBAL_FIXED_KICKOFF" | "DIVISION_LOCAL_KICKOFF"; kickoffHour: number }> {
  const rawMode = await prisma.setting.findUnique({ where: { key: MATCH_TIME_MODE_SETTING } });
  const mode = rawMode?.value === "DIVISION_LOCAL_KICKOFF"
    ? "DIVISION_LOCAL_KICKOFF"
    : rawMode?.value === "GLOBAL_FIXED_KICKOFF"
      ? "GLOBAL_FIXED_KICKOFF"
      : MP_CONFIG.matchTimeMode;
  return {
    mode,
    kickoffHour: Math.max(0, Math.min(23, Math.round(await readNumberSetting(prisma, MATCH_KICKOFF_HOUR_SETTING, MP_CONFIG.matchKickoffHourUtc)))),
  };
}

export async function setLeagueSettings(prisma: PrismaClient, values: {
  joinThresholdPercent?: number;
  tier1InactivityDays?: number;
  tier2InactivityDays?: number;
  defaultInactivityDays?: number;
  matchTimeMode?: "GLOBAL_FIXED_KICKOFF" | "DIVISION_LOCAL_KICKOFF";
  matchKickoffHourUtc?: number;
}): Promise<{ joinThresholdPercent: number; inactivityThresholds: { 1: number; 2: number; default: number } }> {
  if (values.joinThresholdPercent !== undefined) await writeNumberSetting(prisma, JOIN_THRESHOLD_SETTING, Math.max(0, Math.min(1, values.joinThresholdPercent)));
  if (values.tier1InactivityDays !== undefined) await writeNumberSetting(prisma, INACTIVITY_TIER1_SETTING, Math.max(1, values.tier1InactivityDays));
  if (values.tier2InactivityDays !== undefined) await writeNumberSetting(prisma, INACTIVITY_TIER2_SETTING, Math.max(1, values.tier2InactivityDays));
  if (values.defaultInactivityDays !== undefined) await writeNumberSetting(prisma, INACTIVITY_DEFAULT_SETTING, Math.max(1, values.defaultInactivityDays));
  if (values.matchTimeMode !== undefined) await prisma.setting.upsert({ where: { key: MATCH_TIME_MODE_SETTING }, update: { value: values.matchTimeMode }, create: { key: MATCH_TIME_MODE_SETTING, value: values.matchTimeMode } });
  if (values.matchKickoffHourUtc !== undefined) await writeNumberSetting(prisma, MATCH_KICKOFF_HOUR_SETTING, Math.max(0, Math.min(23, values.matchKickoffHourUtc)));
  return {
    joinThresholdPercent: Math.max(0, Math.min(1, await readNumberSetting(prisma, JOIN_THRESHOLD_SETTING, MP_CONFIG.joinThresholdPercent))),
    inactivityThresholds: await configuredInactivityThresholds(prisma),
  };
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
  const inactivityThresholds = await configuredInactivityThresholds(prisma);
  const matchTiming = await configuredMatchTiming(prisma);
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
       world.mp.joinLockRound = season.joinLockRound;
       world.mp.joinThresholdPercent = season.joinThresholdPercent;
       world.mp.inactivityThresholds = inactivityThresholds;
       world.mp.matchTimeMode = matchTiming.mode;
       world.mp.matchKickoffHour = matchTiming.kickoffHour;
      syncCompletedRounds(world, now);
      for (const division of divisionsInSeason(world, season.seasonId)) {
        simulateDivisionThroughRound(world, division, world.mp.completedRounds, now);
      }
      syncMemberships(world, season.seasonId);
      syncClubSeasons(world, season.seasonId);
      await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    }
  } else if (world.mp.seasonId !== season.seasonId) {
    // The normalized season row may have been recreated while the in-memory
    // world still has the same calendar month. Reattach it without rebuilding
    // the active competition.
     world.mp.seasonId = season.seasonId;
     world.mp.joinLockRound = season.joinLockRound;
     world.mp.joinThresholdPercent = season.joinThresholdPercent;
     world.mp.inactivityThresholds = inactivityThresholds;
     world.mp.matchTimeMode = matchTiming.mode;
     world.mp.matchKickoffHour = matchTiming.kickoffHour;
    syncMemberships(world, season.seasonId);
    syncClubSeasons(world, season.seasonId);
    await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
  } else if (world.mp.manualRound === null) {
    // Refresh the join gate from the authoritative real clock even when the
    // worker has not reached its next interval yet.
    const completedBefore = world.mp.completedRounds;
    const statusBefore = world.mp.seasonStatus;
    const joinBefore = world.mp.joinState;
    const normalizedBefore = world.mpMemberships.length + world.mpClubSeasons.length;
    const settingsBefore = JSON.stringify({ lock: world.mp.joinLockRound, threshold: world.mp.joinThresholdPercent, inactivity: world.mp.inactivityThresholds, mode: world.mp.matchTimeMode, kickoff: world.mp.matchKickoffHour });
    world.mp.joinLockRound = season.joinLockRound;
    world.mp.joinThresholdPercent = season.joinThresholdPercent;
    world.mp.inactivityThresholds = inactivityThresholds;
    world.mp.matchTimeMode = matchTiming.mode;
    world.mp.matchKickoffHour = matchTiming.kickoffHour;
    syncCompletedRounds(world, now);
    if (normalizedBefore === 0) {
      syncMemberships(world, season.seasonId);
      syncClubSeasons(world, season.seasonId);
    }
    if (completedBefore !== world.mp.completedRounds || statusBefore !== world.mp.seasonStatus || joinBefore !== world.mp.joinState || normalizedBefore === 0 || settingsBefore !== JSON.stringify({ lock: world.mp.joinLockRound, threshold: world.mp.joinThresholdPercent, inactivity: world.mp.inactivityThresholds, mode: world.mp.matchTimeMode, kickoff: world.mp.matchKickoffHour })) {
      await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    }
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
  const hadRolloverPhase = world.mp.rolloverPhase !== null;
  // The current coordinator commits rollover atomically, so a non-null phase
  // can only be a marker left by an interrupted older build. Recompute from
  // the still-current season rather than treating the marker as completed
  // state; the final persist below clears it.
  world.mp.rolloverPhase = null;
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
    if (hadRolloverPhase) {
      await persistWorld(prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
    }
    return ensureSeasonRow(prisma, { year: world.mp.seasonYear, month: world.mp.seasonMonth });
  }

  // Finish work that may have been missed while the server was offline before
  // calculating movement. Timestamp auctions must not be lost at rollover,
  // and incomplete fixtures still need to contribute to final standings.
  settleDueAuctions(world, now);
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
  const { assignments, abandonedClubIds } = computeNextTierAssignments(world, oldSeasonId);
  const abandonedSet = new Set(abandonedClubIds);
  for (const entry of world.mpClubSeasons.filter((candidate) => candidate.seasonId === oldSeasonId)) {
    const division = entry.divisionId === null ? undefined : world.competitions.find((candidate) => candidate.id === entry.divisionId);
    const targetTier = assignments.get(entry.clubId);
    if (!division || targetTier === undefined || abandonedSet.has(entry.clubId)) continue;
    entry.promotionStatus = targetTier < tierOf(division) ? "PROMOTED" : "NONE";
    entry.relegationStatus = targetTier > tierOf(division) ? "RELEGATED" : "NONE";
  }
  world.mp.rolloverPhase = "MOVEMENTS_CALCULATED";

  // 2a. Abandoned clubs become DORMANT at rollover (plan §45): removed from the
  //     pyramid but never deleted. Roster, money, facilities and history are
  //     preserved; the club can return (plan §46).
  for (const clubId of abandonedClubIds) {
    const club = world.clubs.find((c) => c.id === clubId);
    if (!club) continue;
    club.competitionState = "DORMANT";
    club.abandonmentEligibleAt = null;
    club.inactivityWarningStage = 0;
    club.lastMeaningfulActivityAt = null;
    auditMultiplayerEvent(world, "ABANDONMENT_REMOVAL", { clubId: club.id });
    world.news.push({ dayIndex: world.dayIndex, text: `${club.name} was moved to dormant status and will re-enter at the lowest tier if you return`, kind: "mp", clubId: club.id });
  }

  // 2. Finalize old season standings and active-competition income before
  // archiving.  These functions are applied to divisions as well as legacy
  // single-player leagues and are safe here because rollover commits as one
  // idempotent world transition.
  awardTvPositionBonuses(world);
  awardLeaguePrizes(world);
  const oldDivisions = divisionsInSeason(world, oldSeasonId);
  captureSeasonHistory(world, oldSeasonId, oldDivisions);
  for (const d of oldDivisions) {
    if (d.status !== "ARCHIVED") d.status = "ARCHIVED";
  }
  removeFillerClubs(world);

  // 3. Move humans to their new tiers, activate provisional clubs at lowest tier.
  const activeIds = [...assignments.keys()];
  const queueOrder = new Map(world.mpQueue.map((entry) => [entry.clubId, entry.queuedAt]));
  const provisional = world.clubs
    .filter((c) => c.competitionState === "PROVISIONAL" && c.ownerUserId !== null)
    .sort((a, b) => (queueOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (queueOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  const provisionalIds = new Set(provisional.map((club) => club.id));
  const lowestTier = activeIds.length > 0 ? Math.max(...assignments.values()) : 1;
  const byTier = new Map<number, { clubId: number; timezone: string | null }[]>();
  for (const [clubId, tier] of assignments) {
    if (!byTier.has(tier)) byTier.set(tier, []);
    const club = world.clubs.find((c) => c.id === clubId);
    byTier.get(tier)!.push({ clubId, timezone: club?.timezone ?? null });
  }
  for (const [clubId, tier] of assignments) {
    auditMultiplayerEvent(world, "TIER_ASSIGNMENT", { clubId, metadata: JSON.stringify({ tier }) });
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
  // Rebuilding creates the new competition membership, but provisional clubs
  // must remain economically provisional until the old season's rollover
  // housekeeping has completed.  Otherwise rolloverSeason would consume one
  // contract season immediately on entry.
  for (const clubId of provisionalIds) {
    const club = world.clubs.find((candidate) => candidate.id === clubId);
    if (club) club.competitionState = "PROVISIONAL";
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
  // A new season begins a new calendar month: reset the daily-time marker so
  // the daily processor replays this month's dates (worker plan §4).
  world.mp.lastDailyTickDate = null;
  // Fresh season standings already created by rebuildTierDivisions.
  // Season rollover housekeeping on players (aging, contracts) — reuses the
  // existing single-player rollover minus structure rebuild.
  rolloverSeason(world.rng, world);
  // Keep archived fixtures and completed matches.  They are immutable season
  // history and remain addressable by their archived division/fixture IDs.
  // New-season workers naturally ignore them because they are already played
  // and their competitions are ARCHIVED.
  for (const clubId of provisionalIds) {
    const club = world.clubs.find((candidate) => candidate.id === clubId);
    if (club) club.competitionState = "ACTIVE";
  }
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

/** Snapshot the final standings of a completed season with club-name identity
 *  (plan §70/§71). Later AI replacement, renaming or dormancy never rewrites
 *  these records because each entry stores the name at archive time. */
function captureSeasonHistory(world: World, seasonId: number, divisions: ReturnType<typeof divisionsInSeason>): void {
  if (world.seasonHistory.some((entry) => entry.seasonId === seasonId)) return;
  const entry = {
    seasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    archivedAt: Date.now(),
    divisions: divisions.map((comp) => ({
      divisionId: comp.id,
      divisionName: comp.name,
      tier: tierOf(comp),
      groupIndex: groupIndexOf(comp),
      standings: standingsTiebreak(Object.values(comp.standings))
        .map((row) => ({
          clubId: row.clubId,
          clubName: world.clubs.find((club) => club.id === row.clubId)?.name ?? "",
          played: row.played,
          wins: row.wins,
          draws: row.draws,
          losses: row.losses,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          points: row.points,
        })),
    })),
  };
  world.seasonHistory.push(entry);
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
