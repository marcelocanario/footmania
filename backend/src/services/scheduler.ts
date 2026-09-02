import type { PrismaClient } from "@prisma/client";
import type { RolloverWorkflowStep } from "../game/types";
import { withGlobalLease, withGlobalLock } from "./lock";
import { loadGlobalWorldMutable, persistWorld } from "./saveService";
import { publishUserWorldEvent, type UserWorldEvent } from "./worldEvents";
import { marketUpdatedEvents } from "./marketEvents";
import { gameConfig } from "../config";
import { calendarValues, payrollDayIndices } from "./seasonCalendar";
import { MP_CONFIG } from "../config";
import { startLiveMatch, advanceLiveMatches } from "../game/world";
import { simulateDivisionThroughRound } from "../game/multiplayer";
import { settleTransferAuction, cancelUnsettleableAuction, releaseAllReservations } from "../game/market";
import { processDueFreeAgentListing } from "../game/freeAgents";
import { processGameDayPayroll, processGameDayStart, processGameDayWeekly } from "../game/daily";
import { endLoan, processContractExpiry, processContractWarning } from "../game/season";
import { executeRolloverStep, ROLLOVER_WORKFLOW_STEPS } from "./seasonRolloverService";
import { notifyMatchStarted } from "./notifications";
import { notifyFinishedMatches } from "./matchNotifications";
import { publishLiveMatchUpdates } from "./liveMatchEvents";
import { loadPresetsForClubs } from "./automationPresetService";

export enum ScheduledEventType {
  GAME_DAY_ADVANCE = "GAME_DAY_ADVANCE",
  BEGIN_GAME_DAY = "BEGIN_GAME_DAY",
  MATCH_START = "MATCH_START",
  MATCH_COMPLETE = "MATCH_COMPLETE",
  PAYROLL_RUN = "PAYROLL_RUN",
  WEEKLY_SIM_UPDATE = "WEEKLY_SIM_UPDATE",
  AI_TRANSFER_TICK = "AI_TRANSFER_TICK",
  AUCTION_END = "AUCTION_END",
  LOAN_END = "LOAN_END",
  CONTRACT_WARNING = "CONTRACT_WARNING",
  CONTRACT_EXPIRE = "CONTRACT_EXPIRE",
  CONTRACT_END_PROCESSING = "CONTRACT_END_PROCESSING",
  SEASON_RESULTS_FINALIZE = "SEASON_RESULTS_FINALIZE",
  INTERSEASON_START = "INTERSEASON_START",
  PROMOTION_RELEGATION = "PROMOTION_RELEGATION",
  DIVISION_RESTRUCTURE = "DIVISION_RESTRUCTURE",
  WAITING_POOL_ASSIGNMENT = "WAITING_POOL_ASSIGNMENT",
  NEXT_SEASON_BUDGET_ALLOCATION = "NEXT_SEASON_BUDGET_ALLOCATION",
  SEASONAL_ACADEMY_INTAKE = "SEASONAL_ACADEMY_INTAKE",
  NEXT_SEASON_FIXTURE_GENERATION = "NEXT_SEASON_FIXTURE_GENERATION",
  NEXT_SEASON_STRUCTURE_VALIDATE = "NEXT_SEASON_STRUCTURE_VALIDATE",
  NEXT_SEASON_PREPARATION_OPEN = "NEXT_SEASON_PREPARATION_OPEN",
  SEASON_ROLLOVER = "SEASON_ROLLOVER",
  SEASON_ROLLOVER_COMMIT = "SEASON_ROLLOVER_COMMIT",
  DIVISION_HISTORY_SIMULATE = "DIVISION_HISTORY_SIMULATE",
}

export type ScheduledEventStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ScheduledEventTimeBasis = "GAME_DAY" | "REAL_TIME";
export type ScheduledEventPhase = "BEGIN_OF_DAY" | "INTRADAY" | "END_OF_DAY";

export interface ScheduleEventInput {
  saveId: number;
  type: ScheduledEventType | string;
  timeBasis: ScheduledEventTimeBasis;
  dueAbsoluteGameDay?: number | null;
  dueAt?: Date | null;
  phase?: ScheduledEventPhase | null;
  priority?: number;
  entityType?: string | null;
  entityId?: string | null;
  payload?: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface EventExecutionContext {
  source?: "AUTOMATIC" | "ADMIN";
  ignoreDueTime?: boolean;
  adminUserId?: number;
  reason?: string;
  now?: Date;
  calendarBoundary?: boolean;
  leaseHeld?: boolean;
}

export const SCHEDULED_EVENT_PRIORITIES: Record<string, number> = {
  BEGIN_GAME_DAY: 100,
  CONTRACT_WARNING: 200,
  CONTRACT_EXPIRE: 300,
  LOAN_END: 400,
  WEEKLY_SIM_UPDATE: 600,
  AI_TRANSFER_TICK: 700,
  DIVISION_HISTORY_SIMULATE: 750,
  PAYROLL_RUN: 800,
  INTERSEASON_START: 2000,
  SEASON_RESULTS_FINALIZE: 2100,
  PROMOTION_RELEGATION: 2200,
  DIVISION_RESTRUCTURE: 2300,
  WAITING_POOL_ASSIGNMENT: 2400,
  NEXT_SEASON_BUDGET_ALLOCATION: 2500,
  CONTRACT_END_PROCESSING: 2600,
  SEASONAL_ACADEMY_INTAKE: 2700,
  NEXT_SEASON_PREPARATION_OPEN: 2800,
  NEXT_SEASON_FIXTURE_GENERATION: 2900,
  NEXT_SEASON_STRUCTURE_VALIDATE: 3000,
  SEASON_ROLLOVER: 9400,
  SEASON_ROLLOVER_COMMIT: 9500,
};

const ROLLOVER_PREREQUISITES: Partial<Record<RolloverWorkflowStep, readonly RolloverWorkflowStep[]>> = {
  INTERSEASON_START: ["SEASON_RESULTS_FINALIZE"],
  PROMOTION_RELEGATION: ["INTERSEASON_START"],
  DIVISION_RESTRUCTURE: ["PROMOTION_RELEGATION"],
  WAITING_POOL_ASSIGNMENT: ["DIVISION_RESTRUCTURE"],
  NEXT_SEASON_BUDGET_ALLOCATION: ["WAITING_POOL_ASSIGNMENT"],
  CONTRACT_END_PROCESSING: ["NEXT_SEASON_BUDGET_ALLOCATION"],
  SEASONAL_ACADEMY_INTAKE: ["CONTRACT_END_PROCESSING"],
  NEXT_SEASON_PREPARATION_OPEN: ["SEASONAL_ACADEMY_INTAKE"],
  NEXT_SEASON_FIXTURE_GENERATION: ["DIVISION_RESTRUCTURE", "WAITING_POOL_ASSIGNMENT", "NEXT_SEASON_PREPARATION_OPEN"],
  NEXT_SEASON_STRUCTURE_VALIDATE: [
    "NEXT_SEASON_BUDGET_ALLOCATION",
    "CONTRACT_END_PROCESSING",
    "SEASONAL_ACADEMY_INTAKE",
    "NEXT_SEASON_FIXTURE_GENERATION",
  ],
  SEASON_ROLLOVER_COMMIT: ["NEXT_SEASON_STRUCTURE_VALIDATE"],
};

const ROLLOVER_STEP_SET = new Set<string>(ROLLOVER_WORKFLOW_STEPS);

export function rolloverEventKey(step: string, seasonId: number): string {
  return `${step}:${seasonId}`;
}

function isRolloverStep(type: string): type is RolloverWorkflowStep {
  return ROLLOVER_STEP_SET.has(type);
}

function eventSeasonId(event: { entityId: string | null }, payload: Record<string, unknown>): number | null {
  const payloadSeasonId = Number(payload.seasonId);
  if (Number.isFinite(payloadSeasonId) && payloadSeasonId > 0) return payloadSeasonId;
  const entitySeasonId = Number(event.entityId);
  return Number.isFinite(entitySeasonId) && entitySeasonId > 0 ? entitySeasonId : null;
}

async function assertRolloverPrerequisites(
  prisma: PrismaClient,
  event: { type: string; entityId: string | null },
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isRolloverStep(event.type)) return;
  const prerequisites = ROLLOVER_PREREQUISITES[event.type] ?? [];
  if (prerequisites.length === 0) return;
  const seasonId = eventSeasonId(event, payload);
  if (seasonId === null) throw new Error(`${event.type} is missing its source season id`);
  for (const prerequisite of prerequisites) {
    const prior = await prisma.scheduledEvent.findUnique({ where: { idempotencyKey: rolloverEventKey(prerequisite, seasonId) }, select: { status: true } });
    if (prior?.status !== "COMPLETED") throw new Error(`${event.type} requires ${prerequisite} to be COMPLETED`);
  }
}

function priorityFor(type: string, priority?: number): number {
  return priority ?? SCHEDULED_EVENT_PRIORITIES[type] ?? 5000;
}

/**
 * One chunk of a division's history backfill (plan Item 2): simulates round
 * `round` only via `simulateDivisionThroughRound`, then -- from inside the
 * DIVISION_HISTORY_SIMULATE handler -- re-enqueues itself for `round + 1` if
 * more remain, up to `finalRound` (the world.mp.completedRounds value in
 * effect when the FIRST chunk was scheduled, fixed for the whole backfill so
 * a season boundary crossing mid-backfill cannot move the goalposts).
 * Idempotent by (divisionId, round): a retry after a crash reschedules the
 * SAME chunk rather than skipping or duplicating it. Returns the event input
 * for the caller to pass to `scheduleEvent` -- this stays a pure, DB-free
 * helper so both the join/return routes (the first chunk) and the handler
 * itself (later chunks) build the exact same shape.
 */
export function divisionHistoryChunkInput(saveId: number, divisionId: number, round: number, finalRound: number): ScheduleEventInput {
  return {
    saveId,
    type: ScheduledEventType.DIVISION_HISTORY_SIMULATE,
    timeBasis: "REAL_TIME",
    dueAt: new Date(),
    entityType: "DIVISION",
    entityId: String(divisionId),
    payload: { divisionId, round, finalRound },
    idempotencyKey: `DIVISION_HISTORY_SIMULATE:${divisionId}:${round}`,
  };
}

/** Create an event once. Retries return the original row by idempotency key. */
export async function scheduleEvent(prisma: PrismaClient, input: ScheduleEventInput) {
  const existing = await prisma.scheduledEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;
  try {
    return await prisma.scheduledEvent.create({ data: scheduledEventData(input) });
  } catch (error) {
    // A concurrent materializer may win the unique insert race.
    if ((error as { code?: string }).code !== "P2002") throw error;
    return prisma.scheduledEvent.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  }
}

function scheduledEventData(input: ScheduleEventInput) {
  return {
    saveId: input.saveId,
    type: input.type,
    timeBasis: input.timeBasis,
    dueAbsoluteGameDay: input.dueAbsoluteGameDay ?? null,
    dueAt: input.dueAt ?? null,
    phase: input.phase ?? null,
    priority: priorityFor(input.type, input.priority),
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payloadJson: JSON.stringify(input.payload ?? {}),
    idempotencyKey: input.idempotencyKey,
    maxAttempts: input.maxAttempts ?? 3,
  };
}

/** Materialize a set of idempotent events with one read and one batch insert. */
async function scheduleEvents(prisma: PrismaClient, inputs: ScheduleEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const keys = [...new Set(inputs.map((input) => input.idempotencyKey))];
  const existing = await prisma.scheduledEvent.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } });
  const existingKeys = new Set(existing.map((event) => event.idempotencyKey));
  const missingByKey = new Map<string, ScheduleEventInput>();
  for (const input of inputs) {
    if (!existingKeys.has(input.idempotencyKey)) missingByKey.set(input.idempotencyKey, input);
  }
  const missing = [...missingByKey.values()];
  if (missing.length === 0) return;
  try {
    await prisma.scheduledEvent.createMany({ data: missing.map(scheduledEventData) });
  } catch (error) {
    // A second materializer may win the unique insert race. The next pass will
    // observe those rows; do not turn an idempotent scheduling retry into data loss.
    if ((error as { code?: string }).code !== "P2002") throw error;
  }
}

/** Materialize the current season without creating years of empty events. */
export async function materializeSeasonEvents(prisma: PrismaClient, saveId: number, world: import("../game/types").World): Promise<void> {
  const calendar = calendarValues();
  const startAbsolute = world.mp.startAbsoluteGameDay ?? ((world.mp.absoluteGameDay ?? world.dayIndex) - (world.mp.seasonDayIndex ?? world.dayIndex));
  const seasonId = world.mp.seasonId;
  const queued: ScheduleEventInput[] = [];
  const queue = (input: ScheduleEventInput) => queued.push(input);
  const gameDay = (index: number) => startAbsolute + index;
  const transitionTypes = [
    ScheduledEventType.INTERSEASON_START,
    ScheduledEventType.PROMOTION_RELEGATION,
    ScheduledEventType.DIVISION_RESTRUCTURE,
    ScheduledEventType.WAITING_POOL_ASSIGNMENT,
    ScheduledEventType.NEXT_SEASON_BUDGET_ALLOCATION,
    ScheduledEventType.CONTRACT_END_PROCESSING,
    ScheduledEventType.SEASONAL_ACADEMY_INTAKE,
    ScheduledEventType.NEXT_SEASON_PREPARATION_OPEN,
    ScheduledEventType.NEXT_SEASON_FIXTURE_GENERATION,
  ];
  const finalDayTypes = [
    ScheduledEventType.NEXT_SEASON_STRUCTURE_VALIDATE,
    ScheduledEventType.SEASON_ROLLOVER,
    ScheduledEventType.SEASON_ROLLOVER_COMMIT,
  ];
  // A changed split must not leave pending calendar events at their old due
  // day. Completed rows remain untouched so their idempotency keys stay final.
  const calendarTypes = [ScheduledEventType.SEASON_RESULTS_FINALIZE, ...transitionTypes, ...finalDayTypes];
  const pendingCalendarEvents = await prisma.scheduledEvent.findMany({
    where: { saveId, type: { in: calendarTypes }, entityType: "SEASON", entityId: String(seasonId), status: { in: ["PENDING", "FAILED"] } },
    select: { id: true, type: true },
  });
  for (const event of pendingCalendarEvents) {
    const index = event.type === ScheduledEventType.SEASON_RESULTS_FINALIZE
      ? calendar.lastLeagueMatchDayIndex
      : transitionTypes.includes(event.type as ScheduledEventType)
        ? calendar.interseasonStartIndex
        : calendar.seasonDays - 1;
    const phase = event.type === ScheduledEventType.SEASON_RESULTS_FINALIZE || finalDayTypes.includes(event.type as ScheduledEventType) ? "END_OF_DAY" : "BEGIN_OF_DAY";
    await prisma.scheduledEvent.update({ where: { id: event.id }, data: { dueAbsoluteGameDay: gameDay(index), phase, version: { increment: 1 } } });
  }
  for (let index = 0; index < calendar.seasonDays; index++) {
    const due = gameDay(index);
    queue({ saveId, type: ScheduledEventType.BEGIN_GAME_DAY, timeBasis: "GAME_DAY", dueAbsoluteGameDay: due, phase: "BEGIN_OF_DAY", idempotencyKey: `BEGIN_GAME_DAY:${seasonId}:${due}` });
    if (payrollDayIndices().includes(index)) {
      queue({ saveId, type: ScheduledEventType.PAYROLL_RUN, timeBasis: "GAME_DAY", dueAbsoluteGameDay: due, phase: "END_OF_DAY", idempotencyKey: `PAYROLL_RUN:${seasonId}:${due}` });
      queue({ saveId, type: ScheduledEventType.WEEKLY_SIM_UPDATE, timeBasis: "GAME_DAY", dueAbsoluteGameDay: due, phase: "END_OF_DAY", idempotencyKey: `WEEKLY_SIM_UPDATE:${seasonId}:${due}` });
    }
    if (index === calendar.lastLeagueMatchDayIndex) {
      queue({
        saveId,
        type: ScheduledEventType.SEASON_RESULTS_FINALIZE,
        timeBasis: "GAME_DAY",
        dueAbsoluteGameDay: due,
        phase: "END_OF_DAY",
        entityType: "SEASON",
        entityId: String(seasonId),
        payload: { seasonId },
        idempotencyKey: rolloverEventKey("SEASON_RESULTS_FINALIZE", seasonId),
      });
    }
    if (index === calendar.interseasonStartIndex) {
      for (const type of transitionTypes) {
        queue({
          saveId,
          type,
          timeBasis: "GAME_DAY",
          dueAbsoluteGameDay: due,
          phase: "BEGIN_OF_DAY",
          entityType: "SEASON",
          entityId: String(seasonId),
          payload: { seasonId },
          idempotencyKey: rolloverEventKey(type, seasonId),
        });
      }
    }
    if (index === calendar.seasonDays - 1) {
      for (const type of finalDayTypes) {
        queue({
          saveId,
          type,
          timeBasis: "GAME_DAY",
          dueAbsoluteGameDay: due,
          phase: "END_OF_DAY",
          entityType: "SEASON",
          entityId: String(seasonId),
          payload: { seasonId },
          idempotencyKey: rolloverEventKey(type, seasonId),
        });
      }
    }
  }
  // A division still catching up on missed history (its history backfill is
  // chunked across DIVISION_HISTORY_SIMULATE events, plan Item 2) owns its
  // own unplayed fixtures exclusively until the last chunk catches it up: a
  // fixture generated for an already-past round has a kickoffAt already in
  // the past, so without this guard the normal MATCH_START materialization
  // below would race the backfill chunker and turn it into a live match
  // playing out in real time instead of an instant history result.
  const simulatingHistoryDivisionIds = new Set(
    world.competitions.filter((c) => c.status === "SIMULATING_HISTORY").map((c) => c.id),
  );
  for (const fixture of world.fixtures) {
    if (fixture.played || fixture.kickoffAt === undefined) continue;
    if (simulatingHistoryDivisionIds.has(fixture.competitionId)) continue;
    queue({
      saveId,
      type: ScheduledEventType.MATCH_START,
      timeBasis: "REAL_TIME",
      dueAt: new Date(fixture.kickoffAt),
      phase: "INTRADAY",
      entityType: "MATCH",
      entityId: String(fixture.id),
      payload: { fixtureId: fixture.id },
      idempotencyKey: `MATCH_START:${fixture.id}`,
    });
  }
  for (const auction of world.transferAuctions.filter((candidate) => candidate.status === "ACTIVE")) {
    const pendingEvents = await prisma.scheduledEvent.findMany({ where: { saveId, type: ScheduledEventType.AUCTION_END, entityType: "AUCTION", entityId: String(auction.id), status: "PENDING" } });
    for (const pending of pendingEvents) {
      const pendingVersion = Number(parsePayload(pending.payloadJson).deadlineVersion ?? 0);
      if (pendingVersion !== (auction.deadlineVersion ?? 0)) {
        await prisma.scheduledEvent.update({ where: { id: pending.id }, data: { status: "CANCELLED", version: { increment: 1 } } });
      }
    }
    queue({ saveId, type: ScheduledEventType.AUCTION_END, timeBasis: "REAL_TIME", dueAt: new Date(auction.deadline), phase: "INTRADAY", entityType: "AUCTION", entityId: String(auction.id), payload: { auctionId: auction.id, deadlineVersion: auction.deadlineVersion ?? 0 }, idempotencyKey: `AUCTION_END:${auction.id}:${auction.deadlineVersion ?? 0}` });
  }
  for (const listing of world.freeAgentListings.filter((candidate) => candidate.status === "ACTIVE")) {
    // A soft-close bid replaces the deadline; cancel pending events queued for
    // the superseded deadline so they cannot fire early and fail noisily.
    const pendingFaEvents = await prisma.scheduledEvent.findMany({ where: { saveId, type: ScheduledEventType.AUCTION_END, entityType: "FREE_AGENT", entityId: String(listing.id), status: "PENDING" } });
    for (const pending of pendingFaEvents) {
      if (Number(parsePayload(pending.payloadJson).deadline ?? 0) !== listing.deadline) {
        await prisma.scheduledEvent.update({ where: { id: pending.id }, data: { status: "CANCELLED", version: { increment: 1 } } });
      }
    }
    queue({ saveId, type: ScheduledEventType.AUCTION_END, timeBasis: "REAL_TIME", dueAt: new Date(listing.deadline), phase: "INTRADAY", entityType: "FREE_AGENT", entityId: String(listing.id), payload: { listingId: listing.id, marketType: "FREE_AGENT", deadline: listing.deadline }, idempotencyKey: `AUCTION_END:FREE_AGENT:${listing.id}:${listing.deadline}` });
  }
  const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
  const warningDays = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
  const pendingContractEvents = await prisma.scheduledEvent.findMany({
    where: {
      saveId,
      type: { in: [ScheduledEventType.CONTRACT_WARNING, ScheduledEventType.CONTRACT_EXPIRE] },
      status: { in: ["PENDING", "FAILED"] },
      entityType: "PLAYER",
    },
    select: { id: true, type: true, entityId: true, payloadJson: true, idempotencyKey: true },
  });
  for (const event of pendingContractEvents) {
    const player = world.players.find((candidate) => candidate.id === Number(event.entityId));
    const payload = parsePayload(event.payloadJson);
    const scheduledContractDays = Number(payload.contractDaysAtScheduling);
    const expectedDue = Number(payload.dueAbsoluteGameDay);
    const valid = event.type === ScheduledEventType.CONTRACT_WARNING
      ? player !== undefined && player.clubId !== null && player.contractDays > 0 && player.contractDays <= warningDays
      : player !== undefined && player.clubId !== null && player.contractDays <= gameConfig.seasonDays;
    const expectedKey = !valid || !Number.isFinite(expectedDue) || scheduledContractDays !== player?.contractDays
      ? null
      : event.type === ScheduledEventType.CONTRACT_WARNING
        ? `CONTRACT_WARNING:${event.entityId}:${seasonId}:${scheduledContractDays}`
        : `CONTRACT_EXPIRE:${event.entityId}:${seasonId}:${scheduledContractDays}`;
    if (expectedKey === null || event.idempotencyKey !== expectedKey) {
      await prisma.scheduledEvent.updateMany({ where: { id: event.id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "CANCELLED", version: { increment: 1 } } });
    }
  }
  for (const loan of world.loans.filter((candidate) => !candidate.recalled)) {
    const dueAbsolute = world.mp.loanEndAbsoluteGameDays?.[String(loan.id)] ?? currentAbsolute + Math.max(0, loan.endDay - loan.startDay);
    queue({
      saveId,
      type: ScheduledEventType.LOAN_END,
      timeBasis: "GAME_DAY",
      dueAbsoluteGameDay: dueAbsolute,
      phase: "END_OF_DAY",
      entityType: "LOAN",
      entityId: String(loan.id),
      payload: { loanId: loan.id },
      idempotencyKey: `LOAN_END:${loan.id}:${dueAbsolute}`,
    });
  }
  for (const player of world.players.filter((candidate) => candidate.clubId !== null && candidate.contractDays > 0 && candidate.contractDays <= warningDays)) {
    const warningDue = currentAbsolute + Math.max(0, player.contractDays - warningDays);
    queue({
      saveId,
      type: ScheduledEventType.CONTRACT_WARNING,
      timeBasis: "GAME_DAY",
      dueAbsoluteGameDay: warningDue,
      phase: "END_OF_DAY",
      entityType: "PLAYER",
      entityId: String(player.id),
      payload: { playerId: player.id, dueAbsoluteGameDay: warningDue, contractDaysAtScheduling: player.contractDays },
      idempotencyKey: `CONTRACT_WARNING:${player.id}:${seasonId}:${player.contractDays}`,
    });
  }
  for (const player of world.players.filter((candidate) => candidate.clubId !== null && candidate.contractDays <= gameConfig.seasonDays)) {
    const dueAbsolute = currentAbsolute + Math.max(0, player.contractDays);
    queue({
      saveId,
      type: ScheduledEventType.CONTRACT_EXPIRE,
      timeBasis: "GAME_DAY",
      dueAbsoluteGameDay: dueAbsolute,
      phase: "END_OF_DAY",
      entityType: "PLAYER",
      entityId: String(player.id),
      payload: { playerId: player.id, dueAbsoluteGameDay: dueAbsolute, contractDaysAtScheduling: player.contractDays },
      idempotencyKey: `CONTRACT_EXPIRE:${player.id}:${seasonId}:${player.contractDays}`,
    });
  }
  await scheduleEvents(prisma, queued);
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function eventDue(event: { timeBasis: string; dueAt: Date | null; dueAbsoluteGameDay: number | null }, now: Date, absoluteGameDay?: number): boolean {
  if (event.timeBasis === "REAL_TIME") return event.dueAt !== null && event.dueAt.getTime() <= now.getTime();
  return event.dueAbsoluteGameDay !== null && absoluteGameDay !== undefined && event.dueAbsoluteGameDay <= absoluteGameDay;
}

/** Requeue claims left RUNNING by a crashed worker after the lease window. */
async function recoverStaleRunningEvents(prisma: PrismaClient, saveId: number, now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - gameConfig.scheduler.leaseSeconds * 2 * 1000);
  const stale = await prisma.scheduledEvent.findMany({
    where: { saveId, status: "RUNNING", startedAt: { lte: staleBefore } },
    select: { id: true, attempts: true, maxAttempts: true },
  });
  const retryable = stale.filter((event) => event.attempts < event.maxAttempts).map((event) => event.id);
  const exhausted = stale.filter((event) => event.attempts >= event.maxAttempts).map((event) => event.id);
  if (retryable.length > 0) {
    await prisma.scheduledEvent.updateMany({
      where: { id: { in: retryable }, status: "RUNNING" },
      data: { status: "PENDING", lastError: "Recovered stale scheduler claim", version: { increment: 1 } },
    });
  }
  if (exhausted.length > 0) {
    await prisma.scheduledEvent.updateMany({
      where: { id: { in: exhausted }, status: "RUNNING" },
      data: { status: "FAILED", lastError: "Scheduler claim expired after maximum attempts", version: { increment: 1 } },
    });
  }
}

interface DomainEventResult {
  persistWorld?: boolean;
  userEvents?: { userId: number; event: UserWorldEvent }[];
}

type LoadedGlobalWorld = NonNullable<Awaited<ReturnType<typeof loadGlobalWorldMutable>>>;

function invalidateHumanUsers(world: import("../game/types").World, scope: string): { userId: number; event: UserWorldEvent }[] {
  return world.clubs
    .filter((club) => club.ownerUserId !== null)
    .map((club) => ({ userId: club.ownerUserId!, event: { type: "invalidate" as const, scope } }));
}

export interface RolloverCoordinatorOptions {
  source?: "AUTOMATIC" | "ADMIN";
  ignoreDueTime?: boolean;
  adminUserId?: number;
  reason?: string;
  now?: Date;
  calendarBoundary?: boolean;
  leaseHeld?: boolean;
}

/** Execute one durable event. Timing may be bypassed, domain checks may not. */
export async function executeScheduledEvent(prisma: PrismaClient, eventId: string, context: EventExecutionContext = {}) {
  return withGlobalLock(async () => {
    if (context.leaseHeld) return executeScheduledEventInLock(prisma, eventId, { ...context, leaseHeld: true });
    return withGlobalLease(prisma, () => executeScheduledEventInLock(prisma, eventId, { ...context, leaseHeld: true }), context.now ?? new Date());
  });
}

async function executeScheduledEventInLock(prisma: PrismaClient, eventId: string, context: EventExecutionContext = {}, loadedOverride?: LoadedGlobalWorld) {
    const event = await prisma.scheduledEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new Error("Scheduled event not found");
    if (event.status === "COMPLETED") return event;
    if (event.status === "CANCELLED") throw new Error("Cancelled scheduled events cannot execute");
    const now = context.now ?? new Date();
    const loaded = loadedOverride ?? await loadGlobalWorldMutable(prisma);
    if (!loaded || loaded.save.id !== event.saveId) throw new Error("World unavailable");
    const absoluteGameDay = loaded.world.mp.absoluteGameDay ?? loaded.world.dayIndex;
    if (!context.ignoreDueTime && !eventDue(event, now, absoluteGameDay)) throw new Error("Scheduled event is not due");

    const claimed = await prisma.scheduledEvent.updateMany({
      where: { id: eventId, status: { in: ["PENDING", "FAILED"] }, attempts: { lt: event.maxAttempts } },
      data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: now, lastError: null, executionSource: context.source ?? "AUTOMATIC", executedByAdminUserId: context.adminUserId ?? null, version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      const current = await prisma.scheduledEvent.findUniqueOrThrow({ where: { id: eventId } });
      if (current.status === "COMPLETED") return current;
      throw new Error(`Scheduled event is already ${current.status.toLowerCase()}`);
    }

    try {
      const payload = parsePayload(event.payloadJson);
      await assertRolloverPrerequisites(prisma, event, payload);
      const result = await executeDomainEvent(prisma, loaded.save.id, loaded.world, event.type, event.entityId, payload, context, now);
      if (event.type === ScheduledEventType.GAME_DAY_ADVANCE || result?.persistWorld === false) {
        for (const item of result?.userEvents ?? []) publishUserWorldEvent(item.userId, item.event);
        return prisma.scheduledEvent.update({ where: { id: eventId }, data: { status: "COMPLETED", completedAt: now, version: { increment: 1 } } });
      }
      await persistWorld(prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      if (loadedOverride) loaded.save.revision += 1;
      for (const item of result?.userEvents ?? []) publishUserWorldEvent(item.userId, item.event);
      return prisma.scheduledEvent.update({ where: { id: eventId }, data: { status: "COMPLETED", completedAt: now, version: { increment: 1 } } });
    } catch (error) {
      await prisma.scheduledEvent.update({ where: { id: eventId }, data: { status: "FAILED", lastError: error instanceof Error ? error.message : String(error), version: { increment: 1 } } });
      throw error;
    }
}

const MANDATORY_ADVANCE_EVENTS = new Set<string>([
  ScheduledEventType.PAYROLL_RUN,
  ScheduledEventType.WEEKLY_SIM_UPDATE,
  ScheduledEventType.AI_TRANSFER_TICK,
  ScheduledEventType.LOAN_END,
  ScheduledEventType.CONTRACT_WARNING,
  ScheduledEventType.CONTRACT_EXPIRE,
  ScheduledEventType.SEASON_RESULTS_FINALIZE,
  ScheduledEventType.INTERSEASON_START,
  ScheduledEventType.PROMOTION_RELEGATION,
  ScheduledEventType.DIVISION_RESTRUCTURE,
  ScheduledEventType.NEXT_SEASON_BUDGET_ALLOCATION,
  ScheduledEventType.SEASONAL_ACADEMY_INTAKE,
  ScheduledEventType.NEXT_SEASON_FIXTURE_GENERATION,
  ScheduledEventType.NEXT_SEASON_STRUCTURE_VALIDATE,
  ScheduledEventType.NEXT_SEASON_PREPARATION_OPEN,
  ScheduledEventType.SEASON_ROLLOVER,
  ScheduledEventType.SEASON_ROLLOVER_COMMIT,
  ScheduledEventType.CONTRACT_END_PROCESSING,
]);

/** Drain mandatory events while the caller already owns WORLD_CLOCK. */
export async function executeMandatoryEventsInLock(prisma: PrismaClient, saveId: number, absoluteGameDay: number, now = new Date(), loadedOverride?: LoadedGlobalWorld): Promise<void> {
  await recoverStaleRunningEvents(prisma, saveId, now);
  const events = await prisma.scheduledEvent.findMany({
    where: {
      saveId,
      type: { in: [...MANDATORY_ADVANCE_EVENTS] },
      status: { in: ["PENDING", "FAILED"] },
      timeBasis: "GAME_DAY",
      dueAbsoluteGameDay: { lte: absoluteGameDay },
    },
    orderBy: [{ priority: "asc" }, { dueAbsoluteGameDay: "asc" }],
  });
  let loaded = loadedOverride;
  for (const event of events) {
    if (!loaded) loaded = await loadGlobalWorldMutable(prisma) ?? undefined;
    await executeScheduledEventInLock(prisma, event.id, { now, leaseHeld: true }, loaded);
  }
}

/** Execute every event materialized for one game day while already locked. */
export async function executeGameDayEventsInLock(prisma: PrismaClient, saveId: number, absoluteGameDay: number, now = new Date(), phase?: ScheduledEventPhase, leaseHeld = false, loadedOverride?: LoadedGlobalWorld): Promise<void> {
  const execute = async () => {
    await recoverStaleRunningEvents(prisma, saveId, now);
    const events = await prisma.scheduledEvent.findMany({
      where: { saveId, status: { in: ["PENDING", "FAILED"] }, timeBasis: "GAME_DAY", dueAbsoluteGameDay: absoluteGameDay, ...(phase ? { phase } : {}) },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    let loaded = loadedOverride;
    for (const event of events) {
      if (!loaded) loaded = await loadGlobalWorldMutable(prisma) ?? undefined;
      await executeScheduledEventInLock(prisma, event.id, { now, leaseHeld: true }, loaded);
    }
  };
  if (leaseHeld) return execute();
  return withGlobalLease(prisma, execute, now);
}

async function executeDomainEvent(prisma: PrismaClient, saveId: number, world: import("../game/types").World, type: string, entityId: string | null, payload: Record<string, unknown>, context: EventExecutionContext, now: Date): Promise<DomainEventResult | void> {
  switch (type) {
    case ScheduledEventType.MATCH_START: {
      const fixtureId = Number(payload.fixtureId ?? entityId);
      const fixture = world.fixtures.find((candidate) => candidate.id === fixtureId);
      if (!fixture || fixture.played) return;
      const live = world.liveMatches.find((match) => match.fixtureId === fixtureId);
       const startedAt = context.ignoreDueTime ? now.getTime() : (fixture.kickoffAt ?? now.getTime());
       if (!live && !startLiveMatch(world, fixture, startedAt)) throw new Error("Match participants are unavailable");
       const completionAt = startedAt + MP_CONFIG.matchDurationMinutes * 60 * 1000;
       const home = world.clubs.find((club) => club.id === fixture.homeClubId);
       const away = world.clubs.find((club) => club.id === fixture.awayClubId);
       await scheduleEvent(prisma, {
        saveId,
        type: ScheduledEventType.MATCH_COMPLETE,
        timeBasis: "REAL_TIME",
        dueAt: new Date(completionAt),
        phase: "INTRADAY",
        entityType: "MATCH",
        entityId: String(fixtureId),
        payload: { fixtureId, completionAt },
        idempotencyKey: `MATCH_COMPLETE:${fixtureId}`,
      });
      // Inbox notification for both participants (best-effort, non-fatal)
        try { await notifyMatchStarted(prisma, world, fixtureId, context.ignoreDueTime ? now : undefined); } catch {}
       const started = world.liveMatches.find((match) => match.fixtureId === fixtureId);
       const participants = [home?.ownerUserId, away?.ownerUserId].filter((id): id is number => id !== null && id !== undefined);
       return {
         userEvents: started
           ? participants.map((userId) => ({ userId, event: { type: "liveMatchStarted" as const, matchId: started.matchId } }))
           : [],
       };
    }
    case ScheduledEventType.MATCH_COMPLETE: {
      const completionAt = Number(payload.completionAt ?? now.getTime());
      const fixtureId = Number(payload.fixtureId ?? entityId);
      const fixture = world.fixtures.find((candidate) => candidate.id === fixtureId);
      if (fixture && !fixture.played && !world.liveMatches.some((match) => match.fixtureId === fixtureId)) {
        startLiveMatch(world, fixture, context.ignoreDueTime ? now.getTime() : undefined);
      }
      // An administrator executing a completion event early means "complete
      // now", not "pretend the clock has reached the future due time".
      const advanceAt = context.ignoreDueTime ? now.getTime() : Math.max(now.getTime(), completionAt);
      // This is the downtime catch-up path (a MATCH_COMPLETE event executed at
      // or after its due time, not via an admin's early "resolve now") — it
      // must still run automation, so hydrate presets for just this fixture's
      // two clubs (plan §11 Part 4: never held in memory for every club).
      const liveNow = world.liveMatches.find((match) => match.fixtureId === fixtureId);
      const automationPresets = liveNow ? await loadPresetsForClubs(prisma, saveId, [liveNow.homeClubId, liveNow.awayClubId]) : undefined;
      const finished = advanceLiveMatches(world, advanceAt, { forceFinish: context.ignoreDueTime, automationPresets });
      if (finished.length > 0) {
        publishLiveMatchUpdates(world, finished.map((match) => ({ matchId: match.id, homeClubId: match.homeClubId, awayClubId: match.awayClubId, eventStart: 0, phaseChanged: true, finished: true })));
      }
      return { userEvents: await notifyFinishedMatches(prisma, world, finished, now) };
    }
    case ScheduledEventType.AUCTION_END: {
      if (payload.marketType === "FREE_AGENT") {
        const listing = world.freeAgentListings.find((candidate) => candidate.id === Number(payload.listingId ?? entityId));
        if (!listing || listing.status !== "ACTIVE") return;
        // Admin execution intentionally settles at the execution time. Using
        // the future deadline here makes an early execution look completed while
        // recording a transaction in the future.
        const settleAt = now.getTime();
        const result = processDueFreeAgentListing(world, listing, settleAt, { forceClose: context.ignoreDueTime });
        if (result.kind === "FAILED") {
          // Terminal failures (missing reservation, roster cap breach) can
          // never succeed on retry: fail closed instead of exhausting attempts.
          if (result.terminal) {
            releaseAllReservations(world, listing.id, "FREE_AGENT");
            listing.status = "CANCELLED";
            listing.completedAt = settleAt;
          return {
            userEvents: [
              ...invalidateHumanUsers(world, "transfers"),
              ...marketUpdatedEvents(world, "FREE_AGENT", listing.id, "CANCELLED"),
            ],
          };
          }
          throw new Error(result.error);
        }
        if (result.kind === "RELISTED") {
          const relisted = world.freeAgentListings.find((candidate) => candidate.id === result.newListingId);
          if (relisted) {
            await scheduleEvent(prisma, {
              saveId,
              type: ScheduledEventType.AUCTION_END,
              timeBasis: "REAL_TIME",
              dueAt: new Date(relisted.deadline),
              phase: "INTRADAY",
              entityType: "FREE_AGENT",
              entityId: String(relisted.id),
              payload: { listingId: relisted.id, marketType: "FREE_AGENT" },
              idempotencyKey: `AUCTION_END:FREE_AGENT:${relisted.id}:${relisted.deadline}`,
            });
          }
        } else if (result.kind === "DELETED") {
          await prisma.scheduledEvent.updateMany({
            where: {
              saveId,
              type: ScheduledEventType.AUCTION_END,
              entityType: "FREE_AGENT",
              entityId: { in: result.listingIds.map(String) },
              status: { in: ["PENDING", "FAILED"] },
            },
            data: { status: "CANCELLED", version: { increment: 1 } },
          });
        }
        const marketEvents = result.kind === "DELETED"
          ? result.listingIds.flatMap((listingId) => marketUpdatedEvents(world, "FREE_AGENT", listingId, "CANCELLED"))
          : [
              ...marketUpdatedEvents(world, "FREE_AGENT", result.listingId),
              ...(result.kind === "RELISTED" ? marketUpdatedEvents(world, "FREE_AGENT", result.newListingId) : []),
            ];
        return { userEvents: [...invalidateHumanUsers(world, "transfers"), ...marketEvents] };
      }
      const listing = world.transferAuctions.find((candidate) => candidate.id === Number(payload.auctionId ?? entityId));
      if (!listing || listing.status !== "ACTIVE") return;
      if (payload.deadlineVersion !== undefined && Number(payload.deadlineVersion) !== (listing.deadlineVersion ?? 0)) return;
      // Admin execution intentionally settles at the execution time; the
      // deadline is only a gate for automatic processing.
      const settleAt = now.getTime();
      const result = settleTransferAuction(world, listing, settleAt, { forceClose: context.ignoreDueTime });
      if (!result.ok) {
        // Terminal failures (missing reservation, roster cap breach) can never
        // succeed on retry: fail closed instead of exhausting attempts.
        if (result.terminal) {
          cancelUnsettleableAuction(world, listing, settleAt, result.error);
          return {
            userEvents: [
              ...invalidateHumanUsers(world, "transfers"),
              ...marketUpdatedEvents(world, "TRANSFER", listing.id, "CANCELLED"),
            ],
          };
        }
        throw new Error(result.error);
      }
      return {
        userEvents: [
          ...invalidateHumanUsers(world, "transfers"),
          ...marketUpdatedEvents(world, "TRANSFER", listing.id),
        ],
      };
    }
    case ScheduledEventType.LOAN_END: {
      const loan = world.loans.find((candidate) => candidate.id === Number(payload.loanId ?? entityId));
      if (!loan || loan.recalled) return;
      const dueAbsolute = world.mp.loanEndAbsoluteGameDays?.[String(loan.id)] ?? loan.endDay;
      if (!context.ignoreDueTime && dueAbsolute > (world.mp.absoluteGameDay ?? world.dayIndex)) throw new Error("Loan is not due");
      endLoan(world, loan);
      return { userEvents: invalidateHumanUsers(world, "transfers") };
    }
    case ScheduledEventType.CONTRACT_WARNING: {
      const player = world.players.find((candidate) => candidate.id === Number(payload.playerId ?? entityId));
      const dueAbsolute = Number(payload.dueAbsoluteGameDay);
      const scheduledContractDays = Number(payload.contractDaysAtScheduling);
      const warningDays = gameConfig.seasonDays * gameConfig.contractWarningSeasons;
      const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
      if (!Number.isFinite(dueAbsolute) || !Number.isFinite(scheduledContractDays) || dueAbsolute > currentAbsolute || player?.clubId === null || player?.contractDays !== scheduledContractDays || player.contractDays <= 0 || player.contractDays > warningDays) return;
      processContractWarning(world, Number(payload.playerId ?? entityId));
      return;
    }
    case ScheduledEventType.CONTRACT_EXPIRE: {
      const player = world.players.find((candidate) => candidate.id === Number(payload.playerId ?? entityId));
      const dueAbsolute = Number(payload.dueAbsoluteGameDay);
      const scheduledContractDays = Number(payload.contractDaysAtScheduling);
      const currentAbsolute = world.mp.absoluteGameDay ?? world.dayIndex;
      if (!Number.isFinite(dueAbsolute) || !Number.isFinite(scheduledContractDays) || dueAbsolute > currentAbsolute || player?.clubId === null || player?.contractDays !== scheduledContractDays || player.contractDays > gameConfig.seasonDays) return;
      processContractExpiry(world, Number(payload.playerId ?? entityId));
      return;
    }
    // Legacy event types whose mechanics were removed. Handled as no-ops so
    // rows persisted before the removal complete instead of erroring forever.
    case "STADIUM_UPGRADE_COMPLETE":
    case "END_GAME_DAY":
      return;
    case ScheduledEventType.GAME_DAY_ADVANCE: {
      const { advanceGameDayInLock } = await import("./gameClockService");
      await advanceGameDayInLock(prisma, { source: context.source, adminUserId: context.adminUserId, reason: context.reason, force: context.ignoreDueTime, leaseHeld: true });
      return;
    }
    case ScheduledEventType.BEGIN_GAME_DAY:
      processGameDayStart(world, world.mp.seasonDayIndex ?? world.dayIndex, now.getTime());
      return;
    case ScheduledEventType.PAYROLL_RUN:
      processGameDayPayroll(world, world.mp.seasonDayIndex ?? world.dayIndex, now.getTime());
      return;
    case ScheduledEventType.WEEKLY_SIM_UPDATE:
      processGameDayWeekly(world, world.mp.seasonDayIndex ?? world.dayIndex);
      return;
    case ScheduledEventType.AI_TRANSFER_TICK:
      // Legacy event type: AI clubs are ephemeral season fillers with no
      // market participation (invariant #28). Handled as a no-op so rows
      // persisted before the removal complete instead of erroring forever.
      return;
    case ScheduledEventType.DIVISION_HISTORY_SIMULATE: {
      // One round of a division's history backfill (plan Item 2), kept off
      // the synchronous join/return path precisely so it never holds the
      // global lock for the whole backfill in one go -- see the comment on
      // placeNewClub's call site and divisionHistoryChunkInput's doc comment.
      const divisionId = Number(payload.divisionId ?? entityId);
      const round = Number(payload.round);
      const finalRound = Number(payload.finalRound);
      const division = world.competitions.find((candidate) => candidate.id === divisionId);
      // Division gone (e.g. archived by a season rollover that ran before
      // this chunk did) or a malformed payload: nothing left to do.
      if (!division || !Number.isFinite(round) || !Number.isFinite(finalRound)) return;
      // Backfilling history for rounds already completed elsewhere in the
      // season -- these fixtures' nominal real-time kickoffs (generated
      // relative to the season's start) are not "the future" in any sense
      // that should block instant simulation. See simulateDivisionThroughRound's
      // bypassKickoffGate doc comment.
      simulateDivisionThroughRound(world, division, round, now.getTime(), { bypassKickoffGate: true });
      if (round < finalRound) {
        // More rounds remain: simulateDivisionThroughRound's own bookkeeping
        // just flipped status back to ACTIVE (it always does once it stops
        // finding due, unplayed fixtures at THIS round) -- undo that here,
        // since the backfill as a whole is not done, and the normal
        // live-match scheduler must keep treating this division's fixtures
        // as backfill-owned until the LAST chunk completes.
        division.status = "SIMULATING_HISTORY";
        await scheduleEvent(prisma, divisionHistoryChunkInput(saveId, divisionId, round + 1, finalRound));
      }
      return { userEvents: invalidateHumanUsers(world, "mp") };
    }
    case ScheduledEventType.INTERSEASON_START:
    case ScheduledEventType.PROMOTION_RELEGATION:
    case ScheduledEventType.DIVISION_RESTRUCTURE:
    case ScheduledEventType.WAITING_POOL_ASSIGNMENT:
    case ScheduledEventType.NEXT_SEASON_BUDGET_ALLOCATION:
    case ScheduledEventType.SEASONAL_ACADEMY_INTAKE:
    case ScheduledEventType.NEXT_SEASON_FIXTURE_GENERATION:
    case ScheduledEventType.NEXT_SEASON_STRUCTURE_VALIDATE:
    case ScheduledEventType.NEXT_SEASON_PREPARATION_OPEN:
    case ScheduledEventType.SEASON_RESULTS_FINALIZE:
      case ScheduledEventType.CONTRACT_END_PROCESSING:
      case ScheduledEventType.SEASON_ROLLOVER_COMMIT:
        await executeRolloverStep(prisma, world, type as RolloverWorkflowStep, { calendarBoundary: context.calendarBoundary, now: now.getTime() });
        return { userEvents: invalidateHumanUsers(world, "mp") };
    case ScheduledEventType.SEASON_ROLLOVER:
      await runRolloverCoordinatorInLock(prisma, {
        source: context.source,
        ignoreDueTime: context.ignoreDueTime,
        adminUserId: context.adminUserId,
         reason: context.reason,
         leaseHeld: true,
         calendarBoundary: context.calendarBoundary,
        now,
      });
      return { persistWorld: false, userEvents: invalidateHumanUsers(world, "mp") };
    default:
      void saveId;
      throw new Error(`No scheduled event handler for ${type}`);
  }
}

/** Run every unfinished rollover step in its fixed dependency order. */
export async function runRolloverCoordinatorInLock(prisma: PrismaClient, options: RolloverCoordinatorOptions = {}) {
  const now = options.now ?? new Date();
  const run = async () => {
    let loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("Global world unavailable");
    const saveId = loaded.save.id;
    const sourceSeasonId = loaded.world.mp.seasonId;
    await materializeSeasonEvents(prisma, saveId, loaded.world);

    for (const step of ROLLOVER_WORKFLOW_STEPS) {
      const event = await prisma.scheduledEvent.findUnique({ where: { idempotencyKey: rolloverEventKey(step, sourceSeasonId) } });
      if (!event) throw new Error(`Missing rollover event ${step}:${sourceSeasonId}`);
      await executeScheduledEventInLock(prisma, event.id, {
        source: options.source,
        ignoreDueTime: options.ignoreDueTime,
        adminUserId: options.adminUserId,
        reason: options.reason,
        calendarBoundary: options.calendarBoundary,
        leaseHeld: true,
        now,
      });
    }

    loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded) throw new Error("World unavailable after rollover");
    const season = await prisma.mpSeason.findUnique({ where: { id: loaded.world.mp.seasonId } });
    if (!season) throw new Error("Rollover completed without a season row");
    return { seasonId: season.id, year: season.year, month: season.month };
  };
  if (options.leaseHeld) return run();
  return withGlobalLease(prisma, run, now);
}

export async function executeDueEventsInLock(prisma: PrismaClient, saveId: number, now = new Date(), options: { excludeTypes?: ReadonlySet<string> } = {}): Promise<number> {
    let loaded = await loadGlobalWorldMutable(prisma);
    if (!loaded || loaded.save.id !== saveId) return 0;
    await recoverStaleRunningEvents(prisma, saveId, now);
    const events = await prisma.scheduledEvent.findMany({
      where: { saveId, status: { in: ["PENDING", "FAILED"] }, timeBasis: "REAL_TIME", dueAt: { lte: now }, ...(options.excludeTypes && options.excludeTypes.size > 0 ? { type: { notIn: [...options.excludeTypes] } } : {}) },
      orderBy: [{ priority: "asc" }, { dueAt: "asc" }, { dueAbsoluteGameDay: "asc" }],
    });
    let completed = 0;
    for (const event of events) {
      if (!loaded) break;
      try {
        const reusableWorld = event.type === ScheduledEventType.GAME_DAY_ADVANCE || event.type === ScheduledEventType.SEASON_ROLLOVER ? undefined : loaded;
        const result = await executeScheduledEventInLock(prisma, event.id, { now, leaseHeld: true }, reusableWorld);
        if (result.status === "COMPLETED") completed++;
        if (!reusableWorld) {
          loaded = await loadGlobalWorldMutable(prisma);
          if (!loaded) break;
        }
      } catch {
        // Failed events remain visible for retry and admin diagnosis. Reload so
        // a domain handler that failed after mutating its working copy cannot
        // contaminate the next event in this batch.
        loaded = await loadGlobalWorldMutable(prisma);
        if (!loaded) break;
      }
    }
    return completed;
}

export async function executeDueEvents(prisma: PrismaClient, saveId: number, now = new Date(), options: { excludeTypes?: ReadonlySet<string> } = {}): Promise<number> {
  return withGlobalLock(() => withGlobalLease(prisma, () => executeDueEventsInLock(prisma, saveId, now, options), now));
}

export async function cancelScheduledEvent(prisma: PrismaClient, eventId: string) {
  return withGlobalLock(async () => {
    return withGlobalLease(prisma, () => prisma.scheduledEvent.updateMany({ where: { id: eventId, status: "PENDING" }, data: { status: "CANCELLED", version: { increment: 1 } } }));
  });
}

export async function retryScheduledEvent(prisma: PrismaClient, eventId: string) {
  return withGlobalLock(async () => {
    return withGlobalLease(prisma, () => prisma.scheduledEvent.updateMany({ where: { id: eventId, status: "FAILED" }, data: { status: "PENDING", attempts: 0, lastError: null, version: { increment: 1 } } }));
  });
}
