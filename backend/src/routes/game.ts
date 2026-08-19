import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorld, persistWorld, StaleWorldError } from "../services/saveService";
import { competitionTable, playerView } from "../services/snapshot";
import { liveStateView } from "../services/liveView";
import { multiplayerDayLabel } from "../game/calendar";
import { withGlobalLock } from "../services/lock";
import { releasePlayer } from "../game/transfers";
import { calculateReleaseClause, remainingSeasons } from "../game/economy";
import { resetPayrollPeriod, settlePlayerPayroll } from "../game/payroll";
import { performLiveSub, isPregame, isHalftime, rebuildLiveHumanLineup, matchRepsForDivisions } from "../game/match";
import { advanceLiveMatches, roundLabelFor, findCompetition } from "../game/world";
import { lowestActiveTier, recordActivity, divisionForClub } from "../game/multiplayer";
import { FORMATION_POSITIONS, TACTICAL_POSITION_NAMES } from "../game/constants";
import { peekLineup, applySavedLineup } from "../game/club";
import { contractDemand, dismissYouthPlayer, promoteYouthPlayer, startStadiumUpgrade } from "../game/season";
import { cancelLoanListing, claimLoan, claimableInSeconds, offerPlayerForLoan } from "../game/loans";
import { gameConfig } from "../config";
import type { World } from "../game/types";
import { TICKET_PRICES } from "../game/constants";
import { divisionTicketTier } from "../game/club";
import {
  applyMaxBid,
  auctionOpeningRange,
  cancelTransferAuction,
  createTransferAuction,
  expireDueListings,
  recentTradeBaseValue,
  safeMarketBudget,
  settleDueTransferAuctions,
  transferAuctionView,
  transferCooldownError,
} from "../game/market";
import {
  applyFreeAgentBid,
  freeAgentListingView,
  relistDueFreeAgents,
  settleDueFreeAgentListings,
} from "../game/freeAgents";

const contractSchema = z.object({
  length: z.number().int().min(1).max(gameConfig.maxContractSeasons),
  salary: z.number().int().min(0),
});

const tacticsSchema = z.object({
  formation: z.number().int().min(0).max(12).optional(),
  style: z.number().int().min(0).max(2),
  pressing: z.number().int().min(0).max(2),
  direction: z.number().int().min(0).max(1),
});

const playerLoanSchema = z.object({ action: z.enum(["offer", "take", "recall"]) });
const academyActionSchema = z.object({ action: z.enum(["promote", "dismiss"]) });
const ticketSchema = z.object({ prices: z.array(z.number().int().min(1)).length(4) });

const trainingSchema = z.object({ focus: z.enum(["assistant", "primary", "secondary"]) });

const lineupSchema = z.object({
  formation: z.number().int().min(0).max(12),
  starters: z.array(z.number().int()).length(11),
  subs: z.array(z.number().int()).max(11),
  penaltyTakerId: z.number().int().nullable(),
  freeKickTakerId: z.number().int().nullable(),
});

const liveTickSchema = z.object({
  minutes: z.number().int().min(1).max(10).default(1),
  resume: z.boolean().optional(),
});

function userClub(world: World, userId: number) {
  return world.clubs.find((c) => c.ownerUserId === userId) ?? null;
}

/**
 * A club's division number for the current season (§10/§102.13.3). Division 1
 * is the strongest; higher numbers are weaker. Resolved from membership state
 * (standings / MpClubSeason) — never from a stored club-level field.
 */
function divisionFor(world: World, club: World["clubs"][number]): number {
  return divisionForClub(world, club.id);
}

/** The current pyramid depth (total number of divisions, Dmax). */
function totalDivisionsFor(world: World): number {
  return lowestActiveTier(world, world.mp.seasonId);
}

async function withWorld(
  app: FastifyInstance,
  userId: number,
  activity: string,
  fn: (world: World, clubId: number) => Promise<{ error?: { code: number; body: unknown }; value?: unknown }>
) {
  return withGlobalLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await loadGlobalWorld(app.prisma);
      if (!loaded) return { error: { code: 404, body: { error: "World not found" } } };
      const club = userClub(loaded.world, userId);
      if (!club) return { error: { code: 400, body: { error: "You have no club" } } };
      if (club.competitionState === "DORMANT") {
        return { error: { code: 409, body: { error: "Your club is dormant; return it to the pyramid first" } } };
      }
      const res = await fn(loaded.world, club.id);
      if (res.error) return res;
      recordActivity(loaded.world, userId, club.id, activity);
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

export async function gameRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    await app.authenticate(req, reply);
  });

  app.get("/competitions/:id/table", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const compId = Number((req.params as { id: string }).id);
    const comp = loaded.world.competitions.find((c) => c.id === compId);
    if (!comp) return reply.code(404).send({ error: "Competition not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    return { competition: { id: comp.id, name: comp.name, kind: comp.kind, stage: comp.stage }, table: competitionTable(loaded.world, comp, myClubId) };
  });

  app.get("/competitions/:id/fixtures", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const compId = Number((req.params as { id: string }).id);
    const comp = loaded.world.competitions.find((c) => c.id === compId);
    if (!comp) return reply.code(404).send({ error: "Competition not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    const fixtures = loaded.world.fixtures
      .filter((f) => f.competitionId === compId)
      .sort((a, b) => a.round - b.round || (a.leg ?? 0) - (b.leg ?? 0) || a.dayIndex - b.dayIndex)
      .map((f) => {
        const home = loaded.world.clubs.find((c) => c.id === f.homeClubId);
        const away = loaded.world.clubs.find((c) => c.id === f.awayClubId);
        const m = loaded.world.matches.find((x) => x.fixtureId === f.id);
        return {
          id: f.id,
          round: f.round,
          roundLabel: roundLabelFor(comp, f.round),
          leg: f.leg ?? 1,
          home: home?.name ?? f.homeClubNameSnapshot ?? "",
          away: away?.name ?? f.awayClubNameSnapshot ?? "",
          dayLabel: multiplayerDayLabel(f.dayIndex),
          dayIndex: f.dayIndex,
          kickoffAt: f.kickoffAt ?? null,
          played: f.played,
          homeScore: m?.homeScore,
          awayScore: m?.awayScore,
          isHuman: myClubId !== null && (f.homeClubId === myClubId || f.awayClubId === myClubId),
        };
      });
    return { competition: { id: comp.id, name: comp.name }, fixtures };
  });

  app.get("/matches/:id/events", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const matchId = Number((req.params as { id: string }).id);
    const match = loaded.world.matches.find((m) => m.id === matchId);
    if (!match) return reply.code(404).send({ error: "Match not found" });
    const home = loaded.world.clubs.find((c) => c.id === match.homeClubId);
    const away = loaded.world.clubs.find((c) => c.id === match.awayClubId);
    const fixture = loaded.world.fixtures.find((candidate) => candidate.id === match.fixtureId);
    const events = match.events.map((e) => ({
      minute: e.minute,
      half: e.half,
      type: e.type,
      subtype: e.subtype,
      clubId: e.clubId,
      player: e.playerId ? loaded.world.players.find((p) => p.id === e.playerId)?.name ?? "" : "",
      player2: e.player2Id ? loaded.world.players.find((p) => p.id === e.player2Id)?.name ?? "" : "",
    }));
    return {
      match: {
        id: match.id,
        home: home?.name ?? fixture?.homeClubNameSnapshot ?? "",
        away: away?.name ?? fixture?.awayClubNameSnapshot ?? "",
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        stats: match.stats,
        attendance: match.attendance,
        gateRevenue: match.gateRevenue,
      },
      events,
    };
  });

  app.get("/matches/:id/live", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const matchId = Number((req.params as { id: string }).id);
    const st = loaded.world.liveMatches.find((s) => s.matchId === matchId);
    if (!st) return reply.code(404).send({ error: "No live match in progress" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club || (st.homeClubId !== club.id && st.awayClubId !== club.id)) {
      return reply.code(403).send({ error: "You are not a participant in this match" });
    }
    return { state: liveStateView(loaded.world, st, req.user!.id) };
  });

  app.post("/matches/:id/tick", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const parsed = liveTickSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "match_tick", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
        return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
      }
      // The worker owns the match clock. A client tick only requests a fresh
      // server-authoritative state and may advance time that is already due.
      advanceLiveMatches(world, Date.now());
      return { value: { events: [], atHalfTime: isHalftime(st), state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
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
      const result = performLiveSub(world.rng, home, away, world.players, st, side, parsed.data.outId, parsed.data.inId, matchRepsForDivisions(divisionForClub(world, home.id), divisionForClub(world, away.id)));
      if (result.error) return { error: { code: 400, body: { error: result.error } } };
      return { value: { event: result.event, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/finish", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "match_finish", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
        return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
      }
      advanceLiveMatches(world, Date.now());
      if (!st.ended) return { error: { code: 409, body: { error: "Match is still in progress" } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.get("/club/lineup", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
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
    const view = (id: number) => {
      const p = players.find((x) => x.id === id);
      return p
        ? {
            id: p.id,
            name: p.name,
            position: p.position,
            overall: p.overall,
            energy: p.energy,
            injuryDays: p.injuryDays,
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
        .map((p) => ({ id: p.id, name: p.name, position: p.position, overall: p.overall, tacPosName: TACTICAL_POSITION_NAMES[p.tacPos] ?? "", injuryDays: p.injuryDays, suspended: p.suspendedGames > 0 })),
    };
  });

  app.post("/club/lineup", async (req, reply) => {
    const parsed = lineupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "lineup", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const err = applySavedLineup(club, world.players, parsed.data);
      if (err) return { error: { code: 400, body: { error: err } } };
      world.news.push({ dayIndex: world.dayIndex, text: `${club.name} confirmed the lineup`, kind: "tactics" });
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
      rebuildLiveHumanLineup(st, club, world.players);
      return { value: { ok: true, state: liveStateView(world, st, req.user!.id) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/sell", async (req, reply) => {
    // Legacy route (plan §74): clients must use listing-id based routes.
    return reply.code(410).send({ error: "Use POST /transfers/auctions to list a player for auction." });
  });

  app.post("/transfers/bid", async (req, reply) => {
    return reply.code(410).send({ error: "Direct transfers are no longer supported. Use the auction market." });
  });

  // List a player for public auction (new market route). Exact route naming
  // follows plan §74 conventions (listing-id based operations). The seller may
  // choose the opening asking price within the permitted base-value range
  // (§64.1); omitted → the base value is used.
  app.post("/transfers/auctions", async (req, reply) => {
    const parsed = z
      .object({
        playerId: z.number().int(),
        openingPrice: z.number().int().positive().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "transfer_list_auction", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === parsed.data.playerId);
      if (!player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      if (player.isYouth) return { error: { code: 400, body: { error: "Youth players cannot be listed for auction" } } };
      if (player.loanId !== null) return { error: { code: 400, body: { error: "A player on loan cannot be sold" } } };
      const result = createTransferAuction(world, {
        player,
        sellerClub: club,
        sellerDivision: divisionFor(world, club),
        totalDivisions: totalDivisionsFor(world),
        openingPrice: parsed.data.openingPrice,
      });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      world.news.push({ dayIndex: world.dayIndex, text: `You put ${player.name} up for auction`, kind: "auction" });
      return { value: { ok: true, listingId: result.listing.id, openingPrice: result.listing.openingPrice } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/auctions", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    // Lazy resolution (§77/§102.6): expire no-bid listings and settle due
    // listings with bids so a delayed worker cannot leave them active.
    const expired = expireDueListings(loaded.world, Date.now());
    const settled = settleDueTransferAuctions(loaded.world, Date.now());
    if (expired > 0 || settled > 0) {
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (err) {
        if (!(err instanceof StaleWorldError)) throw err;
      }
    }
    const auctions = loaded.world.transferAuctions
      .filter((a) => a.status === "ACTIVE")
      .map((a) => transferAuctionView(loaded.world, a, myClubId));
    return { auctions };
  });

  // Submit or increase a private maximum bid (§11/§19). Irreversible upward
  // only. Uses the shared ProxyBidEngine + financial validator + reservations.
  app.post("/transfers/auctions/:id/bid", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const parsed = z.object({ maxBid: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "auction_bid", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const listing = world.transferAuctions.find((a) => a.id === listingId && a.status === "ACTIVE");
      if (!listing) return { error: { code: 404, body: { error: "Auction not found" } } };
      const player = world.players.find((p) => p.id === listing.playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      if (listing.sellerClubId === club.id) return { error: { code: 400, body: { error: "Cannot bid on your own auction" } } };
      const buyerDivision = divisionFor(world, club);
      const budget = safeMarketBudget(world, club, { acquisitionSalary: player.salary });
      const result = applyMaxBid(world, {
        listing,
        club,
        player,
        proposedMaximum: parsed.data.maxBid,
        buyerDivision,
        safeMarketBudget: budget,
      });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, currentPrice: result.currentPrice, leading: result.leading, myMaxBid: parsed.data.maxBid } };
    });
    return replyFrom(res, reply);
  });

  // Cancel a listing before any valid bid (§20). Releases reservations.
  app.post("/transfers/auctions/:id/cancel", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, req.user!.id, "transfer_cancel_listing", async (world, clubId) => {
      const listing = world.transferAuctions.find((a) => a.id === listingId);
      if (!listing) return { error: { code: 404, body: { error: "Auction not found" } } };
      if (listing.sellerClubId !== clubId) return { error: { code: 400, body: { error: "Only the seller can cancel this listing" } } };
      const result = cancelTransferAuction(world, listing);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      world.news.push({ dayIndex: world.dayIndex, text: `You cancelled the auction for ${world.players.find((p) => p.id === listing.playerId)?.name ?? "a player"}`, kind: "auction" });
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  // List active free-agent signings (§41/§42). Lazy resolve due listings.
  app.get("/transfers/free-agents", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    const settled = settleDueFreeAgentListings(loaded.world, Date.now());
    const relisted = relistDueFreeAgents(loaded.world, Date.now());
    if (settled > 0 || relisted > 0) {
      try {
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, loaded.world, loaded.save.revision);
      } catch (err) {
        if (!(err instanceof StaleWorldError)) throw err;
      }
    }
    const signings = loaded.world.freeAgentListings
      .filter((l) => l.status === "ACTIVE")
      .map((l) => freeAgentListingView(loaded.world, l, myClubId));
    return { signings };
  });

  // Submit or increase a private maximum signing-fee bid (§43).
  app.post("/transfers/free-agents/:id/bid", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const parsed = z.object({ maxBid: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "free_agent_bid", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const listing = world.freeAgentListings.find((l) => l.id === listingId && l.status === "ACTIVE");
      if (!listing) return { error: { code: 404, body: { error: "Free-agent listing not found" } } };
      const player = world.players.find((p) => p.id === listing.playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      const budget = safeMarketBudget(world, club, { acquisitionSalary: listing.demandedSalary });
      const result = applyFreeAgentBid(world, {
        listing,
        club,
        player,
        proposedMaximum: parsed.data.maxBid,
        safeMarketBudget: budget,
      });
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, currentPrice: result.currentPrice, leading: result.leading, myMaxBid: parsed.data.maxBid } };
    });
    return replyFrom(res, reply);
  });

  // Preview a player's listing (base value + allowed opening range + cooldown
  // state) so the List-for-Sale UI can show the server-computed range (§64.1).
  app.get("/transfers/auctions/preview", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const playerId = Number((req.query as { playerId?: string }).playerId ?? "0");
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    const player = loaded.world.players.find((p) => p.id === playerId);
    if (!player || player.clubId !== club.id) return reply.code(400).send({ error: "Player not in squad" });
    if (player.isYouth) return reply.code(400).send({ error: "Youth players cannot be listed for auction" });
    if (player.loanId !== null) return reply.code(400).send({ error: "A player on loan cannot be listed" });
    const cooldown = transferCooldownError(loaded.world, player);
    const range = auctionOpeningRange(loaded.world, player);
    return {
      playerId: player.id,
      value: player.value,
      baseValue: recentTradeBaseValue(loaded.world, player),
      openingPriceRange: range,
      cooldownError: cooldown,
      alreadyListed: loaded.world.transferAuctions.some((a) => a.playerId === player.id && a.status === "ACTIVE"),
    };
  });

  app.post("/players/:id/contract", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
    const parsed = contractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "contract", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === playerId);
      if (!player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      if (player.loanId !== null) return { error: { code: 400, body: { error: "A player on loan cannot renew his contract" } } };
      const seasons = parsed.data.length;
      if (seasons < 1 || seasons > gameConfig.maxContractSeasons) {
        return { error: { code: 400, body: { error: `Contract length must be between 1 and ${gameConfig.maxContractSeasons} seasons` } } };
      }
      const demand = contractDemand(player, seasons);
      if (parsed.data.salary < demand) {
        return { error: { code: 400, body: { error: "Salary offer rejected", demand } } };
      }
      settlePlayerPayroll(world, player);
      resetPayrollPeriod(player, world.dayIndex);
      player.salary = parsed.data.salary;
      player.contractDays = seasons * gameConfig.seasonDays;
      player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
      player.morale = Math.min(100, player.morale + 5);
      world.news.push({ dayIndex: world.dayIndex, text: `${player.name} signed a new contract`, kind: "contract" });
      return { value: { ok: true, demand } };
    });
    return replyFrom(res, reply);
  });

  app.get("/players/:id/contract", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    const player = loaded?.world.players.find((p) => p.id === Number((req.params as { id: string }).id));
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    if (!player) return reply.code(404).send({ error: "Player not found" });
    const maxSeasons = gameConfig.maxContractSeasons;
    const demandsBySeason = Object.fromEntries(
      Array.from({ length: maxSeasons }, (_, i) => [i + 1, contractDemand(player, i + 1)])
    );
    return {
      demand: demandsBySeason[1] ?? player.salary,
      demandsBySeason,
      salary: player.salary,
      contractDays: player.contractDays,
    };
  });

  app.post("/players/:id/academy", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
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
      if (parsed.data.formation !== undefined) club.tactics.formation = parsed.data.formation;
      club.tactics.style = parsed.data.style;
      club.tactics.pressing = parsed.data.pressing;
      club.tactics.direction = parsed.data.direction;
      world.news.push({ dayIndex: world.dayIndex, text: `${club.name} adopted new tactics`, kind: "tactics" });
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
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    return {
      cash: club.cash,
      income: club.ledger.income.slice(-30).reverse(),
      expense: club.ledger.expense.slice(-30).reverse(),
    };
  });

  app.get("/club/finance-details", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const club = userClub(loaded.world, req.user!.id);
    if (!club) return reply.code(400).send({ error: "You have no club" });
    const reference = TICKET_PRICES[divisionTicketTier(divisionFor(loaded.world, club))].map((x) => Math.max(1, Math.round(x / 200)));
    return {
      ticketPrices: loaded.world.ticketPrices[club.id] ?? reference,
      ticketBounds: reference.map((x) => ({ min: Math.max(1, Math.round(x * 0.5)), max: Math.round(x * 2.5) })),
      stadiumUpgrade: loaded.world.stadiumUpgrades.find((u) => u.clubId === club.id && !u.completed) ?? null,
      records: loaded.world.records,
      awards: loaded.world.seasonAwards.slice(-20).reverse(),
    };
  });

  app.get("/records", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    return { records: loaded.world.records, awards: loaded.world.seasonAwards.slice().reverse() };
  });

  app.post("/club/tickets", async (req, reply) => {
    const parsed = ticketSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "ticket_prices", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const reference = TICKET_PRICES[divisionTicketTier(divisionFor(world, club))].map((x) => Math.max(1, Math.round(x / 200)));
      const valid = parsed.data.prices.every((price, i) => price >= Math.max(1, Math.round(reference[i] * 0.5)) && price <= Math.round(reference[i] * 2.5));
      if (!valid) return { error: { code: 400, body: { error: "Ticket prices are outside the allowed range" } } };
      world.ticketPrices[club.id] = parsed.data.prices as [number, number, number, number];
      return { value: { ok: true, prices: world.ticketPrices[club.id] } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/stadium-upgrade", async (req, reply) => {
    const res = await withWorld(app, req.user!.id, "stadium_upgrade", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const result = startStadiumUpgrade(world, club);
      if (result.error) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, upgrade: result.upgrade } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/loans", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    const now = Date.now();
    const loans = loaded.world.loans.filter((l) => !l.recalled).map((loan) => {
      const player = loaded.world.players.find((p) => p.id === loan.playerId);
      const from = loaded.world.clubs.find((c) => c.id === loan.fromClubId);
      const to = loan.toClubId === null ? null : loaded.world.clubs.find((c) => c.id === loan.toClubId);
      return {
        ...loan,
        player: player ? playerView(player) : null,
        fromClub: from?.name ?? "",
        toClub: to?.name ?? null,
        available: loan.toClubId === null && loan.fromClubId !== myClubId && now >= loan.claimableAt,
        claimableIn: claimableInSeconds(loan, now),
      };
    });
    return { loans };
  });

  app.post("/players/:id/loan", async (req, reply) => {
    const playerId = Number((req.params as { id: string }).id);
    const parsed = playerLoanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "loan", async (world, clubId) => {
      const human = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === playerId);
      if (!player) return { error: { code: 404, body: { error: "Player not found" } } };
      if (parsed.data.action === "offer") {
        const result = offerPlayerForLoan(world, human, player);
        if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} listed ${player.name} for loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan: result.loan } };
      }
      const loan = world.loans.find((l) => l.id === player.loanId || l.playerId === playerId);
      if (!loan || loan.recalled) return { error: { code: 404, body: { error: "Loan not found" } } };
      if (parsed.data.action === "take") {
        const result = claimLoan(world, human, loan);
        if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} took ${player.name} on loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan: result.loan } };
      }
      const cancelled = cancelLoanListing(world, human, loan);
      if (!cancelled.ok) return { error: { code: 400, body: { error: cancelled.error } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });
}

function replyFrom(res: { error?: { code: number; body: unknown }; value?: unknown }, reply: import("fastify").FastifyReply) {
  if (res.error) return reply.code(res.error.code).send(res.error.body);
  return res.value;
}
