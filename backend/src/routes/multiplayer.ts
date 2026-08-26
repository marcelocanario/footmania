import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutable, loadGlobalWorldReadOnly, persistWorld, StaleWorldError } from "../services/saveService";
import { buildCachedSnapshot } from "../services/snapshot";
import { createHumanClub } from "../game/worldgen";
import { withGlobalLock } from "../services/lock";
import { seasonKey } from "../game/clock";
import { gameConfig, MP_CONFIG } from "../config";
import { SENIOR_SQUAD_LIMIT } from "../game/constants";
import { clubKitsSchema } from "../game/kits";
import { validatePreferredHours } from "../game/scheduling";
import { placeNewClub, returnDormantClub, playPracticeMatch, divisionsInSeason, tierOf, groupIndexOf, compDivisionName, recordActivity, syncMemberships, syncClubSeasons } from "../game/multiplayer";
import { ensureCurrentSeason, ensureSeasonRow, issueAllocation } from "../services/mpService";
import { applyArchivedIdentity, resolveArchiveRow } from "../game/identityArchive";
import { COUNTRIES, FEATURED_COUNTRIES } from "../game/countries";
import type { World } from "../game/types";
import { hasPro } from "../services/pro";
import { readMpStatus, readPublicSeasonStatus, readSeasonHistory, readUserLiveMatch, footmaniaRankingView, divisionStandingsView, divisionFixturesView, buildTeamProfile } from "../services/readService";
import { publishUserWorldEvent } from "../services/worldEvents";
import { isPaused, worldPausedError, applyResumeShift } from "../services/seasonPause";

const joinSchema = z.object({
  clubName: z.string().min(1).max(60),
  country: z.string().min(2).max(3),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  // Kit Lab: full three-kit set designed in the wizard. Optional for legacy
  // clients; when present the home shell becomes the club identity colors.
  kits: clubKitsSchema.nullable().optional(),
  stadiumName: z.string().trim().min(1).max(80),
  // Manager name. Optional: when omitted the club uses the user's Google
  // display name (User.name), which is also what the frontend prefills.
  coachName: z.string().trim().min(2).max(40).optional(),
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

  // --- Public season status (landing page, no auth) -----------------------
  // Read-only snapshot of the world clock so the login screen can show a
  // truthful "state of the season" without exposing any account data.
  app.get("/public/season", async () => readPublicSeasonStatus(app.prisma));

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
      // An archived identity (preserved by a world reset with keepIdentity)
      // overrides the wizard payload: the club comes back with its old name,
      // colors, kit, crest, stadium, coach and match-time availability. The
      // row is consumed on successful placement.
      const archiveRow = await app.prisma.clubIdentityArchive.findUnique({ where: { userId: user.id } });
      const archive = archiveRow ? resolveArchiveRow(archiveRow) : null;
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const world = loaded.world;
      // Schedule-dependent: joining places the club into the live season.
      // The FIRST human join is the exception: while awaitingFirstHuman the
      // season clock is held and no division exists — this join lifts the
      // hold (clears pausedAt, applies the resume shift so the season starts
      // anchored to now) and Division 1 forms lazily below. Any later join
      // while paused is still rejected.
      const awaitingFirst = world.mp.awaitingFirstHuman === true;
      if (isPaused(world) && !awaitingFirst) return { error: worldPausedError };
      const existing = world.clubs.find((c) => c.ownerUserId === user.id);
      if (existing) return { error: { code: 409, body: { error: "You already have a club" } } };

      // Preferred windows come from the archive when one exists (they were
      // validated when first stored); otherwise the wizard windows validated
      // above are used.
      const club = createHumanClub(
        world,
        archive
          ? applyArchivedIdentity(archive, {
              userId: user.id,
              clubName: parsed.data.clubName,
              country: parsed.data.country,
              primaryColor: parsed.data.primaryColor,
              secondaryColor: parsed.data.secondaryColor,
              kits: parsed.data.kits ?? null,
              stadiumName: parsed.data.stadiumName,
              // The Google display name is the default manager name (the frontend
              // prefills it and it is editable); a legacy client may omit it.
              coachName: parsed.data.coachName ?? user.name,
              preferredHours,
            })
          : {
              userId: user.id,
              clubName: parsed.data.clubName,
              country: parsed.data.country,
              primaryColor: parsed.data.primaryColor,
              secondaryColor: parsed.data.secondaryColor,
              kits: parsed.data.kits ?? null,
              stadiumName: parsed.data.stadiumName,
              coachName: parsed.data.coachName ?? user.name,
              preferredHours,
            },
      );
      // The archived crest is applied after creation (customLogo is not part
      // of the wizard payload).
      if (archive?.customLogo) {
        club.customLogo = archive.customLogo;
        club.logoVariant = archive.logoVariant;
      }

      const now = Date.now();
      // Lift the waiting-for-first-human hold: shift every real-time anchor
      // forward by the held interval (same semantics as an admin resume) so
      // the season clock starts fresh at this join moment, then clear the
      // hold. Division 1 is created lazily by placeNewClub below.
      if (awaitingFirst) {
        const pausedAt = world.mp.pausedAt ?? now;
        const shift = Math.max(0, now - pausedAt);
        applyResumeShift(world, shift);
        world.mp.pausedAt = null;
        world.mp.awaitingFirstHuman = false;
      }

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
      // Consume the preserved identity: it has been re-applied to the club.
      if (archiveRow) {
        await app.prisma.clubIdentityArchive.delete({ where: { userId: user.id } });
      }
      publishToHumanUsers(world, { type: "invalidate", scope: "mp" });
      publishUserWorldEvent(user.id, { type: "invalidate", scope: "club" });
      return { value: { ok: true, clubId: club.id, result, preserved: archive !== null } };
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
      // Schedule-dependent: returning re-enters the live season.
      if (isPaused(world)) return { error: worldPausedError };
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
    // The caller's current division so the tables screen can pre-select it.
    const myClub = world.clubs.find((c) => c.ownerUserId === req.user!.id);
    const myDivision = myClub ? divisions.find((d) => Object.values(d.standings).some((row) => row.clubId === myClub.id)) : undefined;
    const byTier = new Map<number, { id: number; name: string; tier: number; groupIndex: number; humanCount: number; aiCount: number }[]>();
    for (const d of divisions) {
      const t = tierOf(d);
      const members = Object.values(d.standings);
       const humans = members.filter((r) => clubById.get(r.clubId)?.ownerUserId !== null).length;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t)!.push({ id: d.id, name: compDivisionName(d), tier: t, groupIndex: groupIndexOf(d), humanCount: humans, aiCount: members.length - humans });
    }
    const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([tier, divisions]) => ({ tier, divisions }));
    return {
      seasonKey: seasonKey({ year: world.mp.seasonYear, month: world.mp.seasonMonth }),
      tiers,
      myDivisionId: myDivision?.id ?? null,
    };
  });

  app.get("/mp/history", async (req, reply) => {
    const requested = Number((req.query as { limit?: string }).limit ?? 20);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.trunc(requested))) : 20;
    const result = await readSeasonHistory(app.prisma, req.user!.id, limit);
    if (!result) return reply.code(404).send({ error: "World not found" });
    return result;
  });

  app.get("/mp/rankings/footmania", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    return footmaniaRankingView(loaded.world, req.user!.id);
  });

  // --- Division standings / fixtures --------------------------------------
  app.get("/mp/divisions/:id/standings", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    return { competition: { id: comp.id, name: comp.name, tier: tierOf(comp), groupIndex: groupIndexOf(comp) }, standings: divisionStandingsView(world, comp, req.user!.id) };
  });

  app.get("/mp/divisions/:id/fixtures", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const world = loaded.world;
    const comp = world.competitions.find((c) => c.id === Number((req.params as { id: string }).id));
    if (!comp) return reply.code(404).send({ error: "Division not found" });
    const myClubId = world.clubs.find((c) => c.ownerUserId === req.user!.id)?.id ?? null;
    return { fixtures: divisionFixturesView(world, comp, myClubId) };
  });

  // --- Team screen (public club profile) -----------------------------------
  // Any authenticated manager may inspect any club; the view builder enforces
  // the privacy rule (identity + results + public Footmania rank only; no
  // cash, ledger, or raw Elo rating).
  app.get("/mp/clubs/:id", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const clubId = Number((req.params as { id: string }).id);
    const profile = buildTeamProfile(loaded.world, clubId);
    if (!profile) return reply.code(404).send({ error: "Club not found" });
    return profile;
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

  // --- Friend-grouping consent (bilateral rule enforced at regrouping) -----
  app.put("/mp/club/friend-grouping", async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      // Only affects the next season's regrouping; divisions never move
      // mid-season because of a consent change.
      club.friendGroupingOptIn = parsed.data.enabled;
      recordActivity(world, req.user!.id, club.id, "friend-grouping");
      return { value: { ok: true, friendGroupingOptIn: club.friendGroupingOptIn } };
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
    pregameWindowMinutes: MP_CONFIG.pregameWindowMinutes,
    seniorSquadLimit: SENIOR_SQUAD_LIMIT,
    academyVoluntaryPromotionAge: gameConfig.playerGenerationRules.academyVoluntaryPromotionAge,
    academyAutomaticPromotionAge: gameConfig.playerGenerationRules.academyAutomaticPromotionAge,
  }));

  // Countries list for club creation.
  app.get("/mp/countries", async () => ({
    featuredCountries: FEATURED_COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
    allCountries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, strength: c.strength, featured: c.featured })),
  }));
}
