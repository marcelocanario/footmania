import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadGlobalWorldMutable, persistLiveMatchState, persistWorld } from "../services/saveService";
import { liveStateView, liveStateDeltaView, viewerFieldsFor } from "../services/liveView";
import { applyLiveTacticsUpdate, performLiveSub, isPregame, isHalftime, rebuildLiveHumanLineup, markHalftimeReady } from "../game/match";
import { withGlobalLock } from "../services/lock";
import { applySavedLineup } from "../game/club";
import { StaleWorldError } from "../services/saveService";
import { readUserLiveMatch } from "../services/readService";
import { registerWorldEventPublisher, registerConnectedUsersProvider } from "../services/worldEvents";
import { registerLiveMatchBroadcaster, type LiveMatchUpdate } from "../services/liveMatchEvents";

const COOKIE_NAME = "fm_session";
const conns = new Map<number, Set<WebSocket>>();
const userConns = new Map<number, Set<WebSocket>>();

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(world: import("../game/types").World, matchId?: number) {
  for (const st of world.liveMatches) {
    if (matchId !== undefined && st.matchId !== matchId) continue;
    const sockets = conns.get(st.matchId);
    if (!sockets || sockets.size === 0) continue;
    // Live matches are public: every connected spectator receives state, not
    // just the two participants. Everything in the view is identical across
    // spectators except humanSide/isParticipant (services/liveView.ts), so
    // compute the shared payload once per match and patch those two fields
    // in per socket instead of rebuilding the whole view per viewer.
    const base = liveStateView(world, st, null);
    for (const ws of sockets) {
      const meta = (ws as WebSocket & { meta?: { userId: number } }).meta;
      if (!meta) continue;
      send(ws, { type: "state", state: { ...base, ...viewerFieldsFor(world, st, meta.userId) } });
    }
  }
}

function broadcastLiveMatchUpdates(world: import("../game/types").World, updates: LiveMatchUpdate[]) {
  for (const update of updates) {
    const sockets = conns.get(update.matchId);
    if (!sockets || sockets.size === 0) continue;
    const state = world.liveMatches.find((candidate) => candidate.matchId === update.matchId);
    const finished = update.finished || !state;
    // liveStateDeltaView carries no viewer-specific fields at all, and
    // liveStateView's only per-viewer fields are humanSide/isParticipant, so
    // compute the shared payload once per match per update, not per socket.
    const fullState = !finished && update.phaseChanged ? liveStateView(world, state!, null) : null;
    const delta = !finished && !update.phaseChanged ? liveStateDeltaView(world, state!, update.eventStart) : null;
    for (const ws of sockets) {
      const meta = (ws as WebSocket & { meta?: { userId: number } }).meta;
      // Spectators follow the match too; control messages remain
      // participant-gated in handleMessage below.
      if (!meta) continue;
      if (finished) {
        send(ws, { type: "finished", matchId: update.matchId });
      } else if (fullState) {
        send(ws, { type: "state", state: { ...fullState, ...viewerFieldsFor(world, state!, meta.userId) } });
      } else {
        send(ws, { type: "delta", delta });
      }
    }
  }
}

function reject(socket: import("node:net").Socket) {
  socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
  socket.destroy();
}

const wsPlugin: FastifyPluginAsync = async (app) => {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => {
    for (const set of [...conns.values(), ...userConns.values()]) {
      for (const ws of set) {
        const socket = ws as WebSocket & { isAlive?: boolean };
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  registerWorldEventPublisher((userId, event) => {
    for (const ws of userConns.get(userId) ?? []) send(ws, event);
  });
  // World-wide broadcasts (world reset) need the full connected-user set.
  registerConnectedUsersProvider(() => userConns.keys());
  registerLiveMatchBroadcaster(broadcastLiveMatchUpdates);

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const set of conns.values()) {
      for (const ws of set) ws.terminate();
    }
    for (const set of userConns.values()) {
      for (const ws of set) ws.terminate();
    }
    conns.clear();
    userConns.clear();
    registerWorldEventPublisher(null);
    registerConnectedUsersProvider(null);
    registerLiveMatchBroadcaster(null);
    wss.close();
  });

  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathMatch = url.pathname.match(/^\/api\/matches\/(\d+)\/ws$/);
    const isWorldSocket = url.pathname === "/api/mp/ws";
    if (!pathMatch && !isWorldSocket) return;
    const matchId = pathMatch ? Number(pathMatch[1]) : null;
    const netSocket = socket as import("node:net").Socket;
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    void (async () => {
      if (!token) {
        reject(netSocket);
        return;
      }
      const session = await app.prisma.session.findUnique({ where: { token }, include: { user: true } });
      if (!session || session.expiresAt < new Date()) {
        reject(netSocket);
        return;
      }
      if ((session.user as unknown as { bannedAt?: Date | null }).bannedAt) {
        reject(netSocket);
        return;
      }
      const userId = session.userId;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (isWorldSocket) {
          const set = userConns.get(userId) ?? new Set<WebSocket>();
          userConns.set(userId, set);
          set.add(ws);
          const socket = ws as WebSocket & { isAlive?: boolean };
          socket.isAlive = true;
          ws.on("pong", () => { socket.isAlive = true; });
          ws.on("close", () => {
            set.delete(ws);
            if (set.size === 0) userConns.delete(userId);
          });
          ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString()) as { type?: string };
              if (msg.type === "ping") send(ws, { type: "pong" });
              else send(ws, { type: "error", message: "Unknown message type" });
            } catch {
              send(ws, { type: "error", message: "Invalid message" });
            }
          });
          void readUserLiveMatch(app.prisma, userId).then((result) => {
            if (result?.match) send(ws, { type: "liveMatchStarted", matchId: result.match.id });
          }).catch(() => undefined);
          return;
        }

        if (matchId === null) {
          ws.close(1008, "Match id missing");
          return;
        }
        const meta = { matchId, userId };
        (ws as WebSocket & { meta?: typeof meta }).meta = meta;
        let set = conns.get(matchId);
        if (!set) {
          set = new Set();
          conns.set(matchId, set);
        }
        set.add(ws);
        const socket = ws as WebSocket & { isAlive?: boolean };
        socket.isAlive = true;
        ws.on("pong", () => { socket.isAlive = true; });
        ws.on("close", () => {
          set?.delete(ws);
          if (set && set.size === 0) conns.delete(matchId);
        });
        ws.on("message", (raw) => {
          void handleMessage(app, ws, meta, raw.toString());
        });
      });
    })();
  });
};

async function handleMessage(
  app: FastifyInstance,
  ws: WebSocket,
  meta: { matchId: number; userId: number },
  raw: string
) {
  let msg: { type?: string; minutes?: number; outId?: number; inId?: number; resume?: boolean; formation?: number; starters?: number[]; subs?: number[]; penaltyTakerId?: number | null; freeKickTakerId?: number | null; enabled?: boolean; style?: number; pressing?: number; direction?: number };
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: "error", message: "Invalid message" });
    return;
  }
  if (!msg || typeof msg !== "object") {
    send(ws, { type: "error", message: "Invalid message" });
    return;
  }
  if (msg.type === "ping") {
    send(ws, { type: "pong" });
    return;
  }
  if (msg.type !== "sub" && msg.type !== "state" && msg.type !== "lineup" && msg.type !== "tactics" && msg.type !== "automation" && msg.type !== "halftimeReady") {
    send(ws, { type: "error", message: "Unknown message type" });
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withGlobalLock(async () => {
    const loaded = await loadGlobalWorldMutable(app.prisma);
    if (!loaded) {
      send(ws, { type: "error", message: "World not found" });
      return;
    }
    const world = loaded.world;
    const st = world.liveMatches.find((s) => s.matchId === meta.matchId);
    if (!st) {
      send(ws, { type: "error", message: "No live match for this match id" });
      return;
    }
    const home = world.clubs.find((c) => c.id === st.homeClubId);
    const away = world.clubs.find((c) => c.id === st.awayClubId);
    if (!home || !away) {
      send(ws, { type: "error", message: "Match clubs missing" });
      return;
    }
      const humanClub = world.clubs.find((c) => c.ownerUserId === meta.userId);
      try {
        // Read-only spectating: everyone may pull the current state. Every
        // mutating message type below re-checks participation on its own.
        if (msg.type === "state") {
          send(ws, { type: "state", state: liveStateView(world, st, meta.userId) });
          return;
        }
      if (msg.type === "sub") {
        if (st.ended) {
          send(ws, { type: "error", message: "Match already finished" });
          return;
        }
        if (!humanClub || (st.homeClubId !== humanClub.id && st.awayClubId !== humanClub.id)) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        const humanSide = st.homeClubId === humanClub.id ? 0 : 1;
        const res = performLiveSub(world.rng, home, away, world.players, st, humanSide, msg.outId ?? -1, msg.inId ?? -1);
        if (res.error) {
          send(ws, { type: "sub", error: res.error, state: liveStateView(world, st, meta.userId) });
          return;
        }
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        send(ws, { type: "sub", event: res.event, state: liveStateView(world, st, meta.userId) });
        broadcastState(world, meta.matchId);
        return;
      }
      if (msg.type === "tactics") {
        if (msg.formation !== undefined) {
          send(ws, { type: "tactics", error: "Formation can only be changed before kickoff or at half-time", state: liveStateView(world, st, meta.userId) });
          return;
        }
        if (!humanClub || (st.homeClubId !== humanClub.id && st.awayClubId !== humanClub.id)) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        const side = st.homeClubId === humanClub.id ? 0 : 1;
        const error = applyLiveTacticsUpdate(st, side, { style: msg.style, pressing: msg.pressing, direction: msg.direction }, {
          familiarityMap: humanClub.tacticFamiliarity,
          absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex,
        });
        if (error) {
          send(ws, { type: "tactics", error, state: liveStateView(world, st, meta.userId) });
          return;
        }
        await persistLiveMatchState(app.prisma, loaded.save.id, loaded.save.id, st, world.rng.state, loaded.save.revision);
        send(ws, { type: "tactics", state: liveStateView(world, st, meta.userId) });
        broadcastState(world, meta.matchId);
        return;
      }
      if (msg.type === "lineup") {
        if (!isPregame(st) && !isHalftime(st)) {
          send(ws, { type: "error", message: "The match already started" });
          return;
        }
        if (!Array.isArray(msg.starters) || msg.starters.length !== 11 || !Array.isArray(msg.subs)) {
          send(ws, { type: "error", message: "Invalid lineup" });
          return;
        }
        if (!humanClub || (st.homeClubId !== humanClub.id && st.awayClubId !== humanClub.id)) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        const input = {
          formation: msg.formation ?? 4,
          starters: msg.starters,
          subs: msg.subs,
          penaltyTakerId: msg.penaltyTakerId ?? null,
          freeKickTakerId: msg.freeKickTakerId ?? null,
        };
        const err = applySavedLineup(humanClub, world.players, input);
        if (err) {
          send(ws, { type: "lineup", error: err, state: liveStateView(world, st, meta.userId) });
          return;
        }
        rebuildLiveHumanLineup(st, humanClub, world.players, { absoluteGameDay: world.mp.absoluteGameDay ?? world.dayIndex });
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        send(ws, { type: "lineup", state: liveStateView(world, st, meta.userId) });
        broadcastState(world, meta.matchId);
        return;
      }
      if (msg.type === "automation") {
        if (!humanClub || (st.homeClubId !== humanClub.id && st.awayClubId !== humanClub.id)) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        const side = st.homeClubId === humanClub.id ? 0 : 1;
        const enabled = Boolean(msg.enabled);
        st.automationDisabled ??= [false, false];
        st.automationDisabled[side] = !enabled;
        await persistLiveMatchState(app.prisma, loaded.save.id, loaded.save.id, st, world.rng.state, loaded.save.revision);
        send(ws, { type: "automation", enabled, state: liveStateView(world, st, meta.userId) });
        broadcastState(world, meta.matchId);
        return;
      }
      if (msg.type === "halftimeReady") {
        if (!isHalftime(st)) {
          send(ws, { type: "error", message: "Match is not at halftime" });
          return;
        }
        if (!humanClub || (st.homeClubId !== humanClub.id && st.awayClubId !== humanClub.id)) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        const side = st.homeClubId === humanClub.id ? 0 : 1;
        markHalftimeReady(world, st, side as 0 | 1);
        await persistLiveMatchState(app.prisma, loaded.save.id, loaded.save.id, st, world.rng.state, loaded.save.revision);
        send(ws, { type: "halftimeReady", state: liveStateView(world, st, meta.userId) });
        broadcastState(world, meta.matchId);
        return;
      }
      // The worker advances matches on the server clock. This message only
      // returns the latest authoritative state for a participant.
      send(ws, { type: "state", state: liveStateView(world, st, meta.userId) });
    } catch (e) {
      if (e instanceof StaleWorldError) throw e;
      send(ws, { type: "error", message: (e as Error).message });
    }
      });
      return;
    } catch (e) {
      if (!(e instanceof StaleWorldError) || attempt === 2) {
        send(ws, { type: "error", message: (e as Error).message });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export default wsPlugin;
