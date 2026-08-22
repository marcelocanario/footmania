import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutable, loadGlobalWorldReadOnly, persistWorld, StaleWorldError } from "../services/saveService";
import { buildCachedSnapshot } from "../services/snapshot";
import { createHumanClub } from "../game/worldgen";
import { withGlobalLock } from "../services/lock";
import { seasonKey } from "../game/clock";
import { gameConfig, MP_CONFIG } from "../config";
import { clubKitsSchema } from "../game/kits";
import { validatePreferredHours } from "../game/scheduling";
import { placeNewClub, returnDormantClub, playPracticeMatch, divisionsInSeason, tierOf, groupIndexOf, compDivisionName, recordActivity, syncMemberships, syncClubSeasons } from "../game/multiplayer";
import { ensureCurrentSeason, ensureSeasonRow, issueAllocation } from "../services/mpService";
import { COUNTRIES, FEATURED_COUNTRIES } from "../game/countries";
import type { World } from "../game/types";
import { standingsTiebreak } from "../game/league";
import { hasPro } from "../services/pro";
import { readMpStatus, readSeasonHistory, readUserLiveMatch } from "../services/readService";
import { publishUserWorldEvent } from "../services/worldEvents";

const joinSchema = z.object({
  clubName: z.string().min(1).max(60),
  country: z.string().min(2).max(3),
  timezone: z.string().max(64).optional().nullable(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  // Kit Lab: full three-kit set designed in the wizard. Optional for legacy
  // clients; when present the home shell becomes the club identity colors.
  kits: clubKitsSchema.nullable().optional(),
  stadiumName: z.string().trim().min(1).max(80),
  coachName: z.string().trim().min(2).max(40),
  preferredHours: z.array(z.number()).optional(),
});

function publishToHumanUsers(world: World, event: Parameters<typeof publishUserWorldEvent>[1]): void {
  for (const club of world.clubs) {
    if (club.ownerUserId !== null) publishUserWorldEvent(club.ownerUserId, event);
  }
}

async function withWorld(app: FastifyInstance, userId: number, fn: (world: World) => Promise<{ error?: { code: number; body: unknown }; value?: unknown }>) {
  return withGlobalLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 404, body: { error: "World not found" } } };
      const res = await fn(loaded.world);
      if (res.error) return res;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
        publishUserWorldEvent(userId, { type: "invalidate", scope: "club" });
        return { value: res.value };
      } catch (error) {
        if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
      }
    }
    throw new Error("World mutation could not be committed");
  });
}

export async function multiplayerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.routeOptions?.url ?? req.url;
    if (path.includes("/mp") || path.includes("/settings")) {
      await app.authenticate(req, reply);
    }
  });

  // --- Multiplayer status -------------------------------------------------
  app.get("/mp/status", async (req) => {
    return readMpStatus(app.prisma, req.user!.id);
  });

  // --- Join / create club -------------------------------------------------
  app.post("/mp/join", async (req, reply) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    // Signup requires at least 8 hours of preferred windows (16 half-hour slots).
    const preferredHours = validatePreferredHours(parsed.data.preferredHours ?? []);
    if (preferredHours === null) return reply.code(400).send({ error: `Select at least ${MP_CONFIG.minPreferredSlots / 2} hours of preferred match times` });
    const user = req.user!;
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const existing = world.clubs.find((c) => c.ownerUserId === user.id);
      if (existing) return { error: { code: 409, body: { error: "You already have a club" } } };

      const club = createHumanClub(world, {
        userId: user.id,
        clubName: parsed.data.clubName,
        country: parsed.data.country,
        timezone: parsed.data.timezone ?? null,
        primaryColor: parsed.data.primaryColor,
        secondaryColor: parsed.data.secondaryColor,
        kits: parsed.data.kits ?? null,
        stadiumName: parsed.data.stadiumName,
        coachName: parsed.data.coachName,
        preferredHours,
      });

       const now = Date.now();
       const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
       const nextStart = new Date(Date.UTC(ref.month === 12 ? ref.year + 1 : ref.year, ref.month % 12, 1));
       const seasonId = world.mp.seasonId;
       const nextSeasonRef = { year: nextStart.getUTCFullYear(), month: nextStart.getUTCMonth() + 1 };
      const result = placeNewClub(world, club.id, now, seasonId, nextSeasonRef);

    if (result.kind === "provisional") {
        const nextSeason = await ensureSeasonRow(app.prisma, nextSeasonRef);
        await issueAllocation(app.prisma, world, club.id, nextSeason.seasonId, 1, { type: "PROVISIONAL_NEXT_SEASON" });
        world.mpQueue.push({ clubId: club.id, source: "NEW_CLUB", queuedAt: Date.now(), preferredSeasonId: nextSeason.seasonId });
      } else {
        const completed = world.mp.completedRounds;
        await issueAllocation(app.prisma, world, club.id, seasonId, result.tier, {
          type: "ACTIVE_PRORATED",
          remainingRounds: Math.max(0, gameConfig.roundsPerSeason - completed),
        });
      }

      recordActivity(loaded.world, user.id, club.id, "join");
      syncMemberships(loaded.world, seasonId);
      syncClubSeasons(loaded.world, seasonId);
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      publishToHumanUsers(world, { type: "invalidate", scope: "mp" });
      publishUserWorldEvent(user.id, { type: "invalidate", scope: "club" });
      return { value: { ok: true, clubId: club.id, result } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Return a dormant club ----------------------------------------------
  app.post("/mp/return", async (req, reply) => {
    const user = req.user!;
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const existing = world.clubs.find((c) => c.ownerUserId === user.id);
      if (!existing) return { error: { code: 400, body: { error: "You have no club" } } };
      if (existing.competitionState !== "DORMANT") return { error: { code: 400, body: { error: "Your club is not dormant" } } };

      const now = Date.now();
      const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
      const nextStart = new Date(Date.UTC(ref.month === 12 ? ref.year + 1 : ref.year, ref.month % 12, 1));
      const seasonId = world.mp.seasonId;
      const nextSeasonRef = { year: nextStart.getUTCFullYear(), month: nextStart.getUTCMonth() + 1 };
      const result = returnDormantClub(world, existing.id, now, seasonId, nextSeasonRef);

      recordActivity(world, user.id, existing.id, "return");
      syncMemberships(world, seasonId);
      syncClubSeasons(world, seasonId);
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      publishToHumanUsers(world, { type: "invalidate", scope: "mp" });
      publishUserWorldEvent(user.id, { type: "invalidate", scope: "club" });
      return { value: { ok: true, result } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Practice match (provisional clubs) ---------------------------------
  app.post("/mp/practice", async (req, reply) => {
    const user = req.user!;
     const res = await withWorld(app, user.id, async (world) => {
      const club = world.clubs.find((c) => c.ownerUserId === user.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      if (club.competitionState !== "PROVISIONAL") {
        return { error: { code: 400, body: { error: "Practice matches are for provisional clubs" } } };
      }
      const result = playPracticeMatch(world, club.id);
      if (!result) return { error: { code: 400, body: { error: "No opponent available" } } };
      recordActivity(world, user.id, club.id, "practice");
      return { value: result };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  app.get("/mp/club", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
    if (!club) return reply.code(404).send({ error: "You have no club yet" });
    return { snapshot: buildCachedSnapshot(world, club.id, loaded.save.revision) };
  });

  // --- Pyramid ------------------------------------------------------------
  app.get("/mp/pyramid", async (req) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    const world = loaded?.world;
    if (!world) return { seasonKey: null, tiers: [] };
    const divisions = divisionsInSeason(world, world.mp.seasonId);
    const clubById = new Map(world.clubs.map((club) => [club.id, club]));
    const byTier = new Map<number, { id: number; name: string; tier: number; groupIndex: number; humanCount: number; aiCount: number }[]>();
    for (const d of divisions) {
      const t = tierOf(d);
      const members = Object.values(d.standings);
       const humans = members.filter((r) => clubById.get(r.clubId)?.ownerUserId !== null).length;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t)!.push({ id: d.id, name: compDivisionName(d), tier: t, groupIndex: groupIndexOf(d), humanCount: humans, aiCount: members.length - humans });
    }
    const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([tier, divisions]) => ({ tier, divisions }));
    return { seasonKey: seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }), tiers };
  });

  app.get("/mp/history", async (req, reply) => {
    const requested = Number((req.query as { limit?: string }).limit ?? 20);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.trunc(requested))) : 20;
    const result = await readSeasonHistory(app.prisma, req.user!.id, limit);
    if (!result) return reply.code(404).send({ error: "World not found" });
    return result;
  });

  // --- Division standings / fixtures --------------------------------------
  app.get("/mp/divisions/:id/standings", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    const clubById = new Map(world.clubs.map((club) => [club.id, club]));
    const seasonByClubId = new Map(world.mpClubSeasons.filter((entry) => entry.seasonId === world.mp.seasonId && entry.divisionId === comp.id).map((entry) => [entry.clubId, entry]));
    const rows = standingsTiebreak(Object.values(comp.standings))
      .map((row) => {
        const club = clubById.get(row.clubId);
        const seasonEntry = seasonByClubId.get(row.clubId);
        return {
          ...row,
          clubId: row.clubId,
          clubName: club?.name ?? "",
          clubShort: club?.shortName ?? "",
          colors: { primary: club?.primaryColor ?? "", secondary: club?.secondaryColor ?? "" },
          isHuman: club?.ownerUserId !== null,
          clubType: club?.ownerUserId !== null ? "HUMAN" : "AI",
          isMine: club?.ownerUserId === req.user!.id,
          promotionStatus: seasonEntry?.promotionStatus ?? "NONE",
          relegationStatus: seasonEntry?.relegationStatus ?? "NONE",
        };
      });
    return { competition: { id: comp.id, name: comp.name, tier: tierOf(comp), groupIndex: groupIndexOf(comp) }, standings: rows };
  });

  app.get("/mp/divisions/:id/fixtures", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    const clubById = new Map(world.clubs.map((club) => [club.id, club]));
    const matchByFixtureId = new Map(world.matches.map((match) => [match.fixtureId, match]));
    const myClubId = world.clubs.find((c) => c.ownerUserId === req.user!.id)?.id ?? null;
    const fixtures = world.fixtures
      .filter((f) => f.competitionId === comp.id)
      .sort((a, b) => a.round - b.round)
      .map((f) => {
        const home = clubById.get(f.homeClubId);
        const away = clubById.get(f.awayClubId);
        const m = matchByFixtureId.get(f.id);
        return {
          id: f.id,
          round: f.round,
          home: home?.name ?? "",
          away: away?.name ?? "",
          homeClubId: f.homeClubId,
          awayClubId: f.awayClubId,
          kickoffAt: f.kickoffAt ?? null,
          played: f.played,
          homeScore: m?.homeScore ?? null,
          awayScore: m?.awayScore ?? null,
          isHuman: myClubId !== null && (f.homeClubId === myClubId || f.awayClubId === myClubId),
        };
      });
    return { fixtures };
  });

  // --- My live match ------------------------------------------------------
  app.get("/mp/live-match", async (req, reply) => {
    const result = await readUserLiveMatch(app.prisma, req.user!.id);
    if (!result) return reply.code(404).send({ error: "World not found" });
    return result;
  });

  // --- Preferred match times ----------------------------------------------
  app.put("/mp/preferred-hours", async (req, reply) => {
    const parsed = z.object({ preferredHours: z.array(z.number()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const preferredHours = validatePreferredHours(parsed.data.preferredHours);
    if (preferredHours === null) return reply.code(400).send({ error: `Select at least ${MP_CONFIG.minPreferredSlots / 2} hours of preferred match times` });
     const res = await withWorld(app, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      // Preferences only affect the next fixture generation; existing fixtures
      // are never rescheduled.
      club.preferredHours = preferredHours;
      recordActivity(world, req.user!.id, club.id, "preferred-hours");
      return { value: { ok: true, preferredHours } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Kit designer (Kit Lab clone): replace all three jersey designs ------
  app.put("/mp/club/kit", async (req, reply) => {
    const parsed = z.object({ kits: clubKitsSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid kit design" });
    const kits = parsed.data.kits;
     const res = await withWorld(app, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      club.kits = kits;
      // Keep the legacy identity columns in sync with the home shell so every
      // existing consumer (standings colors, live clash logic) stays correct.
      club.primaryColor = kits.home.primary;
      club.secondaryColor = kits.home.secondary;
      recordActivity(world, req.user!.id, club.id, "kit");
      return { value: { ok: true, kits } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Edit club identity (Kit Lab companion): rename club / stadium -------
  app.put("/mp/club/profile", async (req, reply) => {
    const parsed = z
      .object({
        clubName: z.string().trim().min(1).max(60).optional(),
        stadiumName: z.string().trim().min(1).max(80).optional(),
        coachName: z.string().trim().min(2).max(40).optional(),
      })
      .refine((d) => d.clubName !== undefined || d.stadiumName !== undefined || d.coachName !== undefined, { message: "Nothing to update" })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
     const res = await withWorld(app, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      // Country is intentionally immutable here: it drives player-name pools
      // and next-season division clustering. Name changes are forward-looking
      // only; completed seasons keep their recorded names (historical integrity).
      if (parsed.data.clubName !== undefined) {
        club.name = parsed.data.clubName;
        club.shortName = parsed.data.clubName;
      }
      if (parsed.data.stadiumName !== undefined) club.stadiumName = parsed.data.stadiumName;
      if (parsed.data.coachName !== undefined) {
        if (!hasPro(req.user)) return { error: { code: 403, body: { error: "Coach name editing is a Pro feature" } } };
        const currentSeasonKey = seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth });
        if (club.coachNameChangedSeasonKey === currentSeasonKey) {
          return { error: { code: 400, body: { error: "Coach name can only be changed once per season" } } };
        }
        club.coachName = parsed.data.coachName;
        club.coachNameChangedSeasonKey = currentSeasonKey;
      }
      recordActivity(world, req.user!.id, club.id, "profile");
      return { value: { ok: true, name: club.name, stadiumName: club.stadiumName, coachName: club.coachName } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Settings -----------------------------------------------------------
  // Read-only static config for the frontend (contract terms, live pacing).
  app.get("/settings", async () => ({
    maxContractSeasons: gameConfig.maxContractSeasons,
    matchDurationMinutes: MP_CONFIG.matchDurationMinutes,
  }));

  // Countries list for club creation.
  app.get("/mp/countries", async () => ({
    featuredCountries: FEATURED_COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
    allCountries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
  }));
}
