import type { PrismaClient } from "@prisma/client";
import type { RolloverContext, RolloverWorkflowStep, SeasonHistoryEntry, World } from "../game/types";
import { gameConfig } from "../config";
import {
  clubById,
  computeNextTierAssignments,
  createDivision,
  divisionsInSeason,
  ensureDivisionFull,
  enterLaunchHold,
  generateDivisionFixtures,
  groupIndexOf,
  rebuildTierDivisions,
  recordDivision,
  recordInitialDivision,
  syncClubSeasons,
  syncMemberships,
  tierOf,
} from "../game/multiplayer";
import { standingsTiebreak, validateDoubleRoundRobinFixtures } from "../game/league";
import { commitSeasonRollover, computeSeasonAwards, endLoan, processContractExpiry, processSeasonEndContracts, processSeasonalAcademyIntake, updateCareerRecords } from "../game/season";
import { closeMarketInvolvementForFreeze } from "../game/market";
import { recordActiveClubBoundaryChange } from "../game/population";
import { applySeasonalEloRegression, eloRatings } from "../game/elo";
import { revokeUnclaimedLoans } from "../game/loans";
import { NEWS_SUBJECTS, publishNews } from "../game/news";
import { msg } from "../i18n/catalog";
import { generatePreseasonReports } from "../game/preseasonReport";
import { ensureSeasonRow, issueAllocation, removeFillerClubs } from "./mpService";
import { nextUint } from "../game/rng";
import { dayBoundaryAtOrBefore } from "./dayBoundary";

export const ROLLOVER_WORKFLOW_STEPS: readonly RolloverWorkflowStep[] = [
  "SEASON_RESULTS_FINALIZE",
  "INTERSEASON_START",
  "PROMOTION_RELEGATION",
  "DIVISION_RESTRUCTURE",
  "WAITING_POOL_ASSIGNMENT",
  "NEXT_SEASON_BUDGET_ALLOCATION",
  "CONTRACT_END_PROCESSING",
  "SEASONAL_ACADEMY_INTAKE",
  "NEXT_SEASON_PREPARATION_OPEN",
  "NEXT_SEASON_FIXTURE_GENERATION",
  "NEXT_SEASON_STRUCTURE_VALIDATE",
  "SEASON_ROLLOVER_COMMIT",
];

export interface RolloverStepOptions {
  calendarBoundary?: boolean;
  now?: number;
}

function nextCivilSeason(ref: { year: number; month: number }): { year: number; month: number } {
  return ref.month === 12 ? { year: ref.year + 1, month: 1 } : { year: ref.year, month: ref.month + 1 };
}

function stepDone(context: RolloverContext, step: RolloverWorkflowStep): boolean {
  return context.completedSteps.includes(step);
}

function markStepDone(context: RolloverContext, step: RolloverWorkflowStep): void {
  if (!stepDone(context, step)) context.completedSteps.push(step);
}

function contextOrThrow(world: World): RolloverContext {
  if (!world.mp.rolloverContext) throw new Error("Rollover workflow has not been initialized");
  return world.mp.rolloverContext;
}

function targetRef(context: RolloverContext): { year: number; month: number } {
  return { year: context.targetYear, month: context.targetMonth };
}

async function initializeContext(prisma: PrismaClient, world: World, options: RolloverStepOptions): Promise<RolloverContext> {
  if (world.mp.rolloverContext) return world.mp.rolloverContext;
  const nextRef = nextCivilSeason({ year: world.mp.seasonYear, month: world.mp.seasonMonth });
  const target = await ensureSeasonRow(prisma, nextRef);
  const context: RolloverContext = {
    sourceSeasonId: world.mp.seasonId,
    targetSeasonId: target.seasonId,
    targetYear: target.year,
    targetMonth: target.month,
    groupAssignmentSeed: nextUint(world.rng),
    assignments: {},
    abandonedClubIds: [],
     provisionalClubIds: [],
     completedSteps: [],
     eloRegressionApplied: false,
  };
  world.mp.rolloverContext = context;
  return context;
}

function targetHumanClubs(world: World, seasonId: number): { clubId: number; tier: number }[] {
  const result: { clubId: number; tier: number }[] = [];
  const seen = new Set<number>();
  for (const division of divisionsInSeason(world, seasonId).filter((candidate) => candidate.status !== "ARCHIVED")) {
    for (const clubId of Object.keys(division.standings).map(Number)) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (!club || club.ownerUserId === null || seen.has(clubId)) continue;
      seen.add(clubId);
      result.push({ clubId, tier: tierOf(division) });
    }
  }
  return result;
}

/**
 * Archive the finished season (invariant #19): snapshot every division's final
 * standings with club names as of archive time, hand out division titles,
 * record the Division-1 champion/runner-up summary, and write season awards +
 * career records. Runs in SEASON_RESULTS_FINALIZE — before divisions are
 * archived and filler clubs destroyed — so names and rows are still live.
 * Idempotent: a retry after a crash cannot duplicate history, trophies or
 * awards for the same season.
 */
function archiveSeasonResults(world: World, context: RolloverContext): void {
  const divisions = divisionsInSeason(world, context.sourceSeasonId).filter((candidate) => candidate.status !== "ARCHIVED");
  const ratings = eloRatings(world);
  const entry: SeasonHistoryEntry = {
    seasonId: context.sourceSeasonId,
    seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
    archivedAt: Date.now(),
    divisions: divisions.map((comp) => ({
      divisionId: comp.id,
      divisionName: comp.name,
      tier: tierOf(comp),
      groupIndex: groupIndexOf(comp),
      standings: standingsTiebreak(Object.values(comp.standings), ratings).map((row) => {
        const club = clubById(world, row.clubId);
        return {
          clubId: row.clubId,
          clubName: club?.name ?? `Club ${row.clubId}`,
          played: row.played,
          wins: row.wins,
          draws: row.draws,
          losses: row.losses,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          points: row.points,
        };
      }),
    })),
  };

  const alreadyArchived = world.seasonHistory.some((history) => history.seasonId === entry.seasonId);
  if (!alreadyArchived) {
    world.seasonHistory.push(entry);

    // Trophies: each division champion adds one title under its name.
    for (const div of entry.divisions) {
      const champion = div.standings[0];
      if (!champion || champion.played === 0) continue;
      const club = clubById(world, champion.clubId);
      if (club) club.trophies[div.divisionName] = (club.trophies[div.divisionName] ?? 0) + 1;
    }

    // Season summary: the top tier's champion and runner-up.
    const topDivision = entry.divisions.filter((div) => div.tier === 1).sort((a, b) => a.groupIndex - b.groupIndex)[0];
    if (topDivision) {
      world.seasonSummary = {
        leagueChampionId: topDivision.standings[0]?.clubId ?? null,
        leagueRunnerUpId: topDivision.standings[1]?.clubId ?? null,
      };
    }

    computeSeasonAwards(world);
  }
  // Records upsert monotonically, so recomputing is always safe.
  updateCareerRecords(world);
}

async function writePlayerSeasonHistories(prisma: PrismaClient, world: World, context: RolloverContext): Promise<void> {
  const save = await prisma.save.findFirst({ where: { isGlobal: true }, select: { id: true } });
  if (!save) return;
  const seasonKey = `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`;
  // One row per player that belongs to a club this season (or has season stats). Idempotent upsert.
  for (const p of world.players) {
    // Only snapshot players with a club assignment or with season production
    if (p.clubId === null && p.seasonGoals === 0 && p.seasonAssists === 0 && p.yellows === 0 && p.reds === 0) continue;
    const club = p.clubId !== null ? world.clubs.find((c) => c.id === p.clubId) : null;
    const clubName = club?.name ?? "Free Agent";
    const appearances = 0; // placeholder: precise per-season minutes available via MatchEvents if needed
    const minutes = 0;
    try {
      await prisma.playerSeasonHistory.upsert({
        where: { saveId_playerId_seasonId: { saveId: save.id, playerId: p.id, seasonId: context.sourceSeasonId } },
        create: { saveId: save.id, playerId: p.id, seasonId: context.sourceSeasonId, seasonKey, clubId: p.clubId ?? 0, clubName, appearances, goals: p.seasonGoals, assists: p.seasonAssists, yellows: p.yellows, reds: p.reds, minutes, overall: p.overall, value: p.value, mvps: p.seasonMvps ?? 0 },
        // Retried rollovers (idempotent by design) refresh the snapshot so the
        // trend chart never goes stale: OVR/value are derived at rollover time.
        update: { overall: p.overall, value: p.value },
      });
    } catch {
      // Unique race across concurrent rollover retries is fine (idempotent)
    }
  }
}

/** Freeze the just-finished season's Z_raw distribution per coarse role for
 *  the next season (plan §10). The calibration is stored on the World mirror
 *  and persisted by persistWorld; a retried rollover replaces it idempotently.
 *  Only rated performances (>= 10 minutes) from the source season are used. */
function buildNextSeasonCalibration(world: World, sourceSeasonId: number): void {
  const ratings = world.playerMatchRatings?.filter((r) => r.seasonId === sourceSeasonId && r.ratingExact !== null) ?? [];
  if (ratings.length === 0) return;
  const byRole = new Map<string, number[]>();
  for (const r of ratings) {
    const list = byRole.get(r.primaryRole) ?? [];
    list.push(r.rawZ);
    byRole.set(r.primaryRole, list);
  }
  const nextSeasonId = sourceSeasonId + 1;
  world.roleCalibrations ??= [];
  world.roleCalibrations = world.roleCalibrations.filter((c) => !(c.seasonId === nextSeasonId));
  for (const [role, zRaws] of byRole) {
    world.roleCalibrations.push({ seasonId: nextSeasonId, role, zRaws });
  }
}

/** Execute one meaningful, independently retryable rollover operation. */
export async function executeRolloverStep(
  prisma: PrismaClient,
  world: World,
  step: RolloverWorkflowStep,
  options: RolloverStepOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const context = step === "SEASON_RESULTS_FINALIZE"
    ? await initializeContext(prisma, world, options)
    : contextOrThrow(world);
  if (stepDone(context, step)) return;

  if (step === "SEASON_RESULTS_FINALIZE") {
    // A division still catching up on a chunked history backfill (plan
    // Item 2 -- see game/multiplayer.ts's placeNewClub/returnDormantClub and
    // scheduler.ts's DIVISION_HISTORY_SIMULATE) has unplayed fixtures and an
    // incomplete standings table by design. Archiving it now would freeze
    // that incompleteness into the season's permanent history. Throwing
    // here fails this step (and, via ROLLOVER_PREREQUISITES, every step
    // after it) so the rollover retries later -- the same durable-retry
    // pattern every other scheduled event already relies on -- instead of
    // silently archiving a half-simulated division. In practice a backfill
    // drains within moments of being scheduled, so this is expected to
    // resolve on the rollover's next retry.
    const stillBackfilling = world.competitions.filter((c) => c.status === "SIMULATING_HISTORY");
    if (stillBackfilling.length > 0) {
      throw new Error(
        `SEASON_RESULTS_FINALIZE: ${stillBackfilling.length} division(s) still backfilling history (ids: ${stillBackfilling.map((c) => c.id).join(", ")}) -- retry once their DIVISION_HISTORY_SIMULATE chunks complete`,
      );
    }
    // Loan-market freeze (review C7): the last league game day has passed, so
    // every unclaimed listing is revoked. Claimed loans keep running until the
    // rollover reconcile returns their players. Idempotent via `recalled`.
    revokeUnclaimedLoans(world);
    // Invariant #19: archive standings/trophies/awards while the finished
    // season's divisions and names are still live.
    archiveSeasonResults(world, context);
    // Write-once per-player season snapshots for history (visible to Pro + auction viewers).
    await writePlayerSeasonHistories(prisma, world, context);
    // Season-frozen rating calibration (plan §10): freeze this season's Z_raw
    // distribution per coarse role for the NEXT season. Idempotent (replaces).
    buildNextSeasonCalibration(world, context.sourceSeasonId);
    world.mp.rolloverPhase = "RESULTS_FINALIZED";
  } else if (step === "INTERSEASON_START") {
    world.mp.seasonStatus = "INTERSEASON";
    world.mp.rolloverPhase = "INTERSEASON_STARTED";
  } else if (step === "PROMOTION_RELEGATION") {
    const computed = computeNextTierAssignments(world, context.sourceSeasonId);
    context.assignments = Object.fromEntries(computed.assignments);
    context.abandonedClubIds = computed.abandonedClubIds;
    if (!context.eloRegressionApplied) {
      applySeasonalEloRegression(world);
      context.eloRegressionApplied = true;
    }
    for (const clubId of computed.abandonedClubIds) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (!club) continue;
      // The club stayed fully active through the end of the season; only now
      // does it leave the pyramid. Close every live market involvement BEFORE
      // the frozen snapshot becomes authoritative, and end any loan boundary,
      // so nothing can later fire a deadline against a stopped clock.
      closeMarketInvolvementForFreeze(world, club.id, Date.now());
      for (const loan of world.loans.filter((l) => !l.recalled && (l.fromClubId === club.id || l.toClubId === club.id))) {
        endLoan(world, loan);
      }
      club.competitionState = "DORMANT";
      club.abandonmentEligibleAt = null;
      club.lastMeaningfulActivityAt = null;
      publishNews(world, {
        kind: "mp",
        subject: NEWS_SUBJECTS.clubStatus,
        recipientClubId: club.id,
        headline: "news.headline.pyramid",
        entries: [{ key: `dormant:${club.id}`, label: club.name, detail: msg("news.detail.dormant") }],
      });
    }
    world.mp.rolloverPhase = "MOVEMENTS_CALCULATED";
  } else if (step === "DIVISION_RESTRUCTURE") {
    // Contexts created before seeded regrouping may not have this field yet.
    // Allocate it once and keep it in the persisted rollover context so a
    // retry cannot choose a different arrangement.
    context.groupAssignmentSeed ??= nextUint(world.rng);
    const assignments = new Map(Object.entries(context.assignments).map(([clubId, tier]) => [Number(clubId), tier]));
    for (const division of divisionsInSeason(world, context.sourceSeasonId)) division.status = "ARCHIVED";
    removeFillerClubs(world);

    const byTier = new Map<number, { clubId: number }[]>();
    for (const [clubId, tier] of assignments) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (!club) continue;
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier)!.push({ clubId });
    }
    const lowestTier = assignments.size > 0 ? Math.max(...assignments.values()) : 1;
    const humansAtLowestTier = byTier.get(lowestTier)?.length ?? 0;
    const provisional = world.clubs.filter((club) => club.competitionState === "PROVISIONAL" && club.ownerUserId !== null);
    const provisionalTier = humansAtLowestTier > 0 && humansAtLowestTier % 8 === 0 ? lowestTier + 1 : lowestTier;
    if (provisional.length > 0) {
      if (!byTier.has(provisionalTier)) byTier.set(provisionalTier, []);
      for (const club of provisional) byTier.get(provisionalTier)!.push({ clubId: club.id });
      context.provisionalClubIds = provisional.map((club) => club.id);
    }

    const ref = targetRef(context);
    world.mp.seasonId = context.targetSeasonId;
    world.mp.seasonYear = context.targetYear;
    world.mp.seasonMonth = context.targetMonth;
    world.mp.seasonStatus = "PREPARATION";
     world.mp.seasonNumber = (world.mp.seasonNumber ?? world.year) + 1;
    world.mp.completedRounds = 0;
    world.mp.joinState = "OPEN";
    world.mp.lastProcessedGameDay = 0;
    world.mp.manualRound = null;
    world.mp.seasonStartAt = dayBoundaryAtOrBefore(now);
    world.mp.lastBoundaryAt = world.mp.seasonStartAt;
    for (const [tier, humans] of byTier) rebuildTierDivisions(world, context.targetSeasonId, tier, humans, ref, { generateFixtures: false, assignmentSeed: context.groupAssignmentSeed });
    if (byTier.size === 0) {
      // No human clubs anywhere: do NOT pre-create an all-AI Division 1. The
      // world waits for its full roster (awaitingLaunchRoster + pausedAt), and
      // the division forms lazily on the joins. Filler AI from the finished
      // season was already removed above.
      enterLaunchHold(world, now);
    }
    for (const clubId of context.provisionalClubIds) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (club) club.competitionState = "PROVISIONAL";
    }
    for (const [clubId, tier] of assignments) recordDivision(world, clubId, tier);
    syncMemberships(world, context.targetSeasonId);
    syncClubSeasons(world, context.targetSeasonId);
    world.mp.rolloverPhase = "DIVISIONS_CREATED";
  } else if (step === "WAITING_POOL_ASSIGNMENT") {
    for (const clubId of context.provisionalClubIds) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (!club) continue;
      club.competitionState = "ACTIVE";
      // A queued club enters the active persistent boundary only now. Its
      // target contribution minus the stock it arrived with goes into the
      // ledger; creation deliberately recorded nothing for it.
      recordActiveClubBoundaryChange(
        world,
        world.players.filter((p) => p.clubId === club.id).length,
        1,
      );
      world.mpQueue = world.mpQueue.filter((entry) => entry.clubId !== clubId);
      const division = divisionsInSeason(world, context.targetSeasonId).find((candidate) => candidate.standings[clubId] !== undefined);
      if (division) recordInitialDivision(world, clubId, tierOf(division));
    }
    syncMemberships(world, context.targetSeasonId);
    syncClubSeasons(world, context.targetSeasonId);
    world.mp.rolloverPhase = "WAITING_POOL_ASSIGNED";
  } else if (step === "NEXT_SEASON_BUDGET_ALLOCATION") {
    for (const entry of targetHumanClubs(world, context.targetSeasonId)) {
      const provisionalAllocation = world.seasonAllocations.some((allocation) => allocation.clubId === entry.clubId && allocation.seasonId === context.targetSeasonId && allocation.type === "PROVISIONAL_NEXT_SEASON");
      if (!provisionalAllocation) await issueAllocation(prisma, world, entry.clubId, context.targetSeasonId, entry.tier, { type: "ACTIVE_FULL" });
    }
  } else if (step === "CONTRACT_END_PROCESSING") {
    processSeasonEndContracts(world.rng, world);
    for (const player of world.players.filter((candidate) => candidate.contractDays <= 0)) processContractExpiry(world, player.id);
  } else if (step === "SEASONAL_ACADEMY_INTAKE") {
    processSeasonalAcademyIntake(world.rng, world);
  } else if (step === "NEXT_SEASON_PREPARATION_OPEN") {
    world.mp.seasonStatus = "PREPARATION";
    world.mp.joinState = "OPEN";
  } else if (step === "NEXT_SEASON_FIXTURE_GENERATION") {
    const ref = targetRef(context);
    for (const division of divisionsInSeason(world, context.targetSeasonId).filter((candidate) => candidate.status !== "ARCHIVED")) {
      if (!world.fixtures.some((fixture) => fixture.competitionId === division.id)) world.fixtures.push(...generateDivisionFixtures(world, division, ref));
    }
  } else if (step === "NEXT_SEASON_STRUCTURE_VALIDATE") {
    const divisions = divisionsInSeason(world, context.targetSeasonId).filter((candidate) => candidate.status !== "ARCHIVED");
    // Zero-human rollover: the world is in launch-hold mode with
    // no divisions yet — nothing to validate, and the joins build the
    // pyramid lazily.
    if (divisions.length === 0 && (world.mp.awaitingLaunchRoster === true || world.mp.awaitingFirstHuman === true)) return;
    if (divisions.length === 0) throw new Error("Next season has no active divisions");
    for (const division of divisions) {
      const clubIds = Object.keys(division.standings).map(Number);
      const fixtures = world.fixtures.filter((fixture) => fixture.competitionId === division.id);
      validateDoubleRoundRobinFixtures(fixtures, clubIds, gameConfig.league.turns);
    }
  } else if (step === "SEASON_ROLLOVER_COMMIT") {
    commitSeasonRollover(world);
    world.mp.seasonStatus = "ACTIVE";
    world.mp.joinState = "OPEN";
    world.mp.phase = "ACTIVE";
    world.mp.seasonDayIndex = 0;
    world.mp.startAbsoluteGameDay = (world.mp.absoluteGameDay ?? world.dayIndex) + 1;
    world.mp.seasonStartAt = dayBoundaryAtOrBefore(now);
    world.mp.lastBoundaryAt = world.mp.seasonStartAt;
    world.mp.lastAdvancedAt = now;
    // One pre-season briefing per human club on the first day of the new
    // season. Idempotent per club/season; flow data is consumed and cleared.
    generatePreseasonReports(world);
    world.mp.pendingPreseasonFlow = undefined;
    world.mp.rolloverPhase = null;
    world.mp.rolloverContext = null;
    // A season that rolled over with zero human clubs stays in waiting mode:
    // the clock remains held until the full roster arrives (entered in
    // DIVISION_RESTRUCTURE above, re-asserted here after the commit resets
    // seasonStartAt/lastAdvancedAt).
    const hasHumans = world.clubs.some((c) => c.ownerUserId !== null);
    if (!hasHumans) {
      enterLaunchHold(world, now);
    }
  }

  if (world.mp.rolloverContext) markStepDone(world.mp.rolloverContext, step);
}
