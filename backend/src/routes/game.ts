import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadWorld, persistWorld } from "../services/saveService";
import { bracketView, buildSnapshot, competitionTable, playerView } from "../services/snapshot";
import { liveStateView } from "../services/liveView";
import { dayInfo } from "../game/calendar";
import { withSaveLock } from "../services/lock";
import { counterOffer, evaluateBid, createAuction, auctionAvailableCash, freeAgentSigningBonus } from "../game/transfers";
import { performLiveSub, tickLiveMatch, isPregame, rebuildLiveHumanLineup } from "../game/match";
import { finalizeLiveMatch, roundLabelFor } from "../game/world";
import { FORMATION_POSITIONS, TACTICAL_POSITION_NAMES } from "../game/constants";
import { lineupForMatch, peekLineup, applySavedLineup } from "../game/club";
import { serializeDayResult } from "./saves";
import type { World } from "../game/types";
import { LOAN_LIMITS, TICKET_PRICES } from "../game/constants";
import { contractDemand, dismissYouthPlayer, endLoan, promoteYouthPlayer, seasonEndDay, startStadiumUpgrade } from "../game/season";
import { gameConfig } from "../config";

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
  length: z.number().int().min(1).max(5), // contract length in seasons
  salary: z.number().int().min(0),
});

const tacticsSchema = z.object({
  formation: z.number().int().min(0).max(12).optional(),
  style: z.number().int().min(0).max(2),
  pressing: z.number().int().min(0).max(2),
  direction: z.number().int().min(0).max(1),
});

const loanSchema = z.object({
  action: z.enum(["take", "repay"]),
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

async function withWorld(app: FastifyInstance, saveId: number, userId: number, fn: (world: World) => Promise<{ error?: { code: number; body: unknown }; value?: unknown }>) {
  return withSaveLock(saveId, async () => {
    const loaded = await loadWorld(app.prisma, saveId, userId);
    if (!loaded) return { error: { code: 404, body: { error: "Save not found" } } };
    if (loaded.world.humanClubId === null) return { error: { code: 400, body: { error: "Save not started" } } };
    const res = await fn(loaded.world);
    if (res.error) return res;
    await persistWorld(app.prisma, saveId, userId, loaded.world);
    return { value: res.value };
  });
}

export async function gameRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    await app.authenticate(req, reply);
  });

  const parseSaveId = (req: import("fastify").FastifyRequest) => {
    const raw = String((req.query as Record<string, unknown>).saveId ?? "");
    return Number(raw);
  };

  app.get("/competitions/:id/table", async (req, reply) => {
    const saveId = parseSaveId(req);
    const compId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const comp = loaded.world.competitions.find((c) => c.id === compId);
    if (!comp) return reply.code(404).send({ error: "Competition not found" });
    return { competition: { id: comp.id, name: comp.name, kind: comp.kind, stage: comp.stage }, table: competitionTable(loaded.world, comp) };
  });

  app.get("/competitions/:id/fixtures", async (req, reply) => {
    const saveId = parseSaveId(req);
    const compId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const comp = loaded.world.competitions.find((c) => c.id === compId);
    if (!comp) return reply.code(404).send({ error: "Competition not found" });
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
          home: home?.name ?? "",
          away: away?.name ?? "",
          dayLabel: dayInfo(f.dayIndex).label,
          dayIndex: f.dayIndex,
          played: f.played,
          homeScore: m?.homeScore,
          awayScore: m?.awayScore,
          isHuman: f.homeClubId === loaded.world.humanClubId || f.awayClubId === loaded.world.humanClubId,
        };
      });
    return { competition: { id: comp.id, name: comp.name }, fixtures };
  });

  app.get("/competitions/:id/bracket", async (req, reply) => {
    const saveId = parseSaveId(req);
    const compId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const comp = loaded.world.competitions.find((c) => c.id === compId);
    if (!comp) return reply.code(404).send({ error: "Competition not found" });
    return { competition: { id: comp.id, name: comp.name }, bracket: bracketView(loaded.world, comp) };
  });

  app.get("/matches/:id/events", async (req, reply) => {
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const match = loaded.world.matches.find((m) => m.id === matchId);
    if (!match) return reply.code(404).send({ error: "Match not found" });
    const home = loaded.world.clubs.find((c) => c.id === match.homeClubId);
    const away = loaded.world.clubs.find((c) => c.id === match.awayClubId);
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
        home: home?.name ?? "",
        away: away?.name ?? "",
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
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const st = loaded.world.liveMatch;
    if (!st || st.matchId !== matchId) return reply.code(404).send({ error: "No live match in progress" });
    return { state: liveStateView(loaded.world, st) };
  });

  app.post("/matches/:id/tick", async (req, reply) => {
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const parsed = liveTickSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const st = world.liveMatch;
      if (!st || st.matchId !== matchId) return { error: { code: 404, body: { error: "No live match in progress" } } };
      const home = world.clubs.find((c) => c.id === st.homeClubId)!;
      const away = world.clubs.find((c) => c.id === st.awayClubId)!;
      const result = tickLiveMatch(world.rng, home, away, world.players, st, parsed.data.minutes, { resume: parsed.data.resume });
      return { value: { events: result.events, atHalfTime: result.atHalfTime, state: liveStateView(world, st) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/sub", async (req, reply) => {
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const parsed = z.object({ outId: z.number().int(), inId: z.number().int() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const st = world.liveMatch;
      if (!st || st.matchId !== matchId) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (st.ended) return { error: { code: 400, body: { error: "Match already finished" } } };
      const home = world.clubs.find((c) => c.id === st.homeClubId)!;
      const away = world.clubs.find((c) => c.id === st.awayClubId)!;
      const side = st.homeClubId === world.humanClubId ? 0 : 1;
      const result = performLiveSub(world.rng, home, away, world.players, st, side, parsed.data.outId, parsed.data.inId);
      if (result.error) return { error: { code: 400, body: { error: result.error } } };
      return { value: { event: result.event, state: liveStateView(world, st) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/finish", async (req, reply) => {
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const st = world.liveMatch;
      if (!st || st.matchId !== matchId) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (!st.ended) {
        const home = world.clubs.find((c) => c.id === st.homeClubId)!;
        const away = world.clubs.find((c) => c.id === st.awayClubId)!;
        tickLiveMatch(world.rng, home, away, world.players, st, 200, { ignoreHalfTime: true });
      }
      const dayResult = finalizeLiveMatch(world);
      return { value: { dayResult: serializeDayResult(world, dayResult) } };
    });
    return replyFrom(res, reply);
  });

  app.get("/club/lineup", async (req, reply) => {
    const saveId = parseSaveId(req);
    const query = req.query as Record<string, unknown>;
    const auto = String(query.auto ?? "") === "1";
    const formationRaw = Number(query.formation ?? "");
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const club = loaded.world.clubs.find((c) => c.id === loaded.world.humanClubId);
    if (!club) return reply.code(400).send({ error: "Save not started" });
    const formation = Number.isInteger(formationRaw) && formationRaw >= 0 && formationRaw <= 12 ? formationRaw : club.tactics.formation;
    const lineup = peekLineup(
      { ...club, savedLineup: auto ? null : club.savedLineup, tactics: { ...club.tactics, formation } },
      loaded.world.players
    );
    // Squad-eligible list matches the engine policy (youth included, see
    // buildLineup note in club.ts) so the manager can manage AI-selected youth.
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
    const saveId = parseSaveId(req);
    const parsed = lineupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      const err = applySavedLineup(club, world.players, parsed.data);
      if (err) return { error: { code: 400, body: { error: err } } };
      world.news.push({ dayIndex: world.dayIndex, text: `${club.name} confirmed the lineup`, kind: "tactics" });
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/matches/:id/lineup", async (req, reply) => {
    const saveId = parseSaveId(req);
    const matchId = Number((req.params as { id: string }).id);
    const parsed = lineupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const st = world.liveMatch;
      if (!st || st.matchId !== matchId) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (!isPregame(st)) return { error: { code: 400, body: { error: "The match already started" } } };
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      const err = applySavedLineup(club, world.players, parsed.data);
      if (err) return { error: { code: 400, body: { error: err } } };
      rebuildLiveHumanLineup(st, club, world.players);
      return { value: { ok: true, state: liveStateView(world, st) } };
    });
    return replyFrom(res, reply);
  });

  app.post("/transfers/sell", async (req, reply) => {
    const saveId = parseSaveId(req);
    const parsed = sellSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      const player = world.players.find((p) => p.id === parsed.data.playerId);
      if (!club || !player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      if (parsed.data.mode === "auction") {
        const listingId = createAuction(world.rng, world, player.id, club.id, seasonEndDay(world.dayIndex, 7));
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
    const saveId = parseSaveId(req);
    const parsed = bidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const buyer = world.clubs.find((c) => c.id === world.humanClubId);
      const player = world.players.find((p) => p.id === parsed.data.playerId);
      if (!buyer || !player) return { error: { code: 400, body: { error: "Invalid player" } } };
      if (parsed.data.bid > buyer.cash) return { error: { code: 400, body: { error: "Not enough cash" } } };
      if (player.clubId === null) {
        const signingBonus = freeAgentSigningBonus(player);
        if (parsed.data.bid < signingBonus) {
          return { value: { accepted: false, counter: signingBonus } };
        }
        buyer.cash -= parsed.data.bid;
        buyer.ledger.expense.push({ code: 1, amount: parsed.data.bid, day: world.dayIndex, label: `Signing bonus: ${player.name}` });
        player.clubId = buyer.id;
        player.tacPos = -1;
        player.starter = false;
        player.contractDays = Math.max(player.contractDays, gameConfig.seasonDays);
        player.onSale = false;
        player.salePrice = null;
        world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed free agent ${player.name}`, kind: "transfer" });
        return { value: { accepted: true, price: parsed.data.bid, signingBonus } };
      }
      const seller = world.clubs.find((c) => c.id === player.clubId);
      if (!seller) return { error: { code: 400, body: { error: "Player has no club" } } };
      if (buyer.id === seller.id) return { error: { code: 400, body: { error: "Cannot bid on own player" } } };
      if (player.isStar) {
        const target = counterOffer(seller, player, world.players);
        if (parsed.data.bid >= target) {
          buyer.cash -= parsed.data.bid;
          seller.cash += parsed.data.bid;
          player.clubId = buyer.id;
          player.tacPos = -1;
          world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed ${player.name} for ${parsed.data.bid}`, kind: "transfer" });
          return { value: { accepted: true, price: parsed.data.bid } };
        }
        return { value: { accepted: false, counter: Math.round(target * 1.3) } };
      }
      const evalRes = evaluateBid(world.rng, player, parsed.data.bid, seller, buyer, world.players);
      if (evalRes.accepted) {
        buyer.cash -= parsed.data.bid;
        seller.cash += parsed.data.bid;
        player.clubId = buyer.id;
        player.tacPos = -1;
        player.contractDays = Math.max(player.contractDays, gameConfig.seasonDays);
        world.news.push({ dayIndex: world.dayIndex, text: `${buyer.name} signed ${player.name} for ${parsed.data.bid}`, kind: "transfer" });
        return { value: { accepted: true, price: parsed.data.bid } };
      }
      return { value: { accepted: false, counter: evalRes.counter } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/auctions", async (req, reply) => {
    const saveId = parseSaveId(req);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
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
        deadlineLabel: dayInfo(a.deadlineDay).label,
        currentBid: a.bids.length > 0 ? Math.max(...a.bids.map((b) => b.amount)) : 0,
        sellerClubId: a.sellerClubId,
        myBid: loaded.world.humanClubId ? a.bids.find((b) => b.clubId === loaded.world.humanClubId)?.amount ?? 0 : 0,
      };
    });
    return { auctions };
  });

  app.post("/auctions/:id/bid", async (req, reply) => {
    const saveId = parseSaveId(req);
    const listingId = Number((req.params as { id: string }).id);
    const parsed = auctionBidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const listing = world.auctions.find((a) => a.id === listingId);
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!listing || !club) return { error: { code: 404, body: { error: "Auction not found" } } };
      if (listing.sellerClubId === club.id) return { error: { code: 400, body: { error: "Cannot bid on your own auction" } } };
      if (listing.deadlineDay <= world.dayIndex) return { error: { code: 400, body: { error: "Auction closed" } } };
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
    const saveId = parseSaveId(req);
    const playerId = Number((req.params as { id: string }).id);
    const parsed = contractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      const player = world.players.find((p) => p.id === playerId);
      if (!club || !player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in squad" } } };
      const seasons = parsed.data.length;
      const demand = contractDemand(player);
      if (parsed.data.salary < demand) {
        return { error: { code: 400, body: { error: "Salary offer rejected", demand } } };
      }
      player.salary = parsed.data.salary;
      player.contractDays = seasons * gameConfig.seasonDays;
      player.morale = Math.min(100, player.morale + 5);
      world.news.push({ dayIndex: world.dayIndex, text: `${player.name} signed a new contract`, kind: "contract" });
      return { value: { ok: true, demand } };
    });
    return replyFrom(res, reply);
  });

  app.get("/players/:id/contract", async (req, reply) => {
    const saveId = parseSaveId(req);
    const playerId = Number((req.params as { id: string }).id);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    const player = loaded?.world.players.find((p) => p.id === playerId);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    if (!player) return reply.code(404).send({ error: "Player not found" });
    return { demand: contractDemand(player), salary: player.salary, contractDays: player.contractDays };
  });

  app.post("/players/:id/academy", async (req, reply) => {
    const saveId = parseSaveId(req);
    const playerId = Number((req.params as { id: string }).id);
    const parsed = academyActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      const player = world.players.find((p) => p.id === playerId);
      if (!club || !player || player.clubId !== club.id) return { error: { code: 400, body: { error: "Player not in your youth academy" } } };
      const result = parsed.data.action === "promote" ? promoteYouthPlayer(world, player) : dismissYouthPlayer(world, player);
      if (!result.ok) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/tactics", async (req, reply) => {
    const saveId = parseSaveId(req);
    const parsed = tacticsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
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
    const saveId = parseSaveId(req);
    const parsed = trainingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid training focus" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      club.trainingFocus = parsed.data.focus;
      return { value: { ok: true, trainingFocus: club.trainingFocus } };
    });
    return replyFrom(res, reply);
  });

  app.get("/club/finances", async (req, reply) => {
    const saveId = parseSaveId(req);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    if (loaded.world.humanClubId === null) return reply.code(400).send({ error: "Save not started" });
    const club = loaded.world.clubs.find((c) => c.id === loaded.world.humanClubId)!;
    return {
      cash: club.cash,
      loanBalance: club.loanBalance,
      loanLimit: loanLimitFor(club.reputation),
      loanInterestPercent: gameConfig.payrollLoanInterestPercent,
      income: club.ledger.income.slice(-30).reverse(),
      expense: club.ledger.expense.slice(-30).reverse(),
    };
  });

  app.get("/club/finance-details", async (req, reply) => {
    const saveId = parseSaveId(req);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const club = loaded.world.clubs.find((c) => c.id === loaded.world.humanClubId);
    if (!club) return reply.code(400).send({ error: "Save not started" });
    const reference = TICKET_PRICES[Math.min(5, club.reputation)].map((x) => Math.max(1, Math.round(x / 200)));
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
    const saveId = parseSaveId(req);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    return { records: loaded.world.records, awards: loaded.world.seasonAwards.slice().reverse() };
  });

  app.post("/club/tickets", async (req, reply) => {
    const saveId = parseSaveId(req);
    const parsed = ticketSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      const reference = TICKET_PRICES[Math.min(5, club.reputation)].map((x) => Math.max(1, Math.round(x / 200)));
      const valid = parsed.data.prices.every((price, i) => price >= Math.max(1, Math.round(reference[i] * 0.5)) && price <= Math.round(reference[i] * 2.5));
      if (!valid) return { error: { code: 400, body: { error: "Ticket prices are outside the allowed range" } } };
      world.ticketPrices[club.id] = parsed.data.prices as [number, number, number, number];
      return { value: { ok: true, prices: world.ticketPrices[club.id] } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/stadium-upgrade", async (req, reply) => {
    const saveId = parseSaveId(req);
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      const result = startStadiumUpgrade(world, club);
      if (result.error) return { error: { code: 400, body: { error: result.error } } };
      return { value: { ok: true, upgrade: result.upgrade } };
    });
    return replyFrom(res, reply);
  });

  app.get("/transfers/loans", async (req, reply) => {
    const saveId = parseSaveId(req);
    const loaded = await loadWorld(app.prisma, saveId, req.user!.id);
    if (!loaded) return reply.code(404).send({ error: "Save not found" });
    const loans = loaded.world.loans.filter((l) => !l.recalled).map((loan) => {
      const player = loaded.world.players.find((p) => p.id === loan.playerId);
      const from = loaded.world.clubs.find((c) => c.id === loan.fromClubId);
      const to = loan.toClubId === null ? null : loaded.world.clubs.find((c) => c.id === loan.toClubId);
      return { ...loan, player: player ? playerView(player) : null, fromClub: from?.name ?? "", toClub: to?.name ?? null, available: loan.toClubId === null && loan.fromClubId !== loaded.world.humanClubId };
    });
    return { loans };
  });

  app.post("/players/:id/loan", async (req, reply) => {
    const saveId = parseSaveId(req);
    const playerId = Number((req.params as { id: string }).id);
    const parsed = playerLoanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const human = world.clubs.find((c) => c.id === world.humanClubId);
      const player = world.players.find((p) => p.id === playerId);
      if (!human || !player) return { error: { code: 404, body: { error: "Player not found" } } };
      if (parsed.data.action === "offer") {
        if (player.clubId !== human.id || player.loanId !== null || player.age > 23 || player.isYouth) return { error: { code: 400, body: { error: "Player is not eligible for a loan" } } };
        const loan = { id: world.nextId++, playerId, fromClubId: human.id, toClubId: null, startDay: world.dayIndex, endDay: seasonEndDay(world.dayIndex, gameConfig.seasonDays - (world.dayIndex % gameConfig.seasonDays)), recalled: false };
        world.loans.push(loan);
        player.loanId = loan.id;
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} listed ${player.name} for loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan } };
      }
      const loan = world.loans.find((l) => l.id === player.loanId || l.playerId === playerId);
      if (!loan || loan.recalled) return { error: { code: 404, body: { error: "Loan not found" } } };
      if (parsed.data.action === "take") {
        if (loan.toClubId !== null || loan.fromClubId === human.id) return { error: { code: 400, body: { error: "Loan is not available" } } };
        loan.toClubId = human.id;
        player.clubId = human.id;
        player.loanId = loan.id;
        world.news.push({ dayIndex: world.dayIndex, text: `${human.name} took ${player.name} on loan`, kind: "loan", clubId: human.id });
        return { value: { ok: true, loan } };
      }
      if (loan.fromClubId !== human.id) return { error: { code: 400, body: { error: "Only the owning club can recall this player" } } };
      endLoan(world, loan);
      return { value: { ok: true } };
    });
    return replyFrom(res, reply);
  });

  app.post("/club/loan", async (req, reply) => {
    const saveId = parseSaveId(req);
    const parsed = loanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, saveId, req.user!.id, async (world) => {
      const club = world.clubs.find((c) => c.id === world.humanClubId);
      if (!club) return { error: { code: 404, body: { error: "Club not found" } } };
      if (parsed.data.action === "take") {
        const limit = loanLimitFor(club.reputation);
        if (club.loanBalance >= limit) return { error: { code: 400, body: { error: "Loan limit reached" } } };
        const amount = Math.min(500000, limit - club.loanBalance);
        club.loanBalance += amount;
        club.cash += amount;
        club.ledger.income.push({ code: 8, amount, day: world.dayIndex, label: "Bank loan" });
        return { value: { ok: true, cash: club.cash, loanBalance: club.loanBalance } };
      }
      if (club.loanBalance <= 0) return { error: { code: 400, body: { error: "No outstanding loan" } } };
      const amount = Math.min(500000, club.loanBalance, club.cash);
      club.loanBalance -= amount;
      club.cash -= amount;
      club.ledger.expense.push({ code: 7, amount, day: world.dayIndex, label: "Loan repayment" });
      return { value: { ok: true, cash: club.cash, loanBalance: club.loanBalance } };
    });
    return replyFrom(res, reply);
  });
}

function loanLimitFor(reputation: number): number {
  return LOAN_LIMITS[Math.max(0, Math.min(4, reputation - 1))];
}

function replyFrom(res: { error?: { code: number; body: unknown }; value?: unknown }, reply: import("fastify").FastifyReply) {
  if (res.error) return reply.code(res.error.code).send(res.error.body);
  return res.value;
}
