import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadWorld, persistWorld } from "../services/saveService";
import { liveStateView } from "../services/liveView";
import { performLiveSub, tickLiveMatch, isPregame, rebuildLiveHumanLineup } from "../game/match";
import { finalizeLiveMatch } from "../game/world";
import { withSaveLock } from "../services/lock";
import { applySavedLineup } from "../game/club";
import { serializeDayResult } from "../routes/saves";
import type { World } from "../game/types";

const COOKIE_NAME = "fm_session";
const conns = new Map<number, Set<WebSocket>>();

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

function broadcastState(saveId: number, world: World) {
  const st = world.liveMatch;
  if (!st) return;
  const view = liveStateView(world, st);
  for (const ws of conns.get(saveId) ?? []) {
    send(ws, { type: "state", state: view });
  }
}

function reject(socket: import("node:net").Socket) {
  socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
  socket.destroy();
}

const wsPlugin: FastifyPluginAsync = async (app) => {
  const wss = new WebSocketServer({ noServer: true });

  app.addHook("onClose", async () => {
    for (const set of conns.values()) {
      for (const ws of set) ws.terminate();
    }
    conns.clear();
    wss.close();
  });

  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathMatch = url.pathname.match(/^\/api\/matches\/(\d+)\/ws$/);
    if (!pathMatch) return;
    const matchId = Number(pathMatch[1]);
    const saveId = Number(url.searchParams.get("saveId") ?? "0");
    const netSocket = socket as import("node:net").Socket;
    if (!saveId) {
      reject(netSocket);
      return;
    }
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
      const userId = session.userId;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const meta = { saveId, matchId, userId } as { saveId: number; matchId: number; userId: number };
        (ws as WebSocket & { meta?: typeof meta }).meta = meta;
        let set = conns.get(saveId);
        if (!set) {
          set = new Set();
          conns.set(saveId, set);
        }
        set.add(ws);
        ws.on("close", () => {
          set?.delete(ws);
          if (set && set.size === 0) conns.delete(saveId);
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
  meta: { saveId: number; matchId: number; userId: number },
  raw: string
) {
  let msg: { type?: string; minutes?: number; outId?: number; inId?: number; resume?: boolean; formation?: number; starters?: number[]; subs?: number[]; penaltyTakerId?: number | null; freeKickTakerId?: number | null };
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
  if (msg.type !== "tick" && msg.type !== "sub" && msg.type !== "finish" && msg.type !== "state" && msg.type !== "lineup") {
    send(ws, { type: "error", message: "Unknown message type" });
    return;
  }
  await withSaveLock(meta.saveId, async () => {
    const loaded = await loadWorld(app.prisma, meta.saveId, meta.userId);
    if (!loaded) {
      send(ws, { type: "error", message: "Save not found" });
      return;
    }
    const world = loaded.world;
    const st = world.liveMatch;
    if (!st || st.matchId !== meta.matchId) {
      send(ws, { type: "error", message: "No live match for this save" });
      return;
    }
    const home = world.clubs.find((c) => c.id === st.homeClubId);
    const away = world.clubs.find((c) => c.id === st.awayClubId);
    if (!home || !away) {
      send(ws, { type: "error", message: "Match clubs missing" });
      return;
    }
    try {
      if (msg.type === "tick") {
        const minutes = Math.max(1, Math.min(10, Math.round(msg.minutes ?? 1)));
        const res = tickLiveMatch(world.rng, home, away, world.players, st, minutes, { resume: msg.resume === true });
        await persistWorld(app.prisma, meta.saveId, meta.userId, world);
        send(ws, { type: "tick", events: res.events, atHalfTime: res.atHalfTime, state: liveStateView(world, st) });
        broadcastState(meta.saveId, world);
        return;
      }
      if (msg.type === "sub") {
        if (st.ended) {
          send(ws, { type: "error", message: "Match already finished" });
          return;
        }
        const humanSide = st.homeClubId === world.humanClubId ? 0 : 1;
        const res = performLiveSub(world.rng, home, away, world.players, st, humanSide, msg.outId ?? -1, msg.inId ?? -1);
        if (res.error) {
          send(ws, { type: "sub", error: res.error, state: liveStateView(world, st) });
          return;
        }
        await persistWorld(app.prisma, meta.saveId, meta.userId, world);
        send(ws, { type: "sub", event: res.event, state: liveStateView(world, st) });
        broadcastState(meta.saveId, world);
        return;
      }
      if (msg.type === "lineup") {
        if (!isPregame(st)) {
          send(ws, { type: "error", message: "The match already started" });
          return;
        }
        if (!Array.isArray(msg.starters) || msg.starters.length !== 11 || !Array.isArray(msg.subs)) {
          send(ws, { type: "error", message: "Invalid lineup" });
          return;
        }
        const input = {
          formation: msg.formation ?? 4,
          starters: msg.starters,
          subs: msg.subs,
          penaltyTakerId: msg.penaltyTakerId ?? null,
          freeKickTakerId: msg.freeKickTakerId ?? null,
        };
        const humanClub = st.homeClubId === world.humanClubId ? home : away;
        const err = applySavedLineup(humanClub, world.players, input);
        if (err) {
          send(ws, { type: "lineup", error: err, state: liveStateView(world, st) });
          return;
        }
        rebuildLiveHumanLineup(st, humanClub, world.players);
        await persistWorld(app.prisma, meta.saveId, meta.userId, world);
        send(ws, { type: "lineup", state: liveStateView(world, st) });
        broadcastState(meta.saveId, world);
        return;
      }
      if (msg.type === "finish") {
        if (!st.ended) {
          tickLiveMatch(world.rng, home, away, world.players, st, 200, { ignoreHalfTime: true });
        }
        const dayResult = finalizeLiveMatch(world);
        await persistWorld(app.prisma, meta.saveId, meta.userId, world);
        const payload = serializeDayResult(world, dayResult);
        for (const ws2 of conns.get(meta.saveId) ?? []) {
          send(ws2, { type: "finished", dayResult: payload });
        }
        return;
      }
      send(ws, { type: "state", state: liveStateView(world, st) });
    } catch (e) {
      send(ws, { type: "error", message: (e as Error).message });
    }
  });
}

export default wsPlugin;
