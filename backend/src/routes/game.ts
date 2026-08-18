import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorld, persistWorld, StaleWorldError } from "../services/saveService";
import { competitionTable, playerView } from "../services/snapshot";
import { liveStateView } from "../services/liveView";
import { dayInfo, multiplayerDayLabel } from "../game/calendar";
import { withGlobalLock } from "../services/lock";
import { evaluateBid, createAuction, auctionAvailableCash, freeAgentSigningBonus, releasePlayer } from "../game/transfers";
import { calculateReleaseClause, remainingSeasons } from "../game/economy";
import { resetPayrollPeriod, settlePlayerPayroll } from "../game/payroll";
import { performLiveSub, isPregame, isHalftime, rebuildLiveHumanLineup } from "../game/match";
import { advanceLiveMatches, roundLabelFor, findCompetition } from "../game/world";
import { recordActivity } from "../game/multiplayer";
import { FORMATION_POSITIONS, TACTICAL_POSITION_NAMES } from "../game/constants";
import { lineupForMatch, peekLineup, applySavedLineup } from "../game/club";
import { contractDemand, dismissYouthPlayer, endLoan, loanFitsContract, promoteYouthPlayer, seasonEndDay, startStadiumUpgrade } from "../game/season";
import { gameConfig } from "../config";
import type { World } from "../game/types";
import { TICKET_PRICES } from "../game/constants";

const sellSchema = z.object({
  playerId: z.number().int(),
  mode: z.enum(["auction", "fixed"]).default("auction"),
  price: z.number().int().optional(),
});

const bidSchema = z.object({
  playerId: z.number().int(),
  bid: z.number().int().min(0),
});

const auctionBidSchema = z.object({
  amount: z.number().int(),
});

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
           dayLabel: loaded.world.mp.seasonId === 0 ? dayInfo(f.dayIndex).label : multiplayerDayLabel(f.dayIndex),
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
      const result = performLiveSub(world.rng, home, away, world.players, st, side, parsed.data.outId, parsed.data.inId);
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
    const parsed = sellSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "transfer_sell", async (world, clubId) => {
      const club = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === parsed.data.playerId);
      if (!player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      if (player.loanId !== null) return { error: { code: 400, body: { error: "A player on loan cannot be sold" } } };
      if (parsed.data.mode === "auction") {
        const listingId = createAuction(
          world.rng,
          world,
          player.id,
          club.id,
          seasonEndDay(world.dayIndex, gameConfig.auctionDurationDays),
          Date.now() + gameConfig.auctionDurationDays * 24 * 60 * 60 * 1000,
        );
        player.onSale = true;
        world.news.push({ dayIndex: world.dayIndex, text: `You put ${player.name} up for auction`, kind: "auction" });
        return { value: { ok: true, listingId } };
      }
      const price = parsed.data.price ?? Math.round(player.value * 0.8);
      player.onSale = true;
      player.salePrice = price;
      world.news.push({ dayIndex: world.dayIndex, text: `You listed ${player.name} for sale at ${price}`, kind: "transfer" });
      return { value: { ok: true, price } };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/bid", async (req, reply) => {
    const parsed = bidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "transfer_bid", async (world, clubId) => {
      const buyer = world.clubs.find((c) => c.id === clubId)!;
      const player = world.players.find((p) => p.id === parsed.data.playerId);
      if (!player) return { error: { code: 400, body: { error: "Invalid player" } } };
      if (parsed.data.bid > buyer.cash) return { error: { code: 400, body: { error: "Not enough cash" } } };
      if (player.clubId === null) {
        const signingBonus = freeAgentSigningBonus(player);
        if (parsed.data.bid < signingBonus) {
          return { value: { accepted: false, counter: signingBonus } };
        }
        buyer.cash -= parsed.data.bid;
        buyer.ledger.expense.push({ code: 1, amount: parsed.data.bid, day: world.dayIndex, label: `Signing bonus: ${player.name}` });
        player.clubId = buyer.id;
        resetPayrollPeriod(player, world.dayIndex);
        player.tacPos = -1;
        player.starter = false;
        player.contractDays = Math.max(player.contractDays, gameConfig.seasonDays);
        player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
        player.onSale = false;
        player.salePrice = null;
        world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed free agent ${player.name}`, kind: "transfer" });
        return { value: { accepted: true, price: parsed.data.bid, signingBonus } };
      }
      const seller = world.clubs.find((c) => c.id === player.clubId);
      if (!seller) return { error: { code: 400, body: { error: "Player has no club" } } };
      if (buyer.id === seller.id) return { error: { code: 400, body: { error: "Cannot bid on own player" } } };
      if (player.loanId !== null) return { error: { code: 400, body: { error: "A player on loan cannot be transferred" } } };
      const evalRes = evaluateBid(world.rng, player, parsed.data.bid, seller, buyer, world.players);
      if (evalRes.accepted) {
        buyer.cash -= parsed.data.bid;
        seller.cash += parsed.data.bid;
        settlePlayerPayroll(world, player);
        player.clubId = buyer.id;
        player.tacPos = -1;
        player.contractDays = Math.max(player.contractDays, gameConfig.seasonDays);
        player.releaseClause = calculateReleaseClause(player.salary, remainingSeasons(player.contractDays));
        world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed ${player.name} for ${parsed.data.bid}`, kind: "transfer" });
        return { value: { accepted: true, price: parsed.data.bid } };
      }
      return { value: { accepted: false, counter: evalRes.counter } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/auctions", async (req, reply) => {
    const loaded = await loadGlobalWorld(app.prisma);
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    const myClubId = userClub(loaded.world, req.user!.id)?.id ?? null;
    const auctions = loaded.world.auctions.map((a) => {
      const p = loaded.world.players.find((x) => x.id === a.playerId);
      return {
        id: a.id,
        playerId: a.playerId,
        playerName: p?.name ?? "",
        overall: p?.overall ?? 0,
        position: p?.position ?? 0,
        age: p?.age ?? 0,
        salary: p?.salary ?? 0,
        skills: p?.skills ?? { gol: 0, vel: 0, tec: 0, pas: 0, des: 0, arm: 0, fin: 0 },
        minBid: a.minBid,
        deadlineDay: a.deadlineDay,
        startsAt: a.startsAt ?? null,
        deadlineLabel: loaded.world.mp.seasonId === 0 ? dayInfo(a.deadlineDay).label : multiplayerDayLabel(a.deadlineDay),
        endsAt: a.endsAt ?? null,
        currentBid: a.bids.length > 0 ? Math.max(...a.bids.map((b) => b.amount)) : 0,
        sellerClubId: a.sellerClubId,
        myBid: myClubId ? a.bids.find((b) => b.clubId === myClubId)?.amount ?? 0 : 0,
      };
    });
    return { auctions };
  });

  app.post("/auctions/:id/bid", async (req, reply) => {
    const listingId = Number((req.params as { id: string }).id);
    const parsed = auctionBidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "auction_bid", async (world, clubId) => {
      const listing = world.auctions.find((a) => a.id === listingId);
      const club = world.clubs.find((c) => c.id === clubId)!;
      if (!listing) return { error: { code: 404, body: { error: "Auction not found" } } };
      if (listing.sellerClubId === club.id) return { error: { code: 400, body: { error: "Cannot bid on your own auction" } } };
      if (listing.endsAt !== undefined ? Date.now() >= listing.endsAt : listing.deadlineDay <= world.dayIndex) {
        return { error: { code: 400, body: { error: "Auction closed" } } };
      }
      if (parsed.data.amount <= 0) return { error: { code: 400, body: { error: "Invalid amount" } } };
      const currentMax = listing.bids.length > 0 ? Math.max(...listing.bids.map((b) => b.amount)) : 0;
      if (parsed.data.amount < listing.minBid || parsed.data.amount <= currentMax) {
        return { error: { code: 400, body: { error: "Bid must be at least the minimum and beat the current bid" } } };
      }
      const existing = listing.bids.find((b) => b.clubId === club.id);
      const availableCash = auctionAvailableCash(world, club.id, listing.id) + (existing?.amount ?? 0);
      if (parsed.data.amount > availableCash) return { error: { code: 400, body: { error: "Not enough uncommitted cash" } } };
      if (existing) existing.amount = Math.max(existing.amount, parsed.data.amount);
      else listing.bids.push({ clubId: club.id, amount: parsed.data.amount });
      return { value: { ok: true, currentBid: Math.max(...listing.bids.map((b) => b.amount)) } };
    });
    return replyFrom(res, reply);
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
    const reference = TICKET_PRICES[Math.min(5, Math.round(club.level / 5))].map((x) => Math.max(1, Math.round(x / 200)));
    return {
      ticketPrices: loaded.world.ticketPrices[club.id] ?? reference,
      ticketBounds: reference.map((x) => ({ min: Math.max(1, Math.round(x * 0.5)), max: Math.round(x * 2.5) })),
      stadiumUpgrade: loaded.world.stadiumUpgrades.find((u) => u.clubId === club.id && !u.completed) ?? null,
      tvDeal: loaded.world.tvDeals.find((d) => d.clubId === club.id && d.season === loaded.world.year) ?? null,
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
      const reference = TICKET_PRICES[Math.min(5, Math.round(club.level / 5))].map((x) => Math.max(1, Math.round(x / 200)));
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
    const loans = loaded.world.loans.filter((l) => !l.recalled).map((loan) => {
      const player = loaded.world.players.find((p) => p.id === loan.playerId);
      const from = loaded.world.clubs.find((c) => c.id === loan.fromClubId);
      const to = loan.toClubId === null ? null : loaded.world.clubs.find((c) => c.id === loan.toClubId);
      return { ...loan, player: player ? playerView(player) : null, fromClub: from?.name ?? "", toClub: to?.name ?? null, available: loan.toClubId === null && loan.fromClubId !== myClubId };
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
        if (player.clubId !== human.id || player.loanId !== null || player.isYouth) return { error: { code: 400, body: { error: "Player is not eligible for a loan" } } };
        const endDay = seasonEndDay(world.dayIndex, gameConfig.seasonDays - (world.dayIndex % gameConfig.seasonDays));
        if (!loanFitsContract(world.dayIndex, endDay, player.contractDays)) return { error: { code: 400, body: { error: "Loan duration exceeds the player's remaining contract" } } };
        const loan = { id: world.nextId++, playerId, fromClubId: human.id, toClubId: null, startDay: world.dayIndex, endDay, recalled: false };
        world.loans.push(loan);
        player.loanId = loan.id;
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} listed ${player.name} for loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan } };
      }
      const loan = world.loans.find((l) => l.id === player.loanId || l.playerId === playerId);
      if (!loan || loan.recalled) return { error: { code: 404, body: { error: "Loan not found" } } };
      if (parsed.data.action === "take") {
        if (loan.toClubId !== null || loan.fromClubId === human.id) return { error: { code: 400, body: { error: "Loan is not available" } } };
        if (!loanFitsContract(world.dayIndex, loan.endDay, player.contractDays)) return { error: { code: 400, body: { error: "Loan duration exceeds the player's remaining contract" } } };
        settlePlayerPayroll(world, player);
        loan.toClubId = human.id;
        player.clubId = human.id;
        player.loanId = loan.id;
        player.tacPos = -1;
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} took ${player.name} on loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan } };
      }
      if (loan.fromClubId !== human.id) return { error: { code: 400, body: { error: "Only the owning club can recall this player" } } };
      endLoan(world, loan);
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });
}

function replyFrom(res: { error?: { code: number; body: unknown }; value?: unknown }, reply: import("fastify").FastifyReply) {
  if (res.error) return reply.code(res.error.code).send(res.error.body);
  return res.value;
}
