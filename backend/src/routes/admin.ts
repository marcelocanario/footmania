import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorld, persistWorld } from "../services/saveService";
import { withGlobalLock } from "../services/lock";
import { simulateThroughRound, divisionsInSeason, isFillerAI, timezoneCoordinate } from "../game/multiplayer";
import { ensureCurrentSeason, rollover, configuredInactivityThresholds, configuredMatchTiming, setLeagueSettings } from "../services/mpService";
import { ROUNDS_PER_SEASON } from "../game/multiplayer";
import { seasonRefFor, completedRounds } from "../game/clock";
import { budgetSettings, setBudgetSettings } from "../game/budget";
import { readNumberSetting } from "../game/budget";

const advanceSchema = z.object({
  // Target round to simulate through (1..14). Rounds already played are
  // skipped; all divisions are simulated instantly up to this round.
  round: z.number().int().min(1).max(ROUNDS_PER_SEASON),
});

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

  // Simulate every division instantly through the requested round.
  app.post("/admin/advance-round", async (req, reply) => {
    const parsed = advanceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
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
    const parsed = advanceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
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
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      world.mp.manualRound = null;
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return { value: { ok: true } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // Force an immediate season rollover (new month) for testing.
  app.post("/admin/rollover", async (req, reply) => {
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const season = await rollover(app.prisma);
      return { ok: true, season };
    });
    return res;
  });

  app.get("/admin/status", async (req) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return { world: null };
    const world = loaded.world;
    const now = Date.now();
    const ref = seasonRefFor(new Date(now));
    return {
      world: {
        seasonKey: `${world.mp.seasonYear}-${String(world.mp.seasonMonth).padStart(2, "0")}`,
        seasonStatus: world.mp.seasonStatus,
        completedRounds: world.mp.completedRounds,
        joinState: world.mp.joinState,
        joinLockRound: world.mp.joinLockRound,
        manualRound: world.mp.manualRound,
        realCompletedRounds: completedRounds(ref, now, world.mp.matchKickoffHour),
        divisionCount: divisionsInSeason(world, world.mp.seasonId).length,
        clubCount: world.clubs.length,
        humanClubCount: world.clubs.filter((c) => c.ownerUserId !== null).length,
        liveMatchCount: world.liveMatches.length,
      },
    };
  });

  // Budget economy settings (plan §17A).
  app.get("/admin/budget-settings", async () => ({ settings: await budgetSettings(app.prisma) }));

  const budgetSchema = z.object({
    firstDivisionBudget: z.number().int().min(1).optional(),
    minimumTierBudgetRatio: z.number().min(0.05).max(1).optional(),
    tierBudgetDecayRate: z.number().min(0.01).max(5).optional(),
  });
  app.put("/admin/budget-settings", async (req, reply) => {
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return { settings: await setBudgetSettings(app.prisma, parsed.data) };
  });

  app.get("/admin/league-settings", async () => ({
    settings: {
      joinThresholdPercent: await readNumberSetting(app.prisma, "JOIN_THRESHOLD_PERCENT", 0.5),
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
      const loaded = await loadGlobalWorld(app.prisma);
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
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return { metrics: null };
    const world = loaded.world;
    const divisions = divisionsInSeason(world, world.mp.seasonId).filter((d) => d.status !== "ARCHIVED");
    const fillerCount = world.clubs.filter((club) => isFillerAI(world, club.id)).length;
    const activeDivisionsByTier = new Map<number, number>();
    const sizes: number[] = [];
    let avgHumansPerDivision = 0;
    const timezoneSpreads: { divisionId: number; spreadHours: number }[] = [];
    if (divisions.length > 0) {
      let totalHumans = 0;
      for (const d of divisions) {
        const members = Object.keys(d.standings).length;
        sizes.push(members);
        activeDivisionsByTier.set(d.tier ?? 1, (activeDivisionsByTier.get(d.tier ?? 1) ?? 0) + 1);
        totalHumans += Object.values(d.standings).filter((r) => world.clubs.find((c) => c.id === r.clubId)?.ownerUserId != null).length;
        const coordinates = Object.values(d.standings)
          .map((r) => world.clubs.find((c) => c.id === r.clubId)?.timezone)
          .filter((tz): tz is string => !!tz)
          .map(timezoneCoordinate);
        timezoneSpreads.push({ divisionId: d.id, spreadHours: coordinates.length > 1 ? Math.max(...coordinates) - Math.min(...coordinates) : 0 });
      }
      avgHumansPerDivision = totalHumans / divisions.length;
    }
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
        auctionCount: world.auctions.length,
        liveMatchCount: world.liveMatches.length,
        joinState: world.mp.joinState,
        seasonStatus: world.mp.seasonStatus,
        timezoneSpreadByDivision: timezoneSpreads,
        alerts: [
          ...sizes.filter((size) => size !== 8).map((size, i) => `division ${i + 1} has ${size} clubs (expected 8)`),
          ...(world.auctions.some((a) => a.endsAt !== undefined && a.endsAt < Date.now()) ? ["auction overdue"] : []),
          ...(world.fixtures.some((fixture) => !fixture.played && fixture.kickoffAt !== undefined && fixture.kickoffAt < Date.now() - 15 * 60 * 1000) ? ["match overdue"] : []),
          ...(world.mp.rolloverPhase !== null ? ["season rollover incomplete"] : []),
        ],
      },
    };
  });

  app.get("/admin/audit", async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100) || 100));
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return { events: [] };
    return { events: loaded.world.mpAudits.slice(-limit).reverse() };
  });
}
