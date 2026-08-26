import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutable, loadGlobalWorldReadOnly, persistWorld, StaleWorldError, invalidateWorldCache, ensureGlobalSave } from "../services/saveService";
import { withGlobalLease, withGlobalLock } from "../services/lock";
import { simulateThroughRound, divisionsInSeason, isFillerAI, preferredTimeDistance, tierOf, groupIndexOf, suggestedModerationClubName, generateDivisionFixtures } from "../game/multiplayer";
import { ensureCurrentSeason, configuredInactivityThresholds, configuredMatchTiming, setLeagueSettings } from "../services/mpService";
import { ROUNDS_PER_SEASON } from "../game/multiplayer";
import { readNumberSetting } from "../services/settingsStore";
import { getCommitmentTotals } from "../game/finance";
import { divisionAnalytics } from "../game/adminAnalytics";
import { gameConfig } from "../config";
import { advanceGameDay, ensureGameClock } from "../services/gameClockService";
import { cancelScheduledEvent, executeScheduledEvent, materializeSeasonEvents, retryScheduledEvent, runRolloverCoordinatorInLock, scheduleEvent, ScheduledEventType } from "../services/scheduler";
import {
  isPaused,
  isWorldPausedGlobally,
  pausedInstant,
  pauseSeason,
  resumeSeason,
  WORLD_PAUSED_MESSAGE,
  WORLD_PAUSED_STATUS,
} from "../services/seasonPause";
import { calendarValues, seasonSchedulePreview } from "../services/seasonCalendar";
import { publishUserWorldEvent, publishWorldEventToUsers, publishWorldReset, type UserWorldEvent } from "../services/worldEvents";
import { EVENT_CODES, MOTD_NEWS_KIND } from "../game/constants";
import { multiplayerDayLabel } from "../game/calendar";
import { displayElo } from "../game/elo";
import type { World } from "../game/types";

const advanceSchema = z.object({
  // Target round to simulate through (1..14). Rounds already played are
  // skipped; all divisions are simulated instantly up to this round.
  round: z.number().int().min(1).max(ROUNDS_PER_SEASON),
});

const CANCELLABLE_SCHEDULER_EVENTS = new Set([
  ScheduledEventType.AUCTION_END,
  ScheduledEventType.MATCH_START,
  ScheduledEventType.MATCH_COMPLETE,
]);

/**
 * Admin-only endpoints to control the global clock manually for testing.
 * A user must have User.isAdmin = true.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user?.isAdmin) {
      return reply.code(403).send({ error: "Admins only" });
    }
  });

  // Gate for schedule-dependent admin controls while the season is paused.
  const requireRunningWorld = async (reply: import("fastify").FastifyReply): Promise<boolean> => {
    if (!(await isWorldPausedGlobally(app.prisma))) return true;
    await reply.code(WORLD_PAUSED_STATUS).send({ error: WORLD_PAUSED_MESSAGE });
    return false;
  };

  // Simulate every division instantly through the requested round.
  app.post("/admin/advance-round", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = advanceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const now = Date.now();
      const target = parsed.data.round;
      const from = world.mp.completedRounds;
      simulateThroughRound(world, target, now);
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return {
        value: {
          ok: true,
          from,
          to: world.mp.completedRounds,
          joinState: world.mp.joinState,
          joinLockRound: world.mp.joinLockRound,
        },
      };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // Set the manual override to a round without simulating (worker simulates
  // on its next tick). Useful for testing join-lock timing.
  app.post("/admin/set-round", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = advanceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      world.mp.manualRound = parsed.data.round;
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return { value: { ok: true, manualRound: world.mp.manualRound } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // Clear the manual override and return to the real schedule.
  app.post("/admin/clear-manual", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      world.mp.manualRound = null;
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return { value: { ok: true } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.get("/admin/status", async (req) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { world: null };
    const world = loaded.world;
    return {
      world: {
        seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
        seasonStatus: world.mp.seasonStatus,
        completedRounds: world.mp.completedRounds,
        joinState: world.mp.joinState,
        joinLockRound: world.mp.joinLockRound,
        manualRound: world.mp.manualRound,
        realCompletedRounds: world.mp.completedRounds,
        roundsPerSeason: gameConfig.roundsPerSeason,
        divisionCount: divisionsInSeason(world, world.mp.seasonId).length,
        clubCount: world.clubs.length,
        humanClubCount: world.clubs.filter((c) => c.ownerUserId !== null).length,
        liveMatchCount: world.liveMatches.length,
      },
    };
  });

  // The season budget economy is configuration only (game.config.jsonc):
  // firstDivisionSeasonBudget, minimumTierBudgetRatio and tierBudgetDecayRate
  // anchor both seasonal allocations and every player market value, so they
  // deliberately have no runtime override.

  app.get("/admin/league-settings", async () => ({
    settings: {
      joinThresholdPercent: await readNumberSetting(app.prisma, "JOIN_THRESHOLD_PERCENT", gameConfig.joinThresholdPercent),
      inactivityThresholds: await configuredInactivityThresholds(app.prisma),
      matchTiming: await configuredMatchTiming(app.prisma),
    },
  }));

  const leagueSettingsSchema = z.object({
    joinThresholdPercent: z.number().min(0).max(1).optional(),
    tier1InactivityDays: z.number().int().min(1).optional(),
    tier2InactivityDays: z.number().int().min(1).optional(),
    defaultInactivityDays: z.number().int().min(1).optional(),
    matchTimeMode: z.enum(["GLOBAL_FIXED_KICKOFF", "DIVISION_LOCAL_KICKOFF"]).optional(),
    matchKickoffHourUtc: z.number().int().min(0).max(23).optional(),
  });
  app.put("/admin/league-settings", async (req, reply) => {
    const parsed = leagueSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withGlobalLock(async () => {
      const settings = await setLeagueSettings(app.prisma, parsed.data);
      const matchTiming = await configuredMatchTiming(app.prisma);
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (loaded) {
        loaded.world.mp.inactivityThresholds = settings.inactivityThresholds;
        loaded.world.mp.matchTimeMode = matchTiming.mode;
        loaded.world.mp.matchKickoffHour = matchTiming.kickoffHour;
        if (parsed.data.joinThresholdPercent !== undefined) {
          loaded.world.mp.joinThresholdPercent = settings.joinThresholdPercent;
          loaded.world.mp.joinLockRound = Math.floor(ROUNDS_PER_SEASON * settings.joinThresholdPercent);
          await app.prisma.mpSeason.updateMany({ where: { id: loaded.world.mp.seasonId }, data: { joinLockRound: loaded.world.mp.joinLockRound, joinThresholdPercent: settings.joinThresholdPercent } });
        }
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      }
      return { settings: { ...settings, matchTiming } };
    });
  });

  // Operational metrics (plan §89).
  app.get("/admin/monitoring", async (req) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { metrics: null };
    const world = loaded.world;
    const divisions = divisionsInSeason(world, world.mp.seasonId).filter((d) => d.status !== "ARCHIVED");
    const fillerCount = world.clubs.filter((club) => isFillerAI(world, club.id)).length;
    const activeDivisionsByTier = new Map<number, number>();
    const sizes: number[] = [];
    let avgHumansPerDivision = 0;
    const availabilityOverlaps: { divisionId: number; averageOverlapHours: number; averagePairCost: number }[] = [];
    if (divisions.length > 0) {
      let totalHumans = 0;
      for (const d of divisions) {
        const members = Object.keys(d.standings).length;
        sizes.push(members);
        activeDivisionsByTier.set(d.tier ?? 1, (activeDivisionsByTier.get(d.tier ?? 1) ?? 0) + 1);
        totalHumans += Object.values(d.standings).filter((r) => world.clubs.find((c) => c.id === r.clubId)?.ownerUserId != null).length;
        // Window-overlap telemetry (plan 9): mean pairwise shared preferred
        // hours between constrained humans, plus the raw grouping cost.
        const prefs = Object.values(d.standings)
          .map((r) => world.clubs.find((c) => c.id === r.clubId)?.preferredHours)
          .filter((hours): hours is number[] => !!hours && hours.length > 0);
        let overlapSum = 0;
        let costSum = 0;
        let pairCount = 0;
        for (let i = 0; i < prefs.length; i++) {
          for (let j = i + 1; j < prefs.length; j++) {
            overlapSum += prefs[i].filter((slot) => prefs[j].includes(slot)).length / 2;
            costSum += preferredTimeDistance(prefs[i], prefs[j]);
            pairCount++;
          }
        }
        availabilityOverlaps.push({
          divisionId: d.id,
          averageOverlapHours: pairCount > 0 ? Number((overlapSum / pairCount).toFixed(2)) : 0,
          averagePairCost: pairCount > 0 ? Number((costSum / pairCount).toFixed(2)) : 0,
        });
      }
      avgHumansPerDivision = totalHumans / divisions.length;
    }
    const currentSeasonInterventions = world.financialInterventions.filter((event) => event.seasonId === world.mp.seasonId);
    const systemLiquidationMoneyCreated = currentSeasonInterventions.reduce((sum, event) => sum + event.systemLiquidationRevenue, 0);
    const forcedAuctionSettlements = currentSeasonInterventions.reduce(
      (sum, event) => sum + event.entries.filter((entry) => entry.kind === "FORCED_AUCTION").length,
      0,
    );
    const playersLiquidated = currentSeasonInterventions.reduce(
      (sum, event) => sum + event.entries.filter((entry) => entry.kind === "SYSTEM_LIQUIDATION").length,
      0,
    );
    const unableToRecover = currentSeasonInterventions.filter((event) => event.unableToFullyRecover).length;
    const repeatInterventionClubs = new Set(
      currentSeasonInterventions
        .map((event) => event.clubId)
        .filter((clubId, index, ids) => ids.indexOf(clubId) !== index),
    ).size;
    return {
      metrics: {
        activeHumans: world.clubs.filter((c) => c.ownerUserId !== null && c.competitionState === "ACTIVE").length,
        provisionalHumans: world.clubs.filter((c) => c.ownerUserId !== null && c.competitionState === "PROVISIONAL").length,
        dormantClubs: world.clubs.filter((c) => c.ownerUserId !== null && c.competitionState === "DORMANT").length,
        aiFillerCount: fillerCount,
        activeDivisions: divisions.length,
        activeDivisionsByTier: Object.fromEntries(activeDivisionsByTier),
        averageHumansPerDivision: Number(avgHumansPerDivision.toFixed(2)),
        divisionSizes: sizes,
        transferAuctionCount: world.transferAuctions.filter((a) => a.status === "ACTIVE").length,
        clubsWithNegativeCushion: world.clubs.filter((club) => club.competitionState === "ACTIVE" && getCommitmentTotals(world, club).financialCushion < 0).length,
        clubsWithNegativeCash: world.clubs.filter((club) => club.competitionState === "ACTIVE" && club.cash < 0).length,
        financialInterventions: currentSeasonInterventions.length,
        playersLiquidated,
        averageInterventionSurplus: currentSeasonInterventions.length === 0
          ? 0
          : Number(currentSeasonInterventions.reduce((sum, event) => sum + Math.max(0, event.cushionAfter), 0) / currentSeasonInterventions.length),
        forcedAuctionSettlements,
        systemLiquidationMoneyCreated,
        clubsUnableToFullyRecover: unableToRecover,
        repeatInterventionClubs,
        liveMatchCount: world.liveMatches.length,
        joinState: world.mp.joinState,
        seasonStatus: world.mp.seasonStatus,
        availabilityOverlapByDivision: availabilityOverlaps,
        alerts: [
          ...sizes.filter((size) => size !== 8).map((size, i) => `division ${i + 1} has ${size} clubs (expected 8)`),
          ...(world.transferAuctions.some((a) => a.status === "ACTIVE" && a.deadline < Date.now()) ? ["transfer listing overdue"] : []),
          ...(world.fixtures.some((fixture) => !fixture.played && fixture.kickoffAt !== undefined && fixture.kickoffAt < Date.now() - 15 * 60 * 1000) ? ["match overdue"] : []),
          ...(world.mp.rolloverPhase !== null ? ["season rollover incomplete"] : []),
        ],
      },
    };
  });

  app.get("/admin/audit", async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100) || 100));
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { events: [] };
    return { events: loaded.world.mpAudits.slice(-limit).reverse() };
  });

  // Energy/injury balance telemetry (plan 9 §32). Diagnostic only — never fed
  // back into the model. Reports what is derivable from persisted state; the
  // kickoff/full-time Energy split and setback frequency would need dedicated
  // event bookkeeping and are intentionally omitted until required.
  app.get("/admin/energy-telemetry", async (req) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { telemetry: null };
    const world = loaded.world;
    const squad = world.players.filter((p) => p.clubId !== null);
    const energies = squad.map((p) => p.energy).sort((a, b) => a - b);
    const loads = squad.map((p) => p.recentLoad ?? 0);
    const percentile = (sorted: number[], q: number): number =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);
    const currentSeasonMatchIds = new Set(
      world.fixtures.filter((f) => f.played && world.competitions.some((c) => c.id === f.competitionId && c.seasonId === world.mp.seasonId)).map((f) => {
        const match = world.matches.find((m) => m.fixtureId === f.id);
        return match?.id ?? -f.id;
      }),
    );
    const seasonMatches = world.matches.filter((m) => currentSeasonMatchIds.has(m.id));
    const matchInjuries = seasonMatches.reduce((sum, m) => sum + m.events.filter((e) => e.type === EVENT_CODES.INJURY).length, 0);
    // Training injuries surface as news items; approximate the season count
    // from the injury-news ledger (no dedicated audit row exists yet).
    const trainingInjuries = world.news.filter((n) => n.kind === "injury" && n.dayIndex <= world.dayIndex).length;
    const injuredDays = squad
      .filter((p) => (p.injuryUntilAbsoluteGameDay ?? null) !== null)
      .map((p) => p.injuryInitialGameDays ?? 0)
      .sort((a, b) => a - b);
    return {
      telemetry: {
        players: squad.length,
        energy: {
          mean: Number(mean(energies).toFixed(2)),
          p10: percentile(energies, 0.1),
          p25: percentile(energies, 0.25),
          p50: percentile(energies, 0.5),
          p75: percentile(energies, 0.75),
          p90: percentile(energies, 0.9),
          shareBelow75: squad.length === 0 ? 0 : Number((squad.filter((p) => p.energy < 75).length / squad.length).toFixed(4)),
        },
        recentLoad: {
          mean: Number(mean(loads).toFixed(3)),
          shareAbove15: squad.length === 0 ? 0 : Number((loads.filter((l) => l >= 1.5).length / squad.length).toFixed(4)),
        },
        injuries: {
          matchInjuriesPerMatch: seasonMatches.length === 0 ? 0 : Number((matchInjuries / seasonMatches.length).toFixed(4)),
          trainingInjuriesThisSeason: trainingInjuries,
          activeByCause: {
            MATCH: squad.filter((p) => p.injuryCause === "MATCH").length,
            TRAINING: squad.filter((p) => p.injuryCause === "TRAINING").length,
          },
          initialGameDays: { p50: percentile(injuredDays, 0.5), p75: percentile(injuredDays, 0.75), p90: percentile(injuredDays, 0.9), p95: percentile(injuredDays, 0.95), p99: percentile(injuredDays, 0.99) },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Durable scheduler controls. Every endpoint remains behind the admin hook
  // above; the frontend is never the authorization boundary.
  // -------------------------------------------------------------------------

  // World analytics (read-only, no lock — mirrors /admin/status precedent):
  // real vs projected player quality, population counts, age pyramid,
  // position/wage drift and season-over-season flow, all per division plus
  // world summary. See game/adminAnalytics.ts for the formulas.
  app.get("/admin/analytics", async () => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { analytics: null };
    return { analytics: divisionAnalytics(loaded.world) };
  });

  app.get("/admin/scheduler/clock", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const clock = await ensureGameClock(app.prisma, loaded.save.id, loaded.world);
    const calendar = calendarValues();
    const now = new Date();
    const [pendingEvents, overdueEvents, failedEvents, oldest, review] = await Promise.all([
      app.prisma.scheduledEvent.count({ where: { saveId: loaded.save.id, status: "PENDING" } }),
      app.prisma.scheduledEvent.count({ where: { saveId: loaded.save.id, status: "PENDING", timeBasis: "REAL_TIME", dueAt: { lte: now } } }),
      app.prisma.scheduledEvent.count({ where: { saveId: loaded.save.id, status: "FAILED" } }),
      app.prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, status: "PENDING", timeBasis: "REAL_TIME", dueAt: { lte: now } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
      app.prisma.setting.findUnique({ where: { key: "SCHEDULER_REQUIRES_ADMIN_REVIEW" }, select: { value: true } }),
    ]);
    return {
      clock: {
        ...clock,
        seasonDay: clock.seasonDayIndex + 1,
        seasonDays: calendar.seasonDays,
        interseasonDays: calendar.interseasonDays,
        interseasonAfterMatchDays: calendar.interseasonAfterMatchDays,
        interseasonBeforeNextSeasonDays: calendar.interseasonBeforeNextSeasonDays,
        lastLeagueMatchDayIndex: calendar.lastLeagueMatchDayIndex,
        interseasonStartIndex: calendar.interseasonStartIndex,
        preparationStartIndex: calendar.preparationStartIndex,
        paused: isPaused(loaded.world),
        pausedAt: pausedInstant(loaded.world),
        nextAutomaticDayAdvance: await app.prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: ScheduledEventType.GAME_DAY_ADVANCE, status: "PENDING" }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }).then((event) => event?.dueAt ?? null),
        lastDayAdvance: clock.lastAdvancedAt,
        health: review?.value === "1" ? "SCHEDULER_REQUIRES_ADMIN_REVIEW" : failedEvents > 0 ? "FAILED_EVENTS" : overdueEvents > 0 ? "OVERDUE" : "HEALTHY",
        pendingEvents,
        overdueEvents,
        failedEvents,
        oldestOverdueSeconds: oldest?.dueAt ? Math.max(0, Math.floor((now.getTime() - oldest.dueAt.getTime()) / 1000)) : 0,
      },
    };
  });

  app.get("/admin/scheduler/events", async (req) => {
    const query = req.query as { status?: string; type?: string; timeBasis?: string; entityType?: string; entityId?: string; limit?: string };
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { events: [] };
    const limit = Math.max(1, Math.min(500, Number(query.limit ?? 200) || 200));
    const events = await app.prisma.scheduledEvent.findMany({
      where: {
        saveId: loaded.save.id,
        // Comma-separated status lists let the UI request e.g.
        // "PENDING,RUNNING,FAILED" in one query; single values still work.
        ...(query.status ? { status: { in: query.status.split(",").map((s) => s.trim()).filter(Boolean) } } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.timeBasis ? { timeBasis: query.timeBasis } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
      },
      orderBy: [{ status: "asc" }, { dueAbsoluteGameDay: "asc" }, { dueAt: "asc" }, { priority: "asc" }],
      take: limit,
    });
    return { events };
  });

  app.get("/admin/scheduler/events/:id", async (req, reply) => {
    const event = await app.prisma.scheduledEvent.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!event) return reply.code(404).send({ error: "Event not found" });
    return { event };
  });

  app.post("/admin/scheduler/events/:id/execute", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const eventId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { reason?: string };
    const before = await app.prisma.scheduledEvent.findUnique({ where: { id: eventId } });
    if (!before) return reply.code(404).send({ error: "Event not found" });
    const event = await executeScheduledEvent(app.prisma, eventId, { source: "ADMIN", ignoreDueTime: true, adminUserId: req.user!.id, reason: body.reason });
    await writeSchedulerAudit(app.prisma, before.saveId, req.user!.id, "EXECUTE_EVENT", "SCHEDULED_EVENT", eventId, before, event, body.reason);
    return { event };
  });

  app.post("/admin/scheduler/events/:id/retry", async (req, reply) => {
    const eventId = (req.params as { id: string }).id;
    const before = await app.prisma.scheduledEvent.findUnique({ where: { id: eventId } });
    if (!before) return reply.code(404).send({ error: "Event not found" });
    const result = await retryScheduledEvent(app.prisma, eventId);
    if (result.count === 0) return reply.code(400).send({ error: "Only failed events can be retried" });
    const after = await app.prisma.scheduledEvent.findUniqueOrThrow({ where: { id: eventId } });
    await writeSchedulerAudit(app.prisma, before.saveId, req.user!.id, "RETRY_EVENT", "SCHEDULED_EVENT", eventId, before, after, (req.body as { reason?: string } | undefined)?.reason);
    return { event: after };
  });

  app.post("/admin/scheduler/events/:id/cancel", async (req, reply) => {
    const eventId = (req.params as { id: string }).id;
    const before = await app.prisma.scheduledEvent.findUnique({ where: { id: eventId } });
    if (!before) return reply.code(404).send({ error: "Event not found" });
    if (!CANCELLABLE_SCHEDULER_EVENTS.has(before.type as ScheduledEventType)) return reply.code(400).send({ error: "This event type cannot be cancelled" });
    const result = await cancelScheduledEvent(app.prisma, eventId);
    if (result.count === 0) return reply.code(400).send({ error: "Only pending events can be cancelled" });
    const after = await app.prisma.scheduledEvent.findUniqueOrThrow({ where: { id: eventId } });
    await writeSchedulerAudit(app.prisma, before.saveId, req.user!.id, "CANCEL_EVENT", "SCHEDULED_EVENT", eventId, before, after, (req.body as { reason?: string } | undefined)?.reason);
    return { event: after };
  });

  const dayAdvanceSchema = z.object({ reason: z.string().optional() });
  app.post("/admin/scheduler/day/advance", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = dayAdvanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return { clock: await advanceGameDay(app.prisma, { source: "ADMIN", adminUserId: req.user!.id, reason: parsed.data.reason }) };
  });

  app.post("/admin/scheduler/day/advance-many", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = z.object({ days: z.number().int().min(1).max(35), reason: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "days must be between 1 and 35" });
    const clocks = [];
    for (let i = 0; i < parsed.data.days; i++) clocks.push(await advanceGameDay(app.prisma, { source: "ADMIN", adminUserId: req.user!.id, reason: parsed.data.reason }));
    return { clocks, clock: clocks.at(-1) };
  });

  app.post("/admin/scheduler/day/force-advance", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = z.object({ confirmation: z.literal("FORCE"), reason: z.string().min(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Typed confirmation FORCE and a reason of at least 10 characters are required" });
    return { clock: await advanceGameDay(app.prisma, { source: "ADMIN", adminUserId: req.user!.id, force: true, reason: parsed.data.reason }) };
  });

  app.post("/admin/scheduler/scan", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return { executed: 0 };
    const { executeDueEvents } = await import("../services/scheduler");
    return { executed: await executeDueEvents(app.prisma, loaded.save.id) };
  });

  app.post("/admin/scheduler/rollover", async (req, reply) => {
    if (!(await requireRunningWorld(reply))) return;
    const parsed = z.object({ reason: z.string().min(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "A reason of at least 10 characters is required" });
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const before = { seasonId: loaded.world.mp.seasonId, seasonNumber: loaded.world.mp.seasonNumber, phase: loaded.world.mp.phase };
    const season = await withGlobalLock(() => runRolloverCoordinatorInLock(app.prisma, {
      source: "ADMIN",
      ignoreDueTime: true,
      adminUserId: req.user!.id,
      reason: parsed.data.reason,
      calendarBoundary: true,
    }));
    const after = await loadGlobalWorldMutable(app.prisma);
    await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "SEASON_ROLLOVER_OVERRIDE", "SEASON", String(season.seasonId), before, after?.world.mp ?? season, parsed.data.reason);
    return { season };
  });

  // -------------------------------------------------------------------------
  // Season pause / resume ("freeze timers"). While paused, workers, automatic
  // day advancement and schedule-dependent mutations are gated; resume shifts
  // every real-time anchor forward by the frozen interval (see seasonPause.ts).
  // -------------------------------------------------------------------------

  const pauseControlSchema = z.object({ reason: z.string().optional() });
  app.post("/admin/scheduler/pause", async (req, reply) => {
    const parsed = pauseControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await pauseSeason(app.prisma, { adminUserId: req.user!.id, reason: parsed.data.reason });
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (loaded) publishToHumanUsers(loaded.world, { type: "invalidate", scope: "mp" });
    return res;
  });

  app.post("/admin/scheduler/resume", async (req, reply) => {
    const parsed = pauseControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      const res = await resumeSeason(app.prisma, { adminUserId: req.user!.id, reason: parsed.data.reason });
      const loaded = await loadGlobalWorldReadOnly(app.prisma);
      if (loaded) publishToHumanUsers(loaded.world, { type: "invalidate", scope: "mp" });
      return res;
    } catch (error) {
      if (error instanceof Error && error.message === "The season is not paused") return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Regenerate the current season's division schedules from the untouched
   * standings. Only legal while NO match of the season has taken place —
   * completed fixtures and matches are immutable (INVARIANTS).
   */
  app.post("/admin/scheduler/fixtures/recalculate", async (req, reply) => {
    const parsed = z.object({ reason: z.string().min(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "A reason of at least 10 characters is required" });
    const result = await withGlobalLock(() =>
      withGlobalLease(app.prisma, async () => {
        const loaded = await loadGlobalWorldMutable(app.prisma);
        if (!loaded) return { error: { code: 404, body: { error: "World unavailable" } } };
        const world = loaded.world;
        const seasonId = world.mp.seasonId;
        const divisions = world.competitions.filter(
          (competition) =>
            competition.kind === "division" &&
            competition.seasonId === seasonId &&
            competition.status !== "ARCHIVED" &&
            Object.keys(competition.standings).length > 0,
        );
        if (divisions.length === 0) return { error: { code: 400, body: { error: "No active divisions to recalculate" } } };
        const divisionIds = new Set(divisions.map((division) => division.id));
        const oldFixtures = world.fixtures.filter((fixture) => divisionIds.has(fixture.competitionId));
        if (oldFixtures.length === 0) return { error: { code: 400, body: { error: "The current season has no fixtures to recalculate" } } };

        // Immutability guard: any played fixture, recorded match, running live
        // match or in-flight match event forbids regeneration.
        const oldIds = new Set(oldFixtures.map((fixture) => fixture.id));
        if (oldFixtures.some((fixture) => fixture.played)) {
          return { error: { code: 409, body: { error: "A fixture of this season has already been played" } } };
        }
        if (world.matches.some((match) => oldIds.has(match.fixtureId))) {
          return { error: { code: 409, body: { error: "A match of this season has already been recorded" } } };
        }
        if (world.liveMatches.some((match) => oldIds.has(match.fixtureId))) {
          return { error: { code: 409, body: { error: "A match of this season is currently live" } } };
        }
        const staleMatchEvents = await app.prisma.scheduledEvent.findMany({
          where: {
            saveId: loaded.save.id,
            type: { in: [ScheduledEventType.MATCH_START, ScheduledEventType.MATCH_COMPLETE] },
            entityType: "MATCH",
            entityId: { in: [...oldIds].map(String) },
            status: { in: ["PENDING", "FAILED", "RUNNING"] },
          },
          select: { id: true, status: true },
        });
        if (staleMatchEvents.some((event) => event.status === "RUNNING")) {
          return { error: { code: 409, body: { error: "A match event of this season is currently executing" } } };
        }

        const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
        let generated = 0;
        for (const division of divisions) {
          world.fixtures = world.fixtures.filter((fixture) => fixture.competitionId !== division.id);
          // Deterministic calendar seeded from stable competition identity, so
          // a retry reproduces the same schedule (no hidden rerolls).
          const fixtures = generateDivisionFixtures(world, division, ref);
          world.fixtures.push(...fixtures);
          generated += fixtures.length;
        }

        await app.prisma.scheduledEvent.updateMany({
          where: { id: { in: staleMatchEvents.map((event) => event.id) }, status: { in: ["PENDING", "FAILED"] } },
          data: { status: "CANCELLED", version: { increment: 1 } },
        });
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        // Materialize MATCH_START events for the new kickoffs (idempotent keys).
        await materializeSeasonEvents(app.prisma, loaded.save.id, world);
        await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "RECALCULATE_FIXTURES", "SEASON", String(seasonId), { fixtures: oldFixtures.length }, { fixtures: generated }, parsed.data.reason);
        publishToHumanUsers(world, { type: "invalidate", scope: "mp" });
        return { value: { ok: true, divisions: divisions.length, fixturesBefore: oldFixtures.length, fixturesAfter: generated } };
      }),
    );
    if ("error" in result && result.error) return reply.code(result.error.code).send(result.error.body);
    return result.value;
  });

  /**
   * Destroy the entire multiplayer world and bootstrap a fresh one. User
   * accounts, sessions, friendships, invitations, moderation records, settings
   * and name pools are preserved; clubs, players, competitions, fixtures,
   * matches, market, histories, scheduler rows and notifications are wiped.
   * The delete + recreate sequence is retry-safe: if recreation fails, the
   * next call (or any ensure-current-season path) rebuilds from scratch.
   */
  app.post("/admin/world/reset", async (req, reply) => {
    const parsed = z.object({ confirmation: z.literal("RESET"), reason: z.string().min(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Typed confirmation RESET and a reason of at least 10 characters are required" });
    const previous = await loadGlobalWorldReadOnly(app.prisma);
    if (!previous) return reply.code(404).send({ error: "World unavailable" });
    const oldSaveId = previous.save.id;
    const result = await withGlobalLock(async () => {
      // Unscoped multiplayer tables are NOT covered by the Save cascade.
      // Notifications reference clubs/fixtures that are about to disappear, so
      // they are wiped too; device push subscriptions survive (they are not
      // world data).
      await app.prisma.$transaction(async (tx) => {
        await tx.mpMembership.deleteMany({});
        await tx.mpClubSeason.deleteMany({});
        await tx.mpQueue.deleteMany({});
        await tx.mpAllocation.deleteMany({});
        await tx.mpActivity.deleteMany({});
        await tx.mpAudit.deleteMany({});
        await tx.mpSeason.deleteMany({});
        await tx.userNotification.deleteMany({});
        await tx.save.delete({ where: { id: oldSaveId } });
      });
      invalidateWorldCache(app.prisma);
      await ensureGlobalSave(app.prisma);
      await ensureCurrentSeason(app.prisma);
      const fresh = await loadGlobalWorldMutable(app.prisma);
      if (!fresh) throw new Error("World reset failed: fresh world unavailable");
      await ensureGameClock(app.prisma, fresh.save.id, fresh.world);
      await materializeSeasonEvents(app.prisma, fresh.save.id, fresh.world);
      await writeSchedulerAudit(app.prisma, fresh.save.id, req.user!.id, "WORLD_RESET", "WORLD", "GLOBAL", { saveId: oldSaveId }, { saveId: fresh.save.id, seasonId: fresh.world.mp.seasonId }, parsed.data.reason);
      // Everyone keeps their account but loses their club; wake all clients.
      publishWorldReset();
      return { value: { ok: true, oldSaveId, newSaveId: fresh.save.id, seasonId: fresh.world.mp.seasonId } };
    });
    return result.value;
  });

  app.get("/admin/scheduler/matches", async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return { matches: [] };
    const currentCompetitionIds = new Set(loaded.world.competitions.filter((competition) => competition.seasonId === loaded.world.mp.seasonId && competition.kind === "division").map((competition) => competition.id));
    const dueFixtures = loaded.world.fixtures.filter((fixture) => currentCompetitionIds.has(fixture.competitionId));
    const events = await app.prisma.scheduledEvent.findMany({ where: { saveId: loaded.save.id, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: { in: dueFixtures.map((fixture) => String(fixture.id)) }, status: { not: "CANCELLED" } } });
    // First-wins per fixture, matching the row order findFirst would see.
    const eventByFixtureId = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.entityId !== null && !eventByFixtureId.has(event.entityId)) eventByFixtureId.set(event.entityId, event);
    }
    const matches = dueFixtures.map((fixture) => ({
      id: fixture.id,
      seasonId: loaded.world.mp.seasonId,
      round: fixture.round + 1,
      division: loaded.world.competitions.find((competition) => competition.id === fixture.competitionId)?.name ?? "",
      homeClub: loaded.world.clubs.find((club) => club.id === fixture.homeClubId)?.name ?? fixture.homeClubNameSnapshot ?? "Unknown",
      awayClub: loaded.world.clubs.find((club) => club.id === fixture.awayClubId)?.name ?? fixture.awayClubNameSnapshot ?? "Unknown",
      scheduledGameDay: (fixture.scheduledSeasonDayIndex ?? fixture.dayIndex) + 1,
      scheduledAt: fixture.kickoffAt ?? null,
      status: fixture.played ? "COMPLETED" : loaded.world.liveMatches.some((match) => match.fixtureId === fixture.id) ? "LIVE" : "SCHEDULED",
      event: eventByFixtureId.get(String(fixture.id)) ?? null,
    }));
    return { matches };
  });

  app.post("/admin/scheduler/matches/:id/start", async (req, reply) => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const fixtureId = (req.params as { id: string }).id;
    let event = await app.prisma.scheduledEvent.findFirst({ where: { saveId: loaded.save.id, type: ScheduledEventType.MATCH_START, entityType: "MATCH", entityId: fixtureId } });
    if (!event) {
      const fixture = loaded.world.fixtures.find((candidate) => candidate.id === Number(fixtureId));
      if (!fixture) return reply.code(404).send({ error: "Match not found" });
      event = await scheduleEvent(app.prisma, { saveId: loaded.save.id, type: ScheduledEventType.MATCH_START, timeBasis: "REAL_TIME", dueAt: new Date(), entityType: "MATCH", entityId: fixtureId, payload: { fixtureId: fixture.id }, idempotencyKey: `MATCH_START:${fixture.id}` });
    }
    const before = event;
    const after = await executeScheduledEvent(app.prisma, event.id, { source: "ADMIN", ignoreDueTime: true, adminUserId: req.user!.id, reason: (req.body as { reason?: string } | undefined)?.reason });
    await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "START_MATCH", "MATCH", fixtureId, before, after, (req.body as { reason?: string } | undefined)?.reason);
    return { event: after };
  });

  app.post("/admin/scheduler/matches/:id/resolve", async (req, reply) => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const fixtureId = (req.params as { id: string }).id;
    const fixture = loaded.world.fixtures.find((candidate) => candidate.id === Number(fixtureId));
    if (!fixture) return reply.code(404).send({ error: "Match not found" });
    const event = await scheduleEvent(app.prisma, {
      saveId: loaded.save.id,
      type: ScheduledEventType.MATCH_COMPLETE,
      timeBasis: "REAL_TIME",
      dueAt: new Date(),
      entityType: "MATCH",
      entityId: fixtureId,
      payload: { fixtureId: fixture.id, completionAt: Date.now() },
      idempotencyKey: `MATCH_COMPLETE:${fixture.id}`,
    });
    const after = await executeScheduledEvent(app.prisma, event.id, { source: "ADMIN", ignoreDueTime: true, adminUserId: req.user!.id, reason: (req.body as { reason?: string } | undefined)?.reason });
    await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "RESOLVE_MATCH", "MATCH", fixtureId, event, after, (req.body as { reason?: string } | undefined)?.reason);
    return { event: after };
  });

  app.get("/admin/scheduler/auctions", async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return { auctions: [] };
    const events = await app.prisma.scheduledEvent.findMany({ where: { saveId: loaded.save.id, type: ScheduledEventType.AUCTION_END, entityType: "AUCTION", entityId: { in: loaded.world.transferAuctions.map((auction) => String(auction.id)) }, status: { not: "CANCELLED" } } });
    // First-wins per auction, matching the row order findFirst would see.
    const eventByAuctionId = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.entityId !== null && !eventByAuctionId.has(event.entityId)) eventByAuctionId.set(event.entityId, event);
    }
    const auctions = loaded.world.transferAuctions.map((auction) => ({
      id: auction.id,
      player: loaded.world.players.find((player) => player.id === auction.playerId)?.name ?? "Unknown",
      seller: loaded.world.clubs.find((club) => club.id === auction.sellerClubId)?.name ?? "Unknown",
      displayedBid: auction.currentPrice,
      leadingMaxBid: loaded.world.marketBids.filter((bid) => bid.listingId === auction.id && bid.clubId === auction.leadingClubId).map((bid) => bid.maxBid)[0] ?? null,
      bidCount: loaded.world.marketBids.filter((bid) => bid.listingId === auction.id).length,
      createdAt: auction.createdAt,
      endsAt: auction.deadline,
      status: auction.status,
      event: eventByAuctionId.get(String(auction.id)) ?? null,
    }));
    return { auctions };
  });

  app.post("/admin/scheduler/auctions/:id/end", async (req, reply) => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const auctionId = (req.params as { id: string }).id;
    const auction = loaded.world.transferAuctions.find((candidate) => candidate.id === Number(auctionId));
    if (!auction) return reply.code(404).send({ error: "Auction not found" });
    const event = await scheduleEvent(app.prisma, { saveId: loaded.save.id, type: ScheduledEventType.AUCTION_END, timeBasis: "REAL_TIME", dueAt: new Date(auction.deadline), entityType: "AUCTION", entityId: auctionId, payload: { auctionId: auction.id, deadlineVersion: auction.deadlineVersion ?? 0 }, idempotencyKey: `AUCTION_END:${auction.id}:${auction.deadlineVersion ?? 0}` });
    const after = await executeScheduledEvent(app.prisma, event.id, { source: "ADMIN", ignoreDueTime: true, adminUserId: req.user!.id, reason: (req.body as { reason?: string } | undefined)?.reason });
    await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "END_AUCTION", "AUCTION", auctionId, event, after, (req.body as { reason?: string } | undefined)?.reason);
    return { event: after };
  });

  app.post("/admin/scheduler/auctions/:id/extend", async (req, reply) => {
    const parsed = z.object({ minutes: z.number().positive(), reason: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "minutes must be positive" });
    const result = await withGlobalLock(async () => {
      return withGlobalLease(app.prisma, async () => {
        const loaded = await loadGlobalWorldMutable(app.prisma);
        if (!loaded) return { error: { code: 404, body: { error: "World unavailable" } } };
        const auctionId = Number((req.params as { id: string }).id);
        const auction = loaded.world.transferAuctions.find((candidate) => candidate.id === auctionId);
        if (!auction || auction.status !== "ACTIVE") return { error: { code: 404, body: { error: "Active auction not found" } } };
        const before = { ...auction };
        const oldKey = `AUCTION_END:${auction.id}:${auction.deadlineVersion ?? 0}`;
        auction.deadline = Math.max(Date.now(), auction.deadline) + parsed.data.minutes * 60_000;
        auction.deadlineVersion = (auction.deadlineVersion ?? 0) + 1;
        await app.prisma.scheduledEvent.updateMany({ where: { saveId: loaded.save.id, idempotencyKey: oldKey, status: "PENDING" }, data: { status: "CANCELLED", version: { increment: 1 } } });
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
        const event = await scheduleEvent(app.prisma, { saveId: loaded.save.id, type: ScheduledEventType.AUCTION_END, timeBasis: "REAL_TIME", dueAt: new Date(auction.deadline), entityType: "AUCTION", entityId: String(auction.id), payload: { auctionId: auction.id, deadlineVersion: auction.deadlineVersion }, idempotencyKey: `AUCTION_END:${auction.id}:${auction.deadlineVersion}` });
        await writeSchedulerAudit(app.prisma, loaded.save.id, req.user!.id, "EXTEND_AUCTION", "AUCTION", String(auction.id), before, auction, parsed.data.reason);
        return { value: { auction, event } };
      });
    });
    if (result.error) return reply.code(result.error.code).send(result.error.body);
    return result.value;
  });

  app.get("/admin/scheduler/audit", async (req) => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) return { audit: [] };
    const limit = Math.max(1, Math.min(500, Number((req.query as { limit?: string }).limit ?? 100) || 100));
    return { audit: await app.prisma.adminSchedulerAudit.findMany({ where: { saveId: loaded.save.id }, orderBy: { createdAt: "desc" }, take: limit }) };
  });

  app.get("/admin/scheduler/season/:seasonId", async (req) => ({ seasonId: Number((req.params as { seasonId: string }).seasonId), season: seasonSchedulePreview() }));

  // --- User management (Pro grants + moderation) ---------------------------
  app.get("/admin/users", async (req, reply) => {
    const q = (req.query as { search?: string; limit?: string }).search?.trim() ?? "";
    const limit = Math.max(1, Math.min(100, Number((req.query as { limit?: string }).limit ?? 20) || 20));
    const where = q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    const eloByUserId = new Map(
      (loaded?.world.clubs ?? [])
        .filter((club) => club.ownerUserId !== null)
        .map((club) => [club.ownerUserId!, displayElo(club)]),
    );
    const users = await app.prisma.user.findMany({ where, orderBy: { id: "asc" }, take: limit, select: { id: true, name: true, email: true, isAdmin: true, isPro: true, bannedAt: true, banReason: true, createdAt: true } });
    return {
      users: users.map((u) => ({
        ...u,
        elo: eloByUserId.get(u.id) ?? null,
        bannedAt: u.bannedAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    };
  });

  app.post("/admin/users/:id/pro", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ isPro: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    await app.prisma.user.update({ where: { id }, data: { isPro: parsed.data.isPro } });
    publishUserWorldEvent(id, { type: "permissionsChanged" });
    return { ok: true };
  });

  app.post("/admin/users/:id/ban", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    if (user.isAdmin) return reply.code(400).send({ error: "Cannot ban an admin" });
    await app.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { bannedAt: new Date(), banReason: parsed.data.reason } });
      await tx.session.deleteMany({ where: { userId: id } });
    });
    return { ok: true };
  });

  app.post("/admin/users/:id/unban", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    await app.prisma.user.update({ where: { id }, data: { bannedAt: null, banReason: null } });
    return { ok: true };
  });

  app.post("/admin/users/:id/warn", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    const w = await app.prisma.warning.create({ data: { userId: id, reason: parsed.data.reason, issuedByAdminUserId: req.user!.id } });
    return { ok: true, warningId: w.id };
  });

  app.get("/admin/users/:id/warnings", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    const warnings = await app.prisma.warning.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 100 });
    return { warnings: warnings.map((w) => ({ id: w.id, reason: w.reason, issuedByAdminUserId: w.issuedByAdminUserId, createdAt: w.createdAt.toISOString(), acknowledgedAt: w.acknowledgedAt?.toISOString() ?? null })) };
  });

  // Moderation resets: club name/stadium, player nickname, logo takedown
  app.post("/admin/moderation/reset-club-name", async (req, reply) => {
    const parsed = z.object({ clubId: z.number().int().min(1), name: z.string().trim().max(60).optional(), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const reason = parsed.data.reason;
    // Empty/omitted name restores a deterministic generated default so the
    // "reset" semantics hold without the admin inventing a replacement.
    const newName = parsed.data.name && parsed.data.name.length > 0 ? parsed.data.name : suggestedModerationClubName(parsed.data.clubId);
    const res = await withGlobalLock(async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.id === parsed.data.clubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      const before = club.name;
      club.name = newName;
      club.shortName = newName;
      if (club.ownerUserId !== null) {
        await app.prisma.warning.create({ data: { userId: club.ownerUserId, reason: `Club name reset: ${reason}`, issuedByAdminUserId: req.user!.id } });
      }
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      return { value: { ok: true, before, after: club.name } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.post("/admin/moderation/reset-stadium-name", async (req, reply) => {
    const parsed = z.object({ clubId: z.number().int().min(1), stadiumName: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.id === parsed.data.clubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      club.stadiumName = parsed.data.stadiumName;
      if (club.ownerUserId !== null) {
        await app.prisma.warning.create({ data: { userId: club.ownerUserId, reason: `Stadium name reset: ${parsed.data.reason}`, issuedByAdminUserId: req.user!.id } });
      }
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      return { value: { ok: true } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.post("/admin/moderation/clear-nickname", async (req, reply) => {
    const parsed = z.object({ playerId: z.number().int().min(1), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const player = loaded.world.players.find((p) => p.id === parsed.data.playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      if (!player.nickname) return { value: { ok: true, cleared: false } };
      const club = player.clubId !== null ? loaded.world.clubs.find((c) => c.id === player.clubId) : null;
      player.nickname = null;
      if (club?.ownerUserId !== null && club?.ownerUserId !== undefined) {
        await app.prisma.warning.create({ data: { userId: club.ownerUserId!, reason: `Nickname cleared: ${parsed.data.reason}`, issuedByAdminUserId: req.user!.id } });
      }
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      return { value: { ok: true, cleared: true } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.post("/admin/moderation/remove-logo", async (req, reply) => {
    const parsed = z.object({ clubId: z.number().int().min(1), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.id === parsed.data.clubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      if (!club.customLogo) return { value: { ok: true, removed: false } };
      club.customLogo = null;
      if (club.ownerUserId !== null) {
        await app.prisma.warning.create({ data: { userId: club.ownerUserId, reason: `Custom logo removed: ${parsed.data.reason}`, issuedByAdminUserId: req.user!.id } });
      }
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      return { value: { ok: true, removed: true } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Message of the day ---------------------------------------------------
  // MOTDs are durable news items. Every post is retained; the snapshot pins
  // them ahead of the chronological feed so announcements remain visible.
  const motdSchema = z.object({ text: z.string().trim().min(1).max(gameConfig.motd.maxLength) });

  app.get("/admin/motd", async () => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return { messages: [] };
    const messages = loaded.world.news
      .filter((n) => n.kind === MOTD_NEWS_KIND)
      .reverse()
      .map((n) => ({ dayIndex: n.dayIndex, dayLabel: multiplayerDayLabel(n.dayIndex), text: n.text }));
    return { messages };
  });

  app.post("/admin/motd", async (req, reply) => {
    const parsed = motdSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `Text must be 1-${gameConfig.motd.maxLength} characters` });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      world.news.push({ dayIndex: world.dayIndex, text: parsed.data.text, kind: MOTD_NEWS_KIND });
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      publishToHumanUsers(world, { type: "invalidate", scope: "club" });
      return { value: { ok: true, text: parsed.data.text, dayIndex: world.dayIndex } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.delete("/admin/motd/message", async (req, reply) => {
    const parsedTarget = z.object({ dayIndex: z.coerce.number().int().min(0), text: z.string().min(1) }).safeParse(req.query);
    if (!parsedTarget.success) return reply.code(400).send({ error: "dayIndex and text are required" });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const index = world.news.findIndex(
        (n) => n.kind === MOTD_NEWS_KIND && n.dayIndex === parsedTarget.data.dayIndex && n.text === parsedTarget.data.text,
      );
      if (index < 0) return { error: { code: 404, body: { error: "MOTD not found" } } };
      world.news.splice(index, 1);
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      publishToHumanUsers(world, { type: "invalidate", scope: "club" });
      return { value: { ok: true, removed: 1 } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // Bulk clear remains available for housekeeping, but posting never calls it.
  app.delete("/admin/motd", async (req, reply) => {
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const removed = world.news.filter((n) => n.kind === MOTD_NEWS_KIND).length;
      if (removed === 0) return { value: { ok: true, removed: 0 } };
      world.news = world.news.filter((n) => n.kind !== MOTD_NEWS_KIND);
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent world update, retry" } } };
        throw e;
      }
      publishToHumanUsers(world, { type: "invalidate", scope: "club" });
      return { value: { ok: true, removed } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Club moderation context ---------------------------------------------
  // Everything the drill-down needs to run the existing moderation actions on
  // one club: identity, pyramid placement, owner, finances and the nicknames
  // that can be cleared. Read-only.
  app.get("/admin/clubs/:id", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World unavailable" });
    const world = loaded.world;
    const club = world.clubs.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!club) return reply.code(404).send({ error: "Club not found" });
    // Current-season division placement; null for NEW/DORMANT clubs.
    const division = world.competitions.find(
      (c) => c.kind === "division" && c.seasonId === world.mp.seasonId && c.status !== "ARCHIVED" && c.standings[club.id] !== undefined,
    );
    const squad = world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const owner = club.ownerUserId !== null
      ? await app.prisma.user.findUnique({ where: { id: club.ownerUserId }, select: { name: true, bannedAt: true } })
      : null;
    return {
      club: {
        id: club.id,
        name: club.name,
        shortName: club.shortName,
        stadiumName: club.stadiumName,
        competitionState: club.competitionState,
        country: club.country,
        ownerUserId: club.ownerUserId,
        ownerUsername: owner?.name ?? null,
        ownerBannedAt: owner?.bannedAt?.toISOString() ?? null,
        cash: club.cash,
        financialCushion: getCommitmentTotals(world, club).financialCushion,
        hasCustomLogo: Boolean(club.customLogo && club.customLogo.status === "ACTIVE"),
        division: division ? { id: division.id, name: division.name, tier: tierOf(division), groupIndex: groupIndexOf(division) } : null,
        squadSize: squad.length,
        avgOverall: squad.length > 0 ? Math.round((squad.reduce((sum, p) => sum + p.overall, 0) / squad.length) * 100) / 100 : null,
        nicknamedPlayers: world.players
          .filter((p) => p.clubId === club.id && (p.nickname ?? "").trim().length > 0)
          .slice(0, 100)
          .map((p) => ({ id: p.id, name: p.name, nickname: p.nickname! })),
      },
    };
  });

  // Deterministic clean-name suggestion for moderation resets. `attempt`
  // varies the outcome so admins can reroll without hidden randomness.
  app.get("/admin/suggested-club-name", async (req) => {
    const attempt = Math.max(0, Math.min(999, Number((req.query as { attempt?: string }).attempt ?? 0) || 0));
    return { name: suggestedModerationClubName(attempt) };
  });
}

/** Wake every connected human client (same pattern as routes/multiplayer.ts). */
function publishToHumanUsers(world: World, event: UserWorldEvent): void {
  publishWorldEventToUsers(
    world.clubs.flatMap((c) => (c.ownerUserId !== null ? [c.ownerUserId] : [])),
    event,
  );
}

function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_, current) => typeof current === "bigint" ? Number(current) : current);
}

async function writeSchedulerAudit(prisma: import("@prisma/client").PrismaClient, saveId: number, adminUserId: number, action: string, targetType: string, targetId: string | null, before: unknown, after: unknown, reason?: string): Promise<void> {
  await prisma.adminSchedulerAudit.create({ data: { saveId, adminUserId, action, targetType, targetId, beforeJson: jsonSafe(before), afterJson: jsonSafe(after), reason: reason ?? null } });
}
