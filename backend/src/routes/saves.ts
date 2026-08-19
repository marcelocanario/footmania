import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorld, persistWorld, StaleWorldError } from "../services/saveService";
import { buildSnapshot } from "../services/snapshot";
import { createHumanClub } from "../game/worldgen";
import { withGlobalLock } from "../services/lock";
import { isValidIanaTimezone, seasonKey } from "../game/clock";
import { gameConfig } from "../config";
import { auditMultiplayerEvent, placeNewClub, returnDormantClub, playPracticeMatch, divisionsInSeason, tierOf, groupIndexOf, compDivisionName, recordActivity, syncMemberships, syncClubSeasons, ROUNDS_PER_SEASON, isFillerAI, competitionStatus } from "../game/multiplayer";
import { ensureCurrentSeason, ensureSeasonRow, issueAllocation } from "../services/mpService";
import { COUNTRIES, FEATURED_COUNTRIES } from "../game/countries";
import type { World } from "../game/types";
import { standingsTiebreak } from "../game/league";

const joinSchema = z.object({
  clubName: z.string().min(1).max(60),
  country: z.string().min(2).max(3),
  timezone: z.string().max(64).refine(isValidIanaTimezone, "Invalid IANA timezone").optional().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  stadiumName: z.string().max(80).optional(),
});

async function withWorld(app: FastifyInstance, fn: (world: World) => Promise<{ error?: { code: number; body: unknown }; value?: unknown }>) {
  return withGlobalLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) return { error: { code: 404, body: { error: "World not found" } } };
      const res = await fn(loaded.world);
      if (res.error) return res;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
        return { value: res.value };
      } catch (error) {
        if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
      }
    }
    throw new Error("World mutation could not be committed");
  });
}

export async function savesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.routeOptions?.url ?? req.url;
    if (path.includes("/mp") || path.includes("/settings") || path.includes("/account")) {
      await app.authenticate(req, reply);
    }
  });

  // --- Multiplayer status -------------------------------------------------
  app.get("/mp/status", async (req) => {
    return withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) {
        return { ready: false as const, saveId: null };
      }
      const world = loaded.world;
      const user = req.user!;
      const club = world.clubs.find((c) => c.ownerUserId === user.id) ?? null;
      const reserved = club
        ? world.seasonAllocations.find((allocation) => allocation.clubId === club.id && allocation.type === "PROVISIONAL_NEXT_SEASON") ?? null
        : null;
      return {
        ready: true as const,
        saveId: loaded.save.id,
        season: {
          key: seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }),
          year: world.mp.seasonYear,
          month: world.mp.seasonMonth,
          status: world.mp.seasonStatus,
          completedRounds: world.mp.completedRounds,
          joinLockRound: world.mp.joinLockRound,
          joinState: world.mp.joinState,
        },
        userClubId: club?.id ?? null,
        club: club
          ? {
              id: club.id,
              name: club.name,
              shortName: club.shortName,
              country: club.country,
              highestDivision: club.highestDivision,
              cash: club.cash,
              competitionState: club.competitionState,
              timezone: club.timezone,
              reservedNextSeasonAllocation: reserved ? { seasonId: reserved.seasonId, amount: reserved.amount, issuedAt: reserved.issuedAt } : null,
              inactivity: club.abandonmentEligibleAt !== null
                ? {
                    eligible: true,
                    removedAtRollover: true,
                    note: "Your club may lose its league position at the end of the season if inactivity continues. Your club, squad and progression are retained — returning later means re-entering from the lowest available level.",
                  }
                : { eligible: false, removedAtRollover: false, note: null },
            }
          : null,
      };
    });
  });

  // --- Join / create club -------------------------------------------------
  app.post("/mp/join", async (req, reply) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const country = parsed.data.country.toUpperCase();
    if (!COUNTRIES.some((candidate) => candidate.code === country)) {
      return reply.code(400).send({ error: "Unknown country" });
    }
    const user = req.user!;
    let res: { error?: { code: number; body: unknown }; value?: unknown } | undefined;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      const existing = world.clubs.find((c) => c.ownerUserId === user.id);
      if (existing) return { error: { code: 409, body: { error: "You already have a club" } } };

      const club = createHumanClub(world, {
        userId: user.id,
        clubName: parsed.data.clubName,
         country,
        timezone: parsed.data.timezone ?? null,
        primaryColor: parsed.data.primaryColor,
        secondaryColor: parsed.data.secondaryColor,
        stadiumName: parsed.data.stadiumName,
      });
      // Keep the account profile and the persistent club clustering target in
      // sync.  Updating it does not move a club during the current season;
      // clustering only runs during reconstruction.
      await app.prisma.user.update({ where: { id: user.id }, data: { timezone: parsed.data.timezone ?? null } });

       const now = Date.now();
       const ref = { year: world.mp.seasonYear, month: world.mp.seasonMonth };
       const nextStart = new Date(Date.UTC(ref.month === 12 ? ref.year + 1 : ref.year, ref.month % 12, 1));
       const seasonId = world.mp.seasonId;
       const nextSeasonRef = { year: nextStart.getUTCFullYear(), month: nextStart.getUTCMonth() + 1 };
      const result = placeNewClub(world, club.id, now, seasonId, nextSeasonRef);
      auditMultiplayerEvent(world, result.kind === "active" ? "CLUB_JOINED" : "PROVISIONAL_ACTIVATION", { clubId: club.id, userId: user.id, metadata: JSON.stringify(result) });

    if (result.kind === "provisional") {
        const nextSeason = await ensureSeasonRow(app.prisma, nextSeasonRef);
        const bottomTier = divisionsInSeason(world, seasonId).reduce((max, division) => Math.max(max, tierOf(division)), 1);
        const hasReplaceableSlot = divisionsInSeason(world, seasonId)
          .filter((division) => tierOf(division) === bottomTier)
          .some((division) => Object.values(division.standings).some((row) => isFillerAI(world, row.clubId)));
        const reservedTier = hasReplaceableSlot ? bottomTier : bottomTier + 1;
        await issueAllocation(app.prisma, world, club.id, nextSeason.seasonId, reservedTier, { type: "PROVISIONAL_NEXT_SEASON" });
        world.mpQueue.push({ clubId: club.id, source: "NEW_CLUB", queuedAt: Date.now(), preferredSeasonId: nextSeason.seasonId });
      } else {
        const completed = world.mp.completedRounds;
         const total = ROUNDS_PER_SEASON;
        await issueAllocation(app.prisma, world, club.id, seasonId, result.tier, {
          type: "ACTIVE_PRORATED",
          remainingRounds: Math.max(0, total - completed),
        });
      }

      recordActivity(loaded.world, user.id, club.id, "join");
      syncMemberships(loaded.world, seasonId);
      syncClubSeasons(loaded.world, seasonId);
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return { value: { ok: true, clubId: club.id, result } };
        });
      } catch (error) {
        if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
      }
    }
    if (!res) throw new Error("Club placement could not be committed");
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Return a dormant club ----------------------------------------------
  app.post("/mp/return", async (req, reply) => {
    const user = req.user!;
    const res = await withGlobalLock(async () => {
      await ensureCurrentSeason(app.prisma);
      const loaded = await loadGlobalWorld(app.prisma);
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
      auditMultiplayerEvent(world, result.kind === "active" ? "CLUB_RETURNED" : "PROVISIONAL_ACTIVATION", { clubId: existing.id, userId: user.id, metadata: JSON.stringify(result) });

      if (result.kind === "provisional" && !world.mpQueue.some((entry) => entry.clubId === existing.id)) {
        const nextSeason = await ensureSeasonRow(app.prisma, nextSeasonRef);
        world.mpQueue.push({ clubId: existing.id, source: "RETURNING_CLUB", queuedAt: Date.now(), preferredSeasonId: nextSeason.seasonId });
      }

      recordActivity(world, user.id, existing.id, "return");
      syncMemberships(world, seasonId);
      syncClubSeasons(world, seasonId);
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
      return { value: { ok: true, result } };
    });
    if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
    return res.value;
  });

  // --- Practice match (provisional clubs) ---------------------------------
  app.post("/mp/practice", async (req, reply) => {
    const user = req.user!;
    const res = await withWorld(app, async (world) => {
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
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
    if (!club) return reply.code(404).send({ error: "You have no club yet" });
    return { snapshot: buildSnapshot(world, club.id) };
  });

  // --- Pyramid ------------------------------------------------------------
  app.get("/mp/pyramid", async (req) => {
    const loaded = await loadGlobalWorld(app.prisma);
    const world = loaded?.world;
    if (!world) return { seasonKey: null, tiers: [] };
    const divisions = divisionsInSeason(world, world.mp.seasonId);
    const byTier = new Map<number, { id: number; name: string; tier: number; groupIndex: number; humanCount: number; aiCount: number }[]>();
    for (const d of divisions) {
      const t = tierOf(d);
      const members = Object.values(d.standings);
      const humans = members.filter((r) => world.clubs.find((c) => c.id === r.clubId)?.ownerUserId != null).length;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t)!.push({ id: d.id, name: compDivisionName(d), tier: t, groupIndex: groupIndexOf(d), humanCount: humans, aiCount: members.length - humans });
    }
    const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([tier, divisions]) => ({ tier, divisions }));
    return { seasonKey: seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }), tiers };
  });

  // --- Division standings / fixtures --------------------------------------
  app.get("/mp/divisions/:id/standings", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    const rows = standingsTiebreak(Object.values(comp.standings))
      .map((row) => {
        const club = world.clubs.find((c) => c.id === row.clubId);
        return {
          ...row,
          clubId: row.clubId,
          clubName: club?.name ?? "",
          clubShort: club?.shortName ?? "",
          colors: { primary: club?.primaryColor ?? "", secondary: club?.secondaryColor ?? "" },
          isHuman: club?.ownerUserId != null,
          clubType: club?.ownerUserId != null ? "HUMAN" : "AI",
          isMine: club?.ownerUserId === req.user!.id,
          ...competitionStatus(world, comp, row.clubId),
        };
      });
    return { competition: { id: comp.id, name: comp.name, tier: tierOf(comp), groupIndex: groupIndexOf(comp) }, standings: rows };
  });

  app.get("/mp/divisions/:id/fixtures", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    const myClubId = world.clubs.find((c) => c.ownerUserId === req.user!.id)?.id ?? null;
    const fixtures = world.fixtures
      .filter((f) => f.competitionId === comp.id)
      .sort((a, b) => a.round - b.round)
      .map((f) => {
        const home = world.clubs.find((c) => c.id === f.homeClubId);
        const away = world.clubs.find((c) => c.id === f.awayClubId);
        const m = world.matches.find((x) => x.fixtureId === f.id);
        return {
          id: f.id,
          round: f.round,
          home: home?.name ?? f.homeClubNameSnapshot ?? "",
          away: away?.name ?? f.awayClubNameSnapshot ?? "",
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

  // --- Season history -----------------------------------------------------
  app.get("/mp/history", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
    const clubId = club?.id ?? null;
    const seasons = world.seasonHistory
      .map((entry) => ({
        ...entry,
        divisions: entry.divisions.map((div) => ({
          ...div,
          standings: div.standings.map((row) => ({
            ...row,
            isMine: row.clubId === clubId,
          })),
        })),
      }))
      .reverse();
    return { seasons };
  });

  // --- My live match ------------------------------------------------------
  app.get("/mp/live-match", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
    if (!club) return { match: null };
    const st = world.liveMatches.find((s) => s.homeClubId === club.id || s.awayClubId === club.id);
    if (!st) return { match: null };
    const home = world.clubs.find((c) => c.id === st.homeClubId);
    const away = world.clubs.find((c) => c.id === st.awayClubId);
    return {
      match: {
        id: st.matchId,
        home: home?.name ?? "",
        away: away?.name ?? "",
      },
    };
  });

  // --- Settings -----------------------------------------------------------
  app.get("/settings", async () => ({
    humanMatchDurationMinutes: gameConfig.humanMatchDurationMinutes,
    maxContractSeasons: gameConfig.maxContractSeasons,
  }));

  app.put("/settings", async (req) => {
    const parsed = z.object({ humanMatchDurationMinutes: z.number().int().min(1).max(60) }).safeParse(req.body);
    if (!parsed.success) return { error: "Invalid input" };
    gameConfig.humanMatchDurationMinutes = parsed.data.humanMatchDurationMinutes;
    return { humanMatchDurationMinutes: gameConfig.humanMatchDurationMinutes };
  });

  // Account timezone is the IANA source of truth.  The club copy is updated
  // immediately for the next rollover's clustering, but no current-season
  // division is moved as a side effect.
  app.put("/account/timezone", async (req, reply) => {
    const parsed = z.object({ timezone: z.string().max(64).refine(isValidIanaTimezone, "Invalid IANA timezone") }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid IANA timezone" });
    const userId = req.user!.id;
    const result = await withGlobalLock(async () => {
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) return { error: { code: 404, body: { error: "World not found" } } };
      const club = loaded.world.clubs.find((candidate) => candidate.ownerUserId === userId);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      await app.prisma.user.update({ where: { id: userId }, data: { timezone: parsed.data.timezone } });
      club.timezone = parsed.data.timezone;
      recordActivity(loaded.world, userId, club.id, "timezone_change");
      await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      return { value: { ok: true, timezone: parsed.data.timezone } };
    });
    if ("error" in result && result.error) return reply.code(result.error.code).send(result.error.body);
    return result.value;
  });

  // Countries list for club creation.
  app.get("/mp/countries", async () => ({
    featuredCountries: FEATURED_COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
    allCountries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
  }));
}
