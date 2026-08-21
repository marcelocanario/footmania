import type { PrismaClient } from "@prisma/client";
import type { RolloverContext, RolloverWorkflowStep, World } from "../game/types";
import { gameConfig } from "../config";
import {
  computeNextTierAssignments,
  createDivision,
  divisionsInSeason,
  ensureDivisionFull,
  generateDivisionFixtures,
  rebuildTierDivisions,
  recordDivision,
  recordInitialDivision,
  syncClubSeasons,
  syncMemberships,
  tierOf,
} from "../game/multiplayer";
import { validateDoubleRoundRobinFixtures } from "../game/league";
import { commitSeasonRollover, processContractExpiry, processSeasonEndContracts, processSeasonalAcademyIntake } from "../game/season";
import { ensureSeasonRow, issueAllocation, removeFillerClubs } from "./mpService";
import { applySeasonalEloRegression } from "../game/elo";
import { nextUint } from "../game/rng";

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
      club.competitionState = "DORMANT";
      club.abandonmentEligibleAt = null;
      club.lastMeaningfulActivityAt = null;
      world.news.push({ dayIndex: world.dayIndex, text: `${club.name} was moved to dormant status and will re-enter at the lowest tier if you return`, kind: "mp", clubId: club.id });
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

    const byTier = new Map<number, { clubId: number; timezone: string | null }[]>();
    for (const [clubId, tier] of assignments) {
      const club = world.clubs.find((candidate) => candidate.id === clubId);
      if (!club) continue;
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier)!.push({ clubId, timezone: club.timezone });
    }
    const lowestTier = assignments.size > 0 ? Math.max(...assignments.values()) : 1;
    const humansAtLowestTier = byTier.get(lowestTier)?.length ?? 0;
    const provisional = world.clubs.filter((club) => club.competitionState === "PROVISIONAL" && club.ownerUserId !== null);
    const provisionalTier = humansAtLowestTier > 0 && humansAtLowestTier % 8 === 0 ? lowestTier + 1 : lowestTier;
    if (provisional.length > 0) {
      if (!byTier.has(provisionalTier)) byTier.set(provisionalTier, []);
      for (const club of provisional) byTier.get(provisionalTier)!.push({ clubId: club.id, timezone: club.timezone });
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
    world.mp.seasonStartAt = now;
    for (const [tier, humans] of byTier) rebuildTierDivisions(world, context.targetSeasonId, tier, humans, ref, { generateFixtures: false, assignmentSeed: context.groupAssignmentSeed });
    if (byTier.size === 0) {
      const division = createDivision(world, { tier: 1, groupIndex: 0, seasonId: context.targetSeasonId, ref });
      ensureDivisionFull(world, division);
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
    world.mp.seasonStartAt = now;
    world.mp.lastAdvancedAt = now;
    world.mp.rolloverPhase = null;
    world.mp.rolloverContext = null;
  }

  if (world.mp.rolloverContext) markStepDone(world.mp.rolloverContext, step);
}
