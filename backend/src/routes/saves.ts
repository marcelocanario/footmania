import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSaveRecord, loadWorld, persistWorld } from "../services/saveService";
import { buildSnapshot } from "../services/snapshot";
import { advance } from "../game/world";
import { assignHumanClub } from "../game/worldgen";
import { dayInfo } from "../game/calendar";
import { COUNTRIES, FEATURED_COUNTRIES } from "../game/countries";
import { withSaveLock } from "../services/lock";
import { gameConfig } from "../config";
import type { DayResult, World } from "../game/types";

const createSchema = z.object({
  name: z.string().min(1).max(60),
  seed: z.number().int().optional(),
});

const startSchema = z.object({
  country: z.string().min(2).max(3),
  name: z.string().min(1).max(60).optional(),
});

export async function savesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.routeOptions?.url ?? req.url;
    if (path.includes("/saves") || path.includes("/settings")) {
      await app.authenticate(req, reply);
    }
  });

  app.get("/saves", async (req) => {
    const saves = await app.prisma.save.findMany({
      where: { userId: req.user!.id },
      orderBy: { updatedAt: "desc" },
    });
    return saves.map((s) => ({ id: s.id, name: s.name, year: s.year, dayIndex: s.dayIndex, hasHuman: s.humanClubId !== null, updatedAt: s.updatedAt }));
  });

  app.post("/saves", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const { name, seed } = parsed.data;
    const result = await createSaveRecord(app.prisma, req.user!.id, name, seed);
    return result;
  });

  app.delete("/saves/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const res = await app.prisma.save.deleteMany({ where: { id, userId: req.user!.id } });
    if (res.count === 0) return reply.code(404).send({ error: "Save not found" });
    return { ok: true };
  });

  app.get("/saves/:id/summary", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, id, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const info = dayInfo(loaded.world.dayIndex);
    return {
      id,
      name: loaded.save.name,
      year: loaded.world.year,
      dayIndex: loaded.world.dayIndex,
      dateLabel: info.label,
      hasHuman: loaded.world.humanClubId !== null,
      clubName: loaded.world.humanClubId
        ? loaded.world.clubs.find((c) => c.id === loaded.world.humanClubId)?.name ?? null
        : null,
    };
  });

  app.get("/saves/:id/state", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, id, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    if (loaded.world.humanClubId === null) {
      return {
        started: false as const,
        featuredCountries: FEATURED_COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
        allCountries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
      };
    }
    return { started: true as const, snapshot: buildSnapshot(loaded.world, loaded.world.humanClubId) };
  });

  app.post("/saves/:id/start", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const loaded = await loadWorld(app.prisma, id, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const result = assignHumanClub(loaded.world, parsed.data.country, parsed.data.name);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Unable to start save" });
    await persistWorld(app.prisma, id, req.user!.id, loaded.world);
    return { ok: true, clubId: result.clubId };
  });

  app.post("/saves/:id/advance", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const result = await withSaveLock(id, async () => {
      const loaded = await loadWorld(app.prisma, id, req.user!.id);
      if (!loaded) return { error: 404, body: { error: "Save not found" } } as const;
      if (loaded.world.humanClubId === null) return { error: 400, body: { error: "Save not started" } } as const;
      const dayResult = advance(loaded.world, { maxDays: 200 });
      await persistWorld(app.prisma, id, req.user!.id, loaded.world);
      return { error: 0, body: serializeDayResult(loaded.world, dayResult) } as const;
    });
    if ("error" in result && result.error !== 0) {
      return reply.code(result.error).send(result.body);
    }
    return result.body;
  });

  app.get("/saves/:id/live", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, id, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const st = loaded.world.liveMatch;
    if (!st) return { match: null };
    const home = loaded.world.clubs.find((c) => c.id === st.homeClubId);
    const away = loaded.world.clubs.find((c) => c.id === st.awayClubId);
    return {
      match: {
        id: st.matchId,
        home: home?.name ?? "",
        away: away?.name ?? "",
      },
    };
  });

  app.get("/settings", async () => ({
    humanMatchDurationMinutes: gameConfig.humanMatchDurationMinutes,
  }));

  app.put("/settings", async (req, reply) => {
    const parsed = z
      .object({ humanMatchDurationMinutes: z.number().int().min(1).max(60) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    gameConfig.humanMatchDurationMinutes = parsed.data.humanMatchDurationMinutes;
    return { humanMatchDurationMinutes: gameConfig.humanMatchDurationMinutes };
  });
}

export function serializeDayResult(world: World, dayResult: DayResult) {
  const info = dayInfo(dayResult.dayIndex);
  const hm = dayResult.humanMatch;
  return {
    dayIndex: dayResult.dayIndex,
    dateLabel: info.label,
    events: dayResult.events,
    news: dayResult.news,
    playedMatches: dayResult.playedMatches.map((m) => ({
      id: m.id,
      home: world.clubs.find((c) => c.id === m.homeClubId)?.name ?? "",
      away: world.clubs.find((c) => c.id === m.awayClubId)?.name ?? "",
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      competitionId: m.competitionId,
      isHuman: m.homeClubId === world.humanClubId || m.awayClubId === world.humanClubId,
    })),
    humanMatch: hm
      ? {
          id: hm.id,
          home: world.clubs.find((c) => c.id === hm.homeClubId)?.name ?? "",
          away: world.clubs.find((c) => c.id === hm.awayClubId)?.name ?? "",
          homeScore: hm.homeScore,
          awayScore: hm.awayScore,
        }
      : null,
    matchPending: dayResult.matchPending ?? false,
    seasonEnded: dayResult.seasonEnded ?? false,
  };
}
