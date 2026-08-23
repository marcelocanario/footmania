import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutable, loadGlobalWorldReadOnly, persistWorld } from "../services/saveService";
import { withGlobalLock } from "../services/lock";
import { hasPro } from "../services/pro";
import { AUTOMATION_CONFIG, LOGO_CONFIG } from "../config";
import { presetsSchema, validatePresetQuotas } from "../game/automation";
import { validateNickname, normalizeNickname, nicknameSchema } from "../game/nickname";
import { validateLogoVariant, validateCustomLogo } from "../game/logo";
import { logoVariantSchema } from "../game/logo";
import { displayName } from "../game/displayName";
import { StaleWorldError } from "../services/saveService";
import { publishUserWorldEvent } from "../services/worldEvents";
import { injuryDaysRemaining } from "../game/energyInjury";
import { playerView } from "../services/snapshot";
import { matchNotificationKey } from "../services/notifications";

const nicknameBodySchema = z.object({
  nickname: z.string().nullable().optional(),
});

const logoVariantBodySchema = z.object({
  variant: z.number().int().min(0).max(Math.max(0, LOGO_CONFIG.variantCount - 1)),
});

const logoUploadBodySchema = z.object({
  mime: z.string(),
  data: z.string(),
});

const automationBodySchema = z.object({
  presets: presetsSchema,
});

export async function proFeaturesRoutes(app: FastifyInstance) {
  // ---- Logo variant (everyone) --------------------------------------------
  app.put("/mp/club/logo-variant", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const parsed = logoVariantBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid variant" });
    const err = validateLogoVariant(parsed.data.variant);
    if (err) return reply.code(400).send({ error: err });
    const res = await withGlobalLock(async () => {
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      club.logoVariant = parsed.data.variant;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
        throw e;
      }
      return { value: { ok: true, logoVariant: club.logoVariant } };
     });
     if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
     publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
     return res.value;
  });

  // Custom logo upload (Pro only)
  app.post("/mp/club/logo", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const sessionUser = await app.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!sessionUser || !hasPro(sessionUser)) return reply.code(403).send({ error: "Pro required to upload custom logo" });
    const parsed = logoUploadBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid payload" });
    const err = validateCustomLogo(parsed.data);
    if (err) return reply.code(400).send({ error: err });
    const res = await withGlobalLock(async () => {
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      club.customLogo = { mime: parsed.data.mime, data: parsed.data.data, status: "ACTIVE" };
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
        throw e;
      }
      return { value: { ok: true } };
     });
     if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
     publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
     return res.value;
  });

  app.delete("/mp/club/logo", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const res = await withGlobalLock(async () => {
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      if (!club.customLogo) return { value: { ok: true, removed: false } };
      club.customLogo = null;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
        throw e;
      }
      return { value: { ok: true, removed: true } };
     });
     if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
     publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
     return res.value;
  });

  // Serve custom logo bytes (public, long cache)
  app.get("/clubs/:clubId/logo", async (req, reply) => {
    const clubId = Number((req.params as { clubId: string }).clubId);
    if (!Number.isFinite(clubId)) return reply.code(400).send({ error: "Invalid club id" });
    const globalSave = await app.prisma.save.findFirst({ where: { isGlobal: true } });
    if (!globalSave) return reply.code(404).send({ error: "World not found" });
    const row = await app.prisma.club.findUnique({ where: { saveId_id: { saveId: globalSave.id, id: clubId } } });
    if (!row || !row.customLogoData || !row.customLogoMime || row.customLogoStatus === "REMOVED") return reply.code(404).send({ error: "No custom logo" });
    const buf = Buffer.from(row.customLogoData, "base64");
    reply.header("Content-Type", row.customLogoMime);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(buf);
  });

  // Club endpoint extension: include logo/automation in snapshot? We expose via separate endpoints.
  // But also make sure myClub snapshot includes customLogo? That's handled via saveService; snapshot service will be patched separately.

  // ---- Nickname (Pro, own players only) -----------------------------------
  app.put("/mp/players/:id/nickname", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const playerId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(playerId)) return reply.code(400).send({ error: "Invalid player id" });
    const parsed = nicknameBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const raw = parsed.data.nickname;
    // Allow clearing with null/empty
    if (raw === null || raw === undefined || raw.trim() === "") {
      const res = await withGlobalLock(async () => {
         const loaded = await loadGlobalWorldMutable(app.prisma);
        if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
        const player = loaded.world.players.find((p) => p.id === playerId);
        if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
        const club = player.clubId !== null ? loaded.world.clubs.find((c) => c.id === player.clubId) : null;
        if (!club || club.ownerUserId !== req.user!.id) return { error: { code: 403, body: { error: "You can only nickname your own players" } } };
        player.nickname = null;
        try {
          await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
        } catch (e) {
          if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
          throw e;
        }
        return { value: { ok: true, nickname: null, displayName: player.name } };
       });
       if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
       publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
       return res.value;
    }
    const normalized = normalizeNickname(raw);
    const err = validateNickname(normalized);
    if (err) return reply.code(400).send({ error: err });
    const sessionUser = await app.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!sessionUser || !hasPro(sessionUser)) return reply.code(403).send({ error: "Pro required to nickname players" });
    const res = await withGlobalLock(async () => {
         const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const player = loaded.world.players.find((p) => p.id === playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      const club = player.clubId !== null ? loaded.world.clubs.find((c) => c.id === player.clubId) : null;
      if (!club || club.ownerUserId !== req.user!.id) return { error: { code: 403, body: { error: "You can only nickname your own players" } } };
      // Optional duplicate check: nickname must be unique within squad?
      player.nickname = normalized;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
        throw e;
      }
      return { value: { ok: true, nickname: player.nickname, displayName: displayName(player) } };
     });
     if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
     publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
     return res.value;
  });

  // ---- Player history -------------------------------------------------------
  app.get("/players/:id/history", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const playerId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(playerId)) return reply.code(400).send({ error: "Invalid player id" });
    const globalSave = await app.prisma.save.findFirst({ where: { isGlobal: true } });
    if (!globalSave) return reply.code(500).send({ error: "World unavailable" });
     const worldLoaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!worldLoaded) return reply.code(500).send({ error: "World unavailable" });
    const player = worldLoaded.world.players.find((p) => p.id === playerId);
    if (!player) return reply.code(404).send({ error: "Player not found" });

    const isOwner = player.clubId !== null && worldLoaded.world.clubs.find((c) => c.id === player.clubId)?.ownerUserId === req.user!.id;
    const sessionUser = await app.prisma.user.findUnique({ where: { id: req.user!.id } });
    const pro = hasPro(sessionUser);
    let allowHistory = isOwner || pro;
    if (!allowHistory) {
      // Auction exception: active listing for this player visible to everyone
      const activeAuction = await app.prisma.transferAuction.findFirst({ where: { saveId: globalSave.id, playerId, status: "ACTIVE" } });
      const activeFA = await app.prisma.freeAgentListing.findFirst({ where: { saveId: globalSave.id, playerId, status: "ACTIVE" } });
      if (activeAuction || activeFA) allowHistory = true;
    }
    const allowSkills = isOwner || pro;

    // Past seasons (immutable write-once rows)
    const seasons = allowHistory ? await app.prisma.playerSeasonHistory.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: { seasonId: "asc" } }) : [];
    // Market movements
    const transfers = allowHistory ? await app.prisma.playerMarketTransaction.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: { timestamp: "desc" }, take: 20 }) : [];
    // Match log: latest 25 events
    const events = allowHistory ? await app.prisma.matchEvent.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: [{ id: "desc" }], take: 25 }) : [];
    // Need match context for each event: fetch matches for those event matchIds
    const matchIds = Array.from(new Set(events.map((e) => e.matchId)));
    const matches = matchIds.length > 0 ? await app.prisma.match.findMany({ where: { saveId: globalSave.id, id: { in: matchIds } } }) : [];
    const matchById = new Map(matches.map((m) => [m.id, m]));
     const gameDay = worldLoaded.world.mp.absoluteGameDay ?? worldLoaded.world.dayIndex;
    const historyEvents = events.map((e) => {
      const m = matchById.get(e.matchId);
      return {
        matchId: e.matchId,
        minute: e.minute,
        half: e.half,
        type: e.type,
        subtype: e.subtype,
        clubId: e.clubId,
        goalType: e.goalType,
        matchHomeClubId: m?.homeClubId ?? null,
        matchAwayClubId: m?.awayClubId ?? null,
        matchHomeScore: m?.homeScore ?? null,
        matchAwayScore: m?.awayScore ?? null,
      };
    });

    const view = playerView(player, undefined, gameDay);
    const clubName = player.clubId === null ? null : worldLoaded.world.clubs.find((club) => club.id === player.clubId)?.name ?? null;
    const playerPayload = allowSkills ? { ...view, clubName, isOwnTeam: isOwner } : (() => {
      const { skills: _skills, ...withoutSkills } = view;
      return { ...withoutSkills, clubName, isOwnTeam: isOwner };
    })();

    return {
       player: playerPayload,
      seasons: seasons.map((s) => ({ seasonId: s.seasonId, seasonKey: s.seasonKey, clubId: s.clubId, clubName: s.clubName, appearances: s.appearances, goals: s.goals, assists: s.assists, yellows: s.yellows, reds: s.reds, minutes: s.minutes })),
      transfers: transfers.map((t) => ({ id: t.id, type: t.type, fromClubId: t.fromClubId, toClubId: t.toClubId, price: t.price, seasonKey: t.seasonKey, contractSeasons: t.contractSeasons, contractSalary: t.contractSalary, timestamp: Number(t.timestamp) })),
      matches: historyEvents,
    };
  });

  // Auction-scoped history (public when active)
  app.get("/market/listings/:id/player-history", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const marketType = (req.query as { marketType?: string }).marketType ?? "TRANSFER";
    if (!Number.isFinite(listingId)) return reply.code(400).send({ error: "Invalid listing id" });
    const globalSave = await app.prisma.save.findFirst({ where: { isGlobal: true } });
    if (!globalSave) return reply.code(500).send({ error: "World unavailable" });
    let playerId: number | null = null;
    if (marketType === "FREE_AGENT") {
      const listing = await app.prisma.freeAgentListing.findUnique({ where: { saveId_id: { saveId: globalSave.id, id: listingId } } });
      if (!listing) return reply.code(404).send({ error: "Listing not found" });
      if (listing.status !== "ACTIVE") return reply.code(403).send({ error: "Listing not active; history requires Pro" });
      playerId = listing.playerId;
    } else {
      const listing = await app.prisma.transferAuction.findUnique({ where: { saveId_id: { saveId: globalSave.id, id: listingId } } });
      if (!listing) return reply.code(404).send({ error: "Listing not found" });
      if (listing.status !== "ACTIVE") return reply.code(403).send({ error: "Listing not active; history requires Pro" });
      playerId = listing.playerId;
    }
    if (playerId === null) return reply.code(404).send({ error: "Player not found" });
    // Reuse logic: fetch history without pro gate
     const worldLoaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!worldLoaded) return reply.code(500).send({ error: "World unavailable" });
    const player = worldLoaded.world.players.find((p) => p.id === playerId);
    if (!player) return reply.code(404).send({ error: "Player not found" });
    const seasons = await app.prisma.playerSeasonHistory.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: { seasonId: "asc" } });
    const transfers = await app.prisma.playerMarketTransaction.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: { timestamp: "desc" }, take: 20 });
    const events = await app.prisma.matchEvent.findMany({ where: { saveId: globalSave.id, playerId }, orderBy: [{ id: "desc" }], take: 25 });
    const matchIds = Array.from(new Set(events.map((e) => e.matchId)));
    const matches = matchIds.length > 0 ? await app.prisma.match.findMany({ where: { saveId: globalSave.id, id: { in: matchIds } } }) : [];
    const matchById = new Map(matches.map((m) => [m.id, m]));
    const historyEvents = events.map((e) => {
      const m = matchById.get(e.matchId);
      return { matchId: e.matchId, minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, goalType: e.goalType, matchHomeClubId: m?.homeClubId ?? null, matchAwayClubId: m?.awayClubId ?? null, matchHomeScore: m?.homeScore ?? null, matchAwayScore: m?.awayScore ?? null };
    });
    return {
      player: {
        id: player.id,
        name: player.name,
        nickname: player.nickname ?? null,
        displayName: displayName(player),
        clubId: player.clubId,
        age: player.age,
        position: player.position,
        overall: player.overall,
        careerGoals: player.careerGoals,
        careerAssists: player.careerAssists,
        seasonGoals: player.seasonGoals,
        seasonAssists: player.seasonAssists,
        yellows: player.yellows,
        reds: player.reds,
        injuryDays: injuryDaysRemaining(player, worldLoaded.world.mp.absoluteGameDay ?? worldLoaded.world.dayIndex),
        injuryDaysRemaining: injuryDaysRemaining(player, worldLoaded.world.mp.absoluteGameDay ?? worldLoaded.world.dayIndex),
        injuryCause: player.injuryCause ?? null,
      },
      seasons: seasons.map((s) => ({ seasonId: s.seasonId, seasonKey: s.seasonKey, clubId: s.clubId, clubName: s.clubName, appearances: s.appearances, goals: s.goals, assists: s.assists, yellows: s.yellows, reds: s.reds, minutes: s.minutes })),
      transfers: transfers.map((t) => ({ id: t.id, type: t.type, fromClubId: t.fromClubId, toClubId: t.toClubId, price: t.price, seasonKey: t.seasonKey, contractSeasons: t.contractSeasons, contractSalary: t.contractSalary, timestamp: Number(t.timestamp) })),
      matches: historyEvents,
    };
  });

  // ---- Automation presets -----------------------------------------------
  app.get("/mp/automation", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
     const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(500).send({ error: "World unavailable" });
    const club = loaded.world.clubs.find((c) => c.ownerUserId === req.user!.id);
    if (!club) return reply.code(404).send({ error: "No club" });
    return { presets: club.automationPresets ?? [] };
  });

  app.put("/mp/automation", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const parsed = automationBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid presets", details: parsed.error.flatten() });
    const presets = parsed.data.presets as import("../game/types").AutomationPreset[];
    // Validate IDs unique
    const ids = presets.map((p) => p.id);
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: "Duplicate preset ids" });
    for (const p of presets) {
      const ruleIds = p.rules.map((r) => r.id);
      if (new Set(ruleIds).size !== ruleIds.length) return reply.code(400).send({ error: `Duplicate rule ids in preset ${p.id}` });
    }
    const sessionUser = await app.prisma.user.findUnique({ where: { id: req.user.id } });
    const pro = hasPro(sessionUser);
    const quotaErr = validatePresetQuotas(presets, pro);
    if (quotaErr) return reply.code(403).send({ error: quotaErr });

    const res = await withGlobalLock(async () => {
       const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 500, body: { error: "World unavailable" } } };
      const club = loaded.world.clubs.find((c) => c.ownerUserId === req.user!.id);
      if (!club) return { error: { code: 404, body: { error: "No club" } } };
      // Validate SUB player ids exist (but not necessarily on club; they may be on bench)
      for (const p of presets) {
        for (const r of p.rules) {
          if (r.action.kind === "SUB") {
            const outExists = loaded.world.players.some((pl) => pl.id === r.action.outPlayerId);
            const inExists = loaded.world.players.some((pl) => pl.id === r.action.inPlayerId);
            if (!outExists || !inExists) return { error: { code: 400, body: { error: `SUB rule ${r.id} references unknown player` } } };
          }
        }
      }
      club.automationPresets = presets;
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (e) {
        if (e instanceof StaleWorldError) return { error: { code: 409, body: { error: "Concurrent update, retry" } } };
        throw e;
      }
      return { value: { ok: true, presets: club.automationPresets } };
     });
     if ("error" in res && res.error) return reply.code(res.error.code).send(res.error.body);
     publishUserWorldEvent(req.user.id, { type: "invalidate", scope: "club" });
     return res.value;
  });

  // ---- Notifications (in-app inbox) -------------------------------------
  app.get("/notifications", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const limit = Math.max(1, Math.min(100, Number((req.query as { limit?: string }).limit ?? 20) || 20));
    const unreadOnly = (req.query as { unread?: string }).unread === "1";
    const where: { userId: number; readAt?: null } = unreadOnly ? { userId: req.user.id, readAt: null } : { userId: req.user.id };
    // Fetch a small window before limiting so retries that left duplicate
    // match rows do not consume visible inbox slots. The key is deterministic
    // and also makes the feed safe for legacy duplicates already in the DB.
    const items = await app.prisma.userNotification.findMany({ where, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: Math.min(500, Math.max(limit * 5, limit)) });
    const seenMatchEvents = new Set<string>();
    const uniqueItems = items.filter((item) => {
      let payload: unknown;
      try {
        payload = JSON.parse(item.payloadJson ?? "{}");
      } catch {
        payload = {};
      }
      const key = matchNotificationKey(item.type, payload);
      if (key === null) return true;
      const scopedKey = `${item.userId}:${key}`;
      if (seenMatchEvents.has(scopedKey)) return false;
      seenMatchEvents.add(scopedKey);
      return true;
    }).slice(0, limit);
    return { notifications: uniqueItems.map((n) => {
      let payload: unknown;
      try {
        payload = JSON.parse(n.payloadJson ?? "{}");
      } catch {
        payload = {};
      }
      return { id: n.id, type: n.type, payload, createdAt: n.createdAt.toISOString(), readAt: n.readAt?.toISOString() ?? null };
    }) };
  });

  app.post("/notifications/:id/read", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const id = (req.params as { id: string }).id;
    const n = await app.prisma.userNotification.findUnique({ where: { id } });
    if (!n || n.userId !== req.user.id) return reply.code(404).send({ error: "Not found" });
    if (!n.readAt) await app.prisma.userNotification.update({ where: { id }, data: { readAt: new Date() } });
    return { ok: true };
  });

  app.post("/notifications/read-all", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    await app.prisma.userNotification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  });

  // Push subscription (Web Push) ------------------------------------------
  app.get("/push/vapid-public-key", async () => {
    const { NOTIFICATION_CONFIG } = await import("../config");
    return { publicKey: NOTIFICATION_CONFIG.vapidPublicKey ?? "" };
  });

  app.post("/push/subscribe", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const parsed = z.object({ endpoint: z.string().url(), p256dh: z.string().min(1), auth: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subscription" });
    const { endpoint, p256dh, auth } = parsed.data;
    await app.prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId: req.user.id, endpoint } },
      create: { userId: req.user.id, endpoint, p256dh, auth },
      update: { p256dh, auth },
    });
    return { ok: true };
  });

  app.post("/push/unsubscribe", async (req, reply) => {
    await app.authenticate(req, reply);
    if (!req.user) return;
    const parsed = z.object({ endpoint: z.string().url() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    await app.prisma.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint, userId: req.user.id } });
    return { ok: true };
  });
}
