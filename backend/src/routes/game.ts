import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadGlobalWorldMutableLazy, loadGlobalWorldReadOnly, persistWorld, StaleWorldError } from "../services/saveService";
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
import { canViewPlayerPerformance, hasPro } from "../services/pro";
import { playerMatchScoreView } from "../services/playerPerformance";
import { conditionLabel, injuryDaysRemaining } from "../game/energyInjury";
import { lineupForMatch, peekLineup, applySavedLineup, seniorRosterFullError, seniorRosterOverflowError } from "../game/club";
import { FORMATIONS, formationById, formationOptions } from "../game/formations";
import { adjustedTacticalRating, rolePenalty, suitabilityLabel } from "../game/outOfPosition";
import type { DeployedRole } from "../game/positions";
import { contractDemand, dismissYouthPlayer, promoteYouthPlayer } from "../game/season";
import { setPlayerSquadNumber } from "../game/squadNumbers";
import { NEWS_SUBJECTS, publishNews } from "../game/news";
import { msg } from "../i18n/catalog";
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
import { dayBoundaryAtOrBefore } from "../services/dayBoundary";
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

// `contractSeasons` means COMPLETE seasons beyond the remainder of the current
// one — the same meaning every market path uses.
const contractSchema = z.object({
  contractSeasons: z.number().int().min(1).max(gameConfig.maxContractSeasons),
});

// §15.3: the formation catalog owns formation ids; the zod bound below must
// track FORMATIONS.length (automation.ts derives MAX_FORMATION the same way).
const MAX_FORMATION = FORMATIONS.length - 1;

const tacticsSchema = z.object({
  formation: z.number().int().min(0).max(MAX_FORMATION).optional(),
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
  formation: z.number().int().min(0).max(MAX_FORMATION),
  starters: z.array(z.number().int()).length(11),
  subs: z.array(z.number().int()).max(11),
  penaltyTakerId: z.number().int().nullable(),
  // Optional: the free-kick taker control is retired from the UI (no direct
  // free-kick shot resolution exists in the engine, §14). Omitted means
  // "leave as stored" (applySavedLineup carries the previous value forward);
  // still accepted explicitly so the dormant field/migration path is unaffected.
  freeKickTakerId: z.number().int().nullable().optional(),
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
      const loaded = await loadGlobalWorldMutableLazy(app.prisma);
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
    const mvpPlayer = match.mvpPlayerId != null ? loaded.world.players.find((p) => p.id === match.mvpPlayerId) : undefined;
    const playerById = new Map(loaded.world.players.map((p) => [p.id, p]));
    const viewerClub = userClub(loaded.world, req.user!.id);
    const canViewMvp = mvpPlayer !== undefined && canViewPlayerPerformance(req.user, mvpPlayer, {
      viewerClubId: viewerClub?.id ?? null,
      loans: loaded.world.loans,
    });
    // Finished-match scores come from the persisted rating rows (plan §16).
    const scores = (loaded.world.playerMatchRatings ?? [])
      .filter((r) => r.matchId === match.id)
      .filter((r) => {
        const player = playerById.get(r.playerId);
        return player !== undefined && canViewPlayerPerformance(req.user, player, {
          viewerClubId: viewerClub?.id ?? null,
          loans: loaded.world.loans,
        });
      })
      .map((r) => {
        const p = playerById.get(r.playerId);
        const facts = playerMatchScoreView(loaded.world, r);
        return {
          playerId: r.playerId,
          clubId: r.clubId,
          goals: facts.goals,
          assists: facts.assists,
          score: facts.score,
          won: facts.won,
          minutes: r.minutesPlayed,
          name: p?.name ?? "",
          role: r.primaryRole,
          live: false,
          rating: r.ratingExact,
        };
      })
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    return {
      match: {
        id: match.id,
        home: home?.name ?? "",
        away: away?.name ?? "",
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        // Null for regular users; the UI shows a locked tab instead.
        stats: isPro ? match.stats : null,
        mvpPlayerId: canViewMvp ? match.mvpPlayerId ?? null : null,
        mvpPlayerName: canViewMvp ? mvpPlayer?.name ?? null : null,
        mvpClubId: canViewMvp ? mvpPlayer?.clubId ?? null : null,
      },
      events,
      scores,
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

  // REST fallback for the WS `{type:"automation"}` pause/resume toggle
  // (plugins/ws.ts) — the WS path is primary; this exists so a dropped
  // socket does not leave the control silently inert (plan §11 Part 1b).
  app.post("/matches/:id/automation", async (req, reply) => {
    const matchId = Number((req.params as { id: string }).id);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const res = await withWorld(app, req.user!.id, "match_automation_toggle", async (world, clubId) => {
      const st = world.liveMatches.find((s) => s.matchId === matchId);
      if (!st) return { error: { code: 404, body: { error: "No live match in progress" } } };
      if (st.homeClubId !== clubId && st.awayClubId !== clubId) {
        return { error: { code: 403, body: { error: "You are not a participant in this match" } } };
      }
      const side = st.homeClubId === clubId ? 0 : 1;
      st.automationDisabled ??= [false, false];
      st.automationDisabled[side] = !parsed.data.enabled;
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
    const previewPlayerIdParam = query.previewPlayerId;
    // Validate formation if provided
    let formation: number;
    if (typeof formationParam === "string" && formationParam.trim() !== "") {
      const raw = Number(formationParam);
      if (!Number.isInteger(raw) || !formationById(raw)) {
        return reply.code(400).send({ error: "Invalid formation" });
      }
      formation = raw;
    } else if (formationParam !== undefined && formationParam !== null && String(formationParam).trim() !== "") {
      return reply.code(400).send({ error: "Invalid formation" });
    } else {
      formation = club.tactics.formation;
    }
    const formationDef = formationById(formation)!;
    const lineup = peekLineup(
      { ...club, savedLineup: auto ? null : club.savedLineup, tactics: { ...club.tactics, formation } },
      loaded.world.players
    );
    const players = loaded.world.players.filter((p) => p.clubId === club.id);
    const gameDay = loaded.world.mp.absoluteGameDay ?? loaded.world.dayIndex;
    // §7 authority: game/outOfPosition.ts. This route must not re-derive
    // penalties, labels or adjusted ratings — four private copies of that
    // arithmetic had already drifted apart on what `null` means.
    const getPenalty = (player: typeof players[number], role: string): number | null =>
      rolePenalty(player.position, role as DeployedRole);
    const adjustedRating = (player: typeof players[number], role: string): number | null =>
      adjustedTacticalRating(player.skills, player.position, role as DeployedRole);
    const playerViewWithSlot = (p: typeof players[number], slotIndex: number | null, slot: ReturnType<typeof formationById> extends infer T ? T extends { slots: readonly (infer S)[] } ? S : never : never) => {
      const penalty = slot ? getPenalty(p, slot.role) : null;
      const label = suitabilityLabel(penalty);
      const rating = slot ? adjustedRating(p, slot.role) : null;
      return {
        id: p.id,
        name: p.name,
        naturalPosition: p.position,
        overall: p.overall,
        energy: p.energy,
        injuryDays: injuryDaysRemaining(p, gameDay),
        injuryDaysRemaining: injuryDaysRemaining(p, gameDay),
        injuryCause: p.injuryCause ?? null,
        injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
        conditionLabel: conditionLabel(p, gameDay),
        suspended: p.suspendedGames > 0,
        number: p.squadNumber ?? null,
        slotIndex,
        deployedRole: slot?.role ?? null,
        rolePenalty: penalty,
        suitabilityLabel: label,
        adjustedTacticalRating: rating,
      };
    };
    // Build starters with slot assignments
    const starters = (lineup?.starters ?? []).map((p, idx) => {
      const slot = formationDef.slots[idx];
      const player = players.find((x) => x.id === p.id) ?? p as unknown as typeof players[number];
      return playerViewWithSlot(player as typeof players[number], idx, slot as unknown as ReturnType<typeof formationById> extends infer T ? T extends { slots: readonly (infer S)[] } ? S : never : never);
    });
    // Handle previewPlayerId
    let previewPlayerId: number | undefined = undefined;
    let slotPreviews: Array<{ slotIndex: number; deployedRole: string; rolePenalty: number | null; suitabilityLabel: string; adjustedTacticalRating: number | null }> = [];
    if (previewPlayerIdParam !== undefined && String(previewPlayerIdParam).trim() !== "") {
      const rawId = Number(previewPlayerIdParam);
      if (!Number.isInteger(rawId)) return reply.code(400).send({ error: "Invalid previewPlayerId" });
      const previewPlayer = players.find((x) => x.id === rawId);
      if (!previewPlayer) return reply.code(400).send({ error: "Player not in squad" });
      previewPlayerId = rawId;
      slotPreviews = formationDef.slots.map((slot, idx) => {
        const penalty = getPenalty(previewPlayer, slot.role);
        const label = suitabilityLabel(penalty);
        const rating = adjustedRating(previewPlayer, slot.role);
        return {
          slotIndex: idx,
          deployedRole: slot.role,
          rolePenalty: penalty,
          suitabilityLabel: label,
          adjustedTacticalRating: rating,
        };
      });
    }
    const squadView = players
      .sort((a, b) => b.overall - a.overall)
      .map((p) => {
        return {
          id: p.id,
          name: p.name,
          naturalPosition: p.position,
          overall: p.overall,
          energy: p.energy,
          slotIndex: null,
          deployedRole: null,
          injuryDays: injuryDaysRemaining(p, gameDay),
          injuryDaysRemaining: injuryDaysRemaining(p, gameDay),
          injuryCause: p.injuryCause ?? null,
          injuryUntilAbsoluteGameDay: p.injuryUntilAbsoluteGameDay ?? null,
          conditionLabel: conditionLabel(p, gameDay),
          suspended: p.suspendedGames > 0,
          number: p.squadNumber ?? null,
        };
      });
    return {
      formation,
      // §15.3: `slots` IS the authoritative slot metadata. There is no numeric
      // slot array beside it — the index in this array is the slot index.
      slots: formationDef.slots.map((s, idx) => ({ index: idx, key: s.key, role: s.role, lane: s.lane, line: s.line, x: s.x, y: s.y, label: s.label })),
      starters,
      subs: (lineup?.subs ?? []).map((p) => {
        const player = players.find((x) => x.id === p.id) ?? p as unknown as typeof players[number];
        return playerViewWithSlot(player as typeof players[number], null, null as unknown as ReturnType<typeof formationById> extends infer T ? T extends { slots: readonly (infer S)[] } ? S : never : never);
      }),
      penaltyTakerId: club.penaltyTakerId,
      freeKickTakerId: club.savedLineup?.freeKickTakerId ?? null,
      squad: squadView,
      ...(previewPlayerId !== undefined ? { previewPlayerId, slotPreviews } : { slotPreviews: [] }),
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
      // Mandatory age promotion can push a club over the senior cap. While it
      // is over, renewals are blocked alongside every other voluntary addition
      // so the overflow has to be resolved rather than settled into.
      const overflow = seniorRosterOverflowError(world, club.id);
      if (overflow) return { error: { code: 400, body: { error: overflow } } };
      const seasons = parsed.data.contractSeasons;
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
        headline: "news.headline.contractRenewal",
        entries: [{ key: `renew:${player.id}`, label: player.name, detail: msg("news.detail.renewed", { count: seasons }) }],
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

  // Server-authoritative preview of what a promotion does and does NOT change.
  // Promotion accepts no contract term and no salary offer, so the UI can only
  // show the retained terms; the server re-verifies them inside the mutation.
  app.get("/players/:id/academy", async (req, reply) => {
    const loaded = await loadGlobalWorldReadOnly(app.prisma);
    const player = loaded?.world.players.find((p) => p.id === Number((req.params as { id: string }).id));
    if (!loaded) return reply.code(404).send({ error: "World not found" });
    if (!player) return reply.code(404).send({ error: "Player not found" });
    const rules = gameConfig.playerGenerationRules;
    const eligible = player.isYouth && player.age >= rules.academyVoluntaryPromotionAge;
    return {
      isYouth: player.isYouth,
      age: player.age,
      voluntaryPromotionAge: rules.academyVoluntaryPromotionAge,
      automaticPromotionAge: rules.academyAutomaticPromotionAge,
      contractEndAge: rules.academyContractEndAge,
      eligibleForVoluntaryPromotion: eligible,
      // Retained exactly on promotion — no renegotiation happens.
      retainedSalary: player.salary,
      retainedContractDays: player.contractDays,
      retainedContractSeasons: Math.round((player.contractDays / gameConfig.seasonDays) * 100) / 100,
      seniorRosterError: player.isYouth ? seniorRosterFullError(loaded.world, player.clubId ?? -1) : null,
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
      if (parsed.data.action === "promote" && isPaused(world)) return { error: worldPausedError };
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
        headline: "news.headline.tactics",
        entries: [{ key: `tactics:${world.dayIndex}`, label: club.name, detail: msg("news.detail.tactics") }],
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
  const seasonStart = world.mp.seasonStartAt ?? dayBoundaryAtOrBefore(Date.now());
  if (nextIndex < gameConfig.seasonDays) return seasonStart + nextIndex * 24 * 60 * 60 * 1000;
  // Payroll resumes on the first interval day of the next game season.
  return seasonStart + (gameConfig.seasonDays + interval - 1) * 24 * 60 * 60 * 1000;
}

function replyFrom(res: { error?: { code: number; body: unknown }; value?: unknown }, reply: import("fastify").FastifyReply) {
  if (res.error) return reply.code(res.error.code).send(res.error.body);
  return res.value;
}
