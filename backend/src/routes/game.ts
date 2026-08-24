import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutable, loadGlobalWorldReadOnly, persistWorld, StaleWorldError } from "../services/saveService";
import { playerView, seasonAwardsView } from "../services/snapshot";
import { liveStateView } from "../services/liveView";
import { withGlobalLease, withGlobalLock } from "../services/lock";
import { releasePlayer } from "../game/transfers";
import { applyMaxBid, auctionOpeningRange, cancelTransferAuction, createTransferAuction, playerHasActiveListing, recentTradeBaseValue, transferCooldownError, transferAuctionView } from "../game/market";
import { applyFreeAgentBid, freeAgentListingView } from "../game/freeAgents";
import { cancelLoanListing, claimLoan, claimableInSeconds, offerPlayerForLoan } from "../game/loans";
import { getCommitmentTotals, getImmediateAvailableCash, financialState, remainingSeasonFraction } from "../game/finance";
import { calculateReleaseClause, contractDaysForTerm, remainingSeasons } from "../game/economy";
import { resetPayrollPeriod, settlePlayerPayroll } from "../game/payroll";
import { applyLiveTacticsUpdate, performLiveSub, isPregame, isHalftime, rebuildLiveHumanLineup, markHalftimeReady } from "../game/match";
import { recordActivity } from "../game/multiplayer";
import { hasPro } from "../services/pro";
import { FORMATION_POSITIONS, TACTICAL_POSITION_NAMES } from "../game/constants";
import { conditionLabel, injuryDaysRemaining } from "../game/energyInjury";
import { lineupForMatch, peekLineup, applySavedLineup } from "../game/club";
import { contractDemand, dismissYouthPlayer, promoteYouthPlayer } from "../game/season";
import { setPlayerSquadNumber } from "../game/squadNumbers";
import { NEWS_SUBJECTS, publishNews } from "../game/news";
import { divisionForClub, lowestActiveTier } from "../game/multiplayer";
import { gameConfig } from "../config";
import type { Tactics, World } from "../game/types";
import {
  canonicalFromClub,
  decayedStoredFamiliarity,
  effectiveFamiliarity,
  recordSwitch,
  setupKey,
  switchFamiliarity,
} from "../game/familiarity";
import { materializeSeasonEvents } from "../services/scheduler";
import { isPaused, worldPausedError } from "../services/seasonPause";
import { createNotification } from "../services/notifications";
import { marketUpdatedEvents } from "../services/marketEvents";
import { publishUserWorldEvent, type UserWorldEvent } from "../services/worldEvents";

const auctionCreateSchema = z.object({ playerId: z.number().int(), openingPrice: z.number().int().positive().optional() });
const maxBidSchema = z.object({ maxBid: z.number().int().positive(), contractSeasons: z.number().int().min(1).max(gameConfig.maxContractSeasons) });
const loanCreateSchema = z.object({
  playerId: z.number().int(),
  // Lender-chosen claim fee as a fraction of the player's value (§55). The
  // configured band is enforced server-side in offerPlayerForLoan.
  feeRatio: z.number().min(0).max(1).optional(),
});

const contractSchema = z.object({
  length: z.number().int().min(1).max(gameConfig.maxContractSeasons),
});

const tacticsSchema = z.object({
  formation: z.number().int().min(0).max(12).optional(),
  style: z.number().int().min(0).max(2),
  pressing: z.number().int().min(0).max(2),
  direction: z.number().int().min(0).max(1),
});

const liveTacticsSchema = z.object({
  style: z.number().int().min(0).max(2).optional(),
  pressing: z.number().int().min(0).max(2).optional(),
  direction: z.number().int().min(0).max(1).optional(),
}).strict().refine((value) => value.style !== undefined || value.pressing !== undefined || value.direction !== undefined, "At least one tactic is required");

const academyActionSchema = z.object({ action: z.enum(["promote", "dismiss"]) });

const trainingSchema = z.object({ focus: z.enum(["assistant", "primary", "secondary"]) });

const lineupSchema = z.object({
  formation: z.number().int().min(0).max(12),
  starters: z.array(z.number().int()).length(11),
  subs: z.array(z.number().int()).max(11),
  penaltyTakerId: z.number().int().nullable(),
  freeKickTakerId: z.number().int().nullable(),
});

function userClub(world: World, userId: number) {
  return world.clubs.find((c) => c.ownerUserId === userId) ?? null;
}

function humanUserIds(world: World): number[] {
  return world.clubs.flatMap((club) => club.ownerUserId === null ? [] : [club.ownerUserId]);
}

interface WorldMutationResult {
  error?: { code: number; body: unknown };
  value?: unknown;
  userEvents?: { userId: number; event: UserWorldEvent }[];
  notifications?: { userId: number; type: string; payload: unknown }[];
}

async function withWorld(
  app: FastifyInstance,
  userId: number,
  activity: string,
  fn: (world: World, clubId: number) => Promise<WorldMutationResult>
) {
  return withGlobalLock(() => withGlobalLease(app.prisma, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await loadGlobalWorldMutable(app.prisma);
      if (!loaded) return { error: { code: 404, body: { error: "World not found" } } };
      const club = userClub(loaded.world, userId);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      const res = await fn(loaded.world, club.id);
      if (res.error) return res;
      recordActivity(loaded.world, userId, club.id, activity);
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
        await materializeSeasonEvents(app.prisma, loaded.save.id, loaded.world);
        for (const notification of res.notifications ?? []) {
          await createNotification(app.prisma, notification.userId, notification.type, notification.payload);
        }
        for (const item of res.userEvents ?? []) publishUserWorldEvent(item.userId, item.event);
        const transferChanged = activity.startsWith("transfer_") || activity === "free_agent_bid" || activity.startsWith("loan_") || activity === "release_player";
        if (transferChanged) {
          const isBid = activity === "transfer_auction_bid" || activity === "free_agent_bid";
          for (const affectedUserId of humanUserIds(loaded.world)) {
            if (affectedUserId === userId) publishUserWorldEvent(affectedUserId, { type: "invalidate", scope: "club" });
            if (!isBid) publishUserWorldEvent(affectedUserId, { type: "invalidate", scope: "transfers" });
          }
        } else {
          publishUserWorldEvent(userId, { type: "invalidate", scope: "club" });
        }
        return { value: res.value };
      } catch (error) {
        if (!(error instanceof StaleWorldError) || attempt === 2) throw error;
      }
    }
    throw new Error("World mutation could not be committed");
  }));
}

export async function gameRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    await app.authenticate(req, reply);
  });

  app.get("/matches/:id/events", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const matchId = Number((req.params as { id: string }).id);
    const match = loaded.world.matches.find((m) => m.id === matchId);
    if (!match) return reply.code(404).send({ error: "Match not found" });
    const home = loaded.world.clubs.find((c) => c.id === match.homeClubId);
    const away = loaded.world.clubs.find((c) => c.id === match.awayClubId);
    // Detailed match stats are a Pro feature; the gate is enforced server-side.
    // req.user.isPro is already the isPro||isAdmin value computed once at
    // auth time (plugins/auth.ts) — no need to re-fetch and recompute it.
    const isPro = hasPro(req.user);
    const events = match.events.map((e) => ({
      minute: e.minute,
      half: e.half,
        type: e.type,
        subtype: e.subtype,
        clubId: e.clubId,
        playerId: e.playerId ?? null,
        player2Id: e.player2Id ?? null,
        player: e.playerId ? loaded.world.players.find((p) => p.id === e.playerId)?.name ?? "" : "",
      player2: e.player2Id ? loaded.world.players.find((p) => p.id === e.player2Id)?.name ?? "" : "",
      addedTime: (e as { addedTime?: number }).addedTime ?? null,
      // Injury events carry the estimated days out in goalType.
      goalType: e.goalType,
    }));
    return {
      match: {
        id: match.id,
        home: home?.name ?? "",
        away: away?.name ?? "",
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        // Null for regular users; the UI shows a locked tab instead.
        stats: isPro ? match.stats : null,
      },
      events,
    };
  });

  app.get("/matches/:id/live", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const matchId = Number((req.params as { id: string }).id);
    const st = loaded.world.liveMatches.find((s) => s.matchId === matchId);
    if (!st) return reply.code(404).send({ error: "No live match in progress" });
    return { state: liveStateView(loaded.world, st, req.user!.id) };
  });

  app.post("/matches/:id/sub", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const parsed = z.object({ outId: z.number().int(), inId: z.number().int() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
      const res = await withWorld(app, req.user!.id, "match_sub", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
        if (st.ended) return { error: { code: 400, body: { error: "Match already finished" } } };
        if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
          return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
        }
        const home = world.clubs.find((c) => c.id === st.homeClubId)!;
      const away = world.clubs.find((c) => c.id === st.awayClubId)!;
      const side = st.homeClubId === clubId ? 0 : 1;
      const result = performLiveSub(world.rng, home, away, world.players, st, side, parsed.data.outId, parsed.data.inId);
      if (result.error) return { error: { code: 400, body: { error: result.error } } };
      return { value: { event: result.event, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/tactics", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const parsed = liveTacticsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid tactics" });
    const res = await withWorld(app, req.user!.id, "match_tactics", async (world, clubId) => {
      const st = world.liveMatches.find((candidate) => candidate.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
        return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
      }
      const side = st.homeClubId === clubId ? 0 : 1;
      const sideClub = world.clubs.find((c) => c.id === clubId)!;
      const error = applyLiveTacticsUpdate(st, side, parsed.data, {
        familiarityMap: sideClub.tacticFamiliarity,
        absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex,
      });
      if (error) return { error: { code: 400, body: { error } } };
      return { value: { ok: true, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/halftime/ready", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "halftime_ready", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (!isHalftime(st)) return { error: { code: 400, body: { error: "Match is not at halftime" } } };
      if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
        return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
      }
      const side = st.homeClubId === clubId ? 0 : 1;
      markHalftimeReady(world, st, side as 0 | 1);
      return { value: { ok: true, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.get("/club/lineup", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    const query = req.query as Record<string, unknown>;
    const auto = String(query.auto ?? "") === "1";
    const formationParam = query.formation;
    const formationRaw = typeof formationParam === "string" && formationParam.trim() !== "" ? Number(formationParam) : Number.NaN;
    const formation = Number.isInteger(formationRaw) && formationRaw >= 0 && formationRaw <= 12 ? formationRaw : club.tactics.formation;
    const lineup = peekLineup(
      { ...club, savedLineup: auto ? null : club.savedLineup, tactics: { ...club.tactics, formation } },
      loaded.world.players
    );
    const players = loaded.world.players.filter((p) => p.clubId === club.id);
    const gameDay = loaded.world.mp.absoluteGameDay ?? loaded.world.dayIndex;
    const view = (id: number) => {
      const p = players.find((x) => x.id === id);
      return p
        ? {
            id: p.id,
            name: p.name,
            position: p.position,
            overall: p.overall,
            energy: p.energy,
            injuryDays: injuryDaysRemaining(p, gameDay),
            injuryDaysRemaining: injuryDaysRemaining(p, gameDay),
            injuryCause: p.injuryCause ?? null,
            injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
            conditionLabel: conditionLabel(p, gameDay),
            suspended: p.suspendedGames > 0,
          }
        : null;
    };
    return {
      formation,
      starters: (lineup?.starters ?? []).map((p) => view(p.id)),
      subs: (lineup?.subs ?? []).map((p) => view(p.id)),
      penaltyTakerId: club.penaltyTakerId,
      freeKickTakerId: club.savedLineup?.freeKickTakerId ?? null,
      slots: FORMATION_POSITIONS[formation] ?? FORMATION_POSITIONS[4],
      squad: players
        .sort((a, b) => b.overall - a.overall)
        .map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          overall: p.overall,
          energy: p.energy,
          tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "",
          injuryDays: injuryDaysRemaining(p, gameDay),
          injuryDaysRemaining: injuryDaysRemaining(p, gameDay),
          injuryCause: p.injuryCause ?? null,
          injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
          conditionLabel: conditionLabel(p, gameDay),
          suspended: p.suspendedGames > 0,
        })),
    };
  });

  app.post("/club/lineup", async (req, reply) => {
    const parsed = lineupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "lineup", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const err = applySavedLineup(club, world.players, parsed.data);
      if (err) return { error: { code: 400, body: { error: err } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/lineup", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const parsed = lineupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "match_lineup", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (!isPregame(st) && !isHalftime(st)) return { error: { code: 400, body: { error: "The match already started" } } };
      const club = world.clubs.find((c) => c.id === clubId)!;
      const err = applySavedLineup(club, world.players, parsed.data);
      if (err) return { error: { code: 400, body: { error: err } } };
      rebuildLiveHumanLineup(st, club, world.players, { absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex });
      return { value: { ok: true, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/auctions", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    return { auctions: loaded.world.transferAuctions.filter((a) => a.status === "ACTIVE").map((a) => transferAuctionView(loaded.world, a, myClubId)) };
  });

  // Schedule-dependent: blocked while the season is paused.
  app.post("/transfers/auctions", async (req, reply) => {
    const parsed = auctionCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "transfer_auction_create", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const player = world.players.find((candidate) => candidate.id === parsed.data.playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      const result = createTransferAuction(world, {
        player,
        sellerClub: club,
        sellerDivision: divisionForClub(world, club.id),
        totalDivisions: Math.max(1, lowestActiveTier(world, world.mp.seasonId)),
        openingPrice: parsed.data.openingPrice,
      });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, listingId: result.listing.id, openingPrice: result.listing.openingPrice } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/auctions/preview", async (req, reply) => {
    const playerId = Number((req.query as { playerId?: string }).playerId);
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const player = loaded.world.players.find((candidate) => candidate.id === playerId);
    if (!player) return reply.code(404).send({ error: "Player not found" });
    const range = auctionOpeningRange(loaded.world, player);
    const alreadyListed = loaded.world.transferAuctions.some((a) => a.playerId === player.id && a.status === "ACTIVE") || loaded.world.freeAgentListings.some((a) => a.playerId === player.id && a.status === "ACTIVE") || player.loanId !== null;
    return { playerId, value: player.value, baseValue: Math.round(recentTradeBaseValue(loaded.world, player)), openingPriceRange: range, cooldownError: transferCooldownError(loaded.world, player), alreadyListed };
  });

  app.post("/transfers/auctions/:id/bid", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const parsed = maxBidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "transfer_auction_bid", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const listing = world.transferAuctions.find((candidate) => candidate.id === listingId);
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const player = listing ? world.players.find((candidate) => candidate.id === listing.playerId) : undefined;
      if (!listing || !player) return { error: { code: 404, body: { error: "Auction not found" } } };
      const result = applyMaxBid(world, {
        listing,
        club,
        player,
        proposedMaximum: parsed.data.maxBid,
        buyerDivision: divisionForClub(world, club.id),
        immediateAvailableCash: getImmediateAvailableCash(world, club),
        contractSeasons: parsed.data.contractSeasons,
      });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      const outbidClub = result.outbidClubId === undefined
        ? undefined
        : world.clubs.find((candidate) => candidate.id === result.outbidClubId);
      return {
        value: {
          ok: true,
          currentPrice: result.currentPrice,
          leading: result.leading,
          contractSeasons: result.contractSeasons,
          contractSalary: result.contractSalary,
        },
        userEvents: [
          ...marketUpdatedEvents(world, "TRANSFER", listing.id),
          ...(outbidClub?.ownerUserId
            ? [{ userId: outbidClub.ownerUserId, event: { type: "invalidate" as const, scope: "club" } }]
            : []),
        ],
        notifications: outbidClub?.ownerUserId
          ? [{ userId: outbidClub.ownerUserId, type: "MARKET_OUTBID", payload: { listingId: listing.id, marketType: "TRANSFER", currentPrice: listing.currentPrice } }]
          : [],
      };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/auctions/:id/cancel", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "transfer_auction_cancel", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const listing = world.transferAuctions.find((candidate) => candidate.id === listingId);
      if (!listing) return { error: { code: 404, body: { error: "Auction not found" } } };
      if (listing.sellerClubId !== clubId) return { error: { code: 403, body: { error: "Only the seller can cancel this auction" } } };
      const result = cancelTransferAuction(world, listing);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/free-agents", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    return { signings: loaded.world.freeAgentListings.filter((listing) => listing.status === "ACTIVE").map((listing) => freeAgentListingView(loaded.world, listing, myClubId)) };
  });

  app.post("/transfers/free-agents/:id/bid", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const parsed = maxBidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "free_agent_bid", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const listing = world.freeAgentListings.find((candidate) => candidate.id === listingId);
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const player = listing ? world.players.find((candidate) => candidate.id === listing.playerId) : undefined;
      if (!listing || !player) return { error: { code: 404, body: { error: "Free-agent listing not found" } } };
      const result = applyFreeAgentBid(world, { listing, club, player, proposedMaximum: parsed.data.maxBid, immediateAvailableCash: getImmediateAvailableCash(world, club), contractSeasons: parsed.data.contractSeasons });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      const outbidClub = result.outbidClubId === undefined
        ? undefined
        : world.clubs.find((candidate) => candidate.id === result.outbidClubId);
      return {
        value: {
          ok: true,
          currentPrice: result.currentPrice,
          leading: result.leading,
          contractSeasons: result.contractSeasons,
          contractSalary: result.contractSalary,
        },
        userEvents: [
          ...marketUpdatedEvents(world, "FREE_AGENT", listing.id),
          ...(outbidClub?.ownerUserId
            ? [{ userId: outbidClub.ownerUserId, event: { type: "invalidate" as const, scope: "club" } }]
            : []),
        ],
        notifications: outbidClub?.ownerUserId
          ? [{ userId: outbidClub.ownerUserId, type: "MARKET_OUTBID", payload: { listingId: listing.id, marketType: "FREE_AGENT", currentPrice: listing.currentPrice } }]
          : [],
      };
    });
    return replyFrom(res, reply);
  });

  app.post("/players/:id/contract", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
    const parsed = contractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "contract", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === playerId);
      if (!player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      if (player.isYouth) return { error: { code: 400, body: { error: "Youth players cannot renew a contract" } } };
      if (player.loanId !== null) return { error: { code: 400, body: { error: "A player on loan cannot renew his contract" } } };
      if (playerHasActiveListing(world, player)) return { error: { code: 400, body: { error: "A player with an active market listing cannot renew his contract" } } };
      const seasons = parsed.data.length;
      if (seasons < 1 || seasons > gameConfig.maxContractSeasons) {
        return { error: { code: 400, body: { error: `Contract length must be between 1 and ${gameConfig.maxContractSeasons} seasons` } } };
      }
      const demand = contractDemand(player, seasons, remainingSeasonFraction(world));
      settlePlayerPayroll(world, player);
      resetPayrollPeriod(player, world.dayIndex);
      player.salary = demand;
      player.contractDays = contractDaysForTerm(seasons);
      player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
      publishNews(world, {
        kind: "contract",
        subject: NEWS_SUBJECTS.contractRenewal,
        recipientClubId: club.id,
        headline: "Contract agreed",
        entries: [{ key: `renew:${player.id}`, label: player.name, detail: `signed a new contract for ${seasons} more ${seasons === 1 ? "season" : "seasons"}` }],
      });
      return { value: { ok: true, demand } };
    });
    return replyFrom(res, reply);
  });

  app.get("/players/:id/contract", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    const player = loaded?.world.players.find((p) => p.id === Number((req.params as { id: string }).id));
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    if (!player) return reply.code(404).send({ error: "Player not found" });
    const maxSeasons = gameConfig.maxContractSeasons;
    const fraction = remainingSeasonFraction(loaded.world);
    const demandsBySeason = Object.fromEntries(
      Array.from({ length: maxSeasons }, (_, i) => [i + 1, contractDemand(player, i + 1, fraction)])
    );
    return {
      demand: demandsBySeason[1] ?? player.salary,
      demandsBySeason,
      salary: player.salary,
      contractDays: player.contractDays,
    };
  });

  // Squad number reassignment. Taking a squadmate's number swaps the two.
  app.post("/players/:id/number", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
    const parsed = z.object({ number: z.number().int().min(1).max(99).nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Number must be between 1 and 99" });
    if (parsed.data.number === null) return reply.code(400).send({ error: "Every player needs a number" });
    const res = await withWorld(app, req.user!.id, "squad_number", async (world, clubId) => {
      const player = world.players.find((p) => p.id === playerId);
      if (!player || player.clubId !== clubId) return { error: { code: 400, body: { error: "Player not in your squad" } } };
      // A number already worn by a squadmate swaps with this player.
      const squadmate = world.players.find((p) => p.clubId === clubId && p.squadNumber === parsed.data.number && p.id !== playerId) ?? null;
      const result = setPlayerSquadNumber(world, playerId, parsed.data.number!);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, number: player.squadNumber ?? null, swappedWithName: squadmate?.name ?? null } };
    });
    return replyFrom(res, reply);
  });

  app.post("/players/:id/academy", async (req, reply) => {    const playerId = Number((req.params as { id: string }).id);
    const parsed = academyActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "academy", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === playerId);
      if (!player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in your youth academy" } } };
      const result = parsed.data.action === "promote" ? promoteYouthPlayer(world, player) : dismissYouthPlayer(world, player);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/players/:id/release", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "release_player", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === playerId);
      if (!club || !player) return { error: { code: 404, body: { error: "Player not found" } } };
      const result = releasePlayer(world, player, club);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, cost: result.cost } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/tactics", async (req, reply) => {
    const parsed = tacticsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "tactics", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const nextTactics: Tactics = {
        formation: parsed.data.formation !== undefined ? parsed.data.formation : club.tactics.formation,
        style: parsed.data.style,
        pressing: parsed.data.pressing,
        direction: parsed.data.direction,
      };
      const unchanged =
        nextTactics.formation === club.tactics.formation &&
        nextTactics.style === club.tactics.style &&
        nextTactics.pressing === club.tactics.pressing &&
        nextTactics.direction === club.tactics.direction;
      // Saving the exact same setup is a no-op: it must not churn news nor
      // re-roll familiarity through the §17 switch transfer.
      if (unchanged) return { value: { ok: true } };
      const gameDay = world.mp.absoluteGameDay ?? world.dayIndex;
      const srcValue = effectiveFamiliarity(club, gameDay);
      const dstDecayed = decayedStoredFamiliarity(club.tacticFamiliarity, setupKey(nextTactics), gameDay);
      // The abandoned setup keeps its stored progress; only the destination
      // entry gains the transferred value (game/familiarity.ts recordSwitch).
      recordSwitch(club, nextTactics, switchFamiliarity(srcValue, canonicalFromClub(club.tactics), canonicalFromClub(nextTactics), dstDecayed));
      club.tactics = nextTactics;
      publishNews(world, {
        kind: "tactics",
        subject: NEWS_SUBJECTS.tactics,
        recipientClubId: club.id,
        headline: "New tactical setup",
        entries: [{ key: `tactics:${world.dayIndex}`, label: club.name, detail: "adopted new tactics" }],
      });
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/training", async (req, reply) => {
    const parsed = trainingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid training focus" });
    const res = await withWorld(app, req.user!.id, "training", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      club.trainingFocus = parsed.data.focus;
      return { value: { ok: true, trainingFocus: club.trainingFocus } };
    });
    return replyFrom(res, reply);
  });

  app.get("/club/finances", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    const totals = getCommitmentTotals(loaded.world, club);
    return {
      cash: club.cash,
      income: club.ledger.income.slice(-30).reverse(),
      expense: club.ledger.expense.slice(-30).reverse(),
      finance: {
        activeBidCommitments: totals.activeBidCommitments,
        remainingSalaryCommitments: totals.remainingSalaryCommitments,
        contingentSalary: totals.contingentSalary,
        financialCushion: totals.financialCushion,
        immediateAvailableCash: totals.immediateAvailableCash,
        remainingSeasonFraction: club.competitionState === "PROVISIONAL" ? 1 : remainingSeasonFraction(loaded.world),
        status: financialState(loaded.world, club),
        nextPayroll: nextPayrollTimestamp(loaded.world),
      },
    };
  });

  app.get("/club/finance-details", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    return {
      records: loaded.world.records,
      awards: seasonAwardsView(loaded.world).slice(0, 20),
    };
  });

  app.get("/transfers/loans", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    const now = Date.now();
    const gameDay = loaded.world.mp.absoluteGameDay ?? loaded.world.dayIndex;
    const loans = loaded.world.loans.filter((l) => !l.recalled).map((loan) => {
      const player = loaded.world.players.find((p) => p.id === loan.playerId);
      const from = loaded.world.clubs.find((c) => c.id === loan.fromClubId);
      const to = loan.toClubId === null ? null : loaded.world.clubs.find((c) => c.id === loan.toClubId);
      return {
        ...loan,
        player: player ? playerView(player, undefined, gameDay) : null,
        fromClub: from?.name ?? "",
        toClub: to?.name ?? null,
        available: loan.toClubId === null && loan.fromClubId !== myClubId,
        claimableIn: claimableInSeconds(loan, now),
      };
    });
    return { loans };
  });

  app.post("/transfers/loans", async (req, reply) => {
    const parsed = loanCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "loan_offer", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const player = world.players.find((candidate) => candidate.id === parsed.data.playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      const result = offerPlayerForLoan(world, club, player, { feeRatio: parsed.data.feeRatio });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, loan: result.loan } };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/loans/:id/claim", async (req, reply) => {
    const loanId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "loan_claim", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const loan = world.loans.find((candidate) => candidate.id === loanId);
      if (!loan) return { error: { code: 404, body: { error: "Loan not found" } } };
      const result = claimLoan(world, club, loan);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, loan: result.loan } };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/loans/:id/cancel", async (req, reply) => {
    const loanId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "loan_cancel", async (world, clubId) => {
      if (isPaused(world)) return { error: worldPausedError };
      const club = world.clubs.find((candidate) => candidate.id === clubId)!;
      const loan = world.loans.find((candidate) => candidate.id === loanId);
      if (!loan) return { error: { code: 404, body: { error: "Loan not found" } } };
      const result = cancelLoanListing(world, club, loan);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });
}

/** Real timestamp of the next payroll cycle (UTC midnight of that game-day). */
export function nextPayrollTimestamp(world: World): number | null {
  const interval = gameConfig.payrollIntervalDays;
  const dayIndex = world.mp.seasonDayIndex ?? world.dayIndex;
  let nextIndex = (Math.floor(dayIndex / interval) + 1) * interval - 1;
  if (nextIndex <= dayIndex) nextIndex += interval;
  const seasonStart = world.mp.seasonStartAt ?? Date.UTC(world.mp.seasonYear, world.mp.seasonMonth - 1, 1);
  if (nextIndex < gameConfig.seasonDays) return seasonStart + nextIndex * 24 * 60 * 60 * 1000;
  // Payroll resumes on the first interval day of the next game season.
  return seasonStart + (gameConfig.seasonDays + interval - 1) * 24 * 60 * 60 * 1000;
}

function replyFrom(res: { error?: { code: number; body: unknown }; value?: unknown }, reply: import("fastify").FastifyReply) {
  if (res.error) return reply.code(res.error.code).send(res.error.body);
  return res.value;
}
