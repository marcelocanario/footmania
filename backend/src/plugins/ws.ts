import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadGlobalWorld, persistWorld } from "../services/saveService";
import { liveStateView } from "../services/liveView";
import { performLiveSub, isPregame, isHalftime, rebuildLiveHumanLineup, markHalftimeReady } from "../game/match";
import { advanceLiveMatches } from "../game/world";
import { withGlobalLock } from "../services/lock";
import { applySavedLineup } from "../game/club";
import { StaleWorldError } from "../services/saveService";
import { hasPro } from "../services/pro";
import { createNotification, notifyMatchFinished } from "../services/notifications";
import { EVENT_CODES } from "../game/constants";

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

function broadcastState(world: import("../game/types").World) {
  for (const st of world.liveMatches) {
    for (const ws of conns.get(st.matchId) ?? []) {
      const meta = (ws as WebSocket & { meta?: { userId: number } }).meta;
      const viewerClub = meta ? world.clubs.find((club) => club.ownerUserId === meta.userId) : undefined;
      if (!meta || !viewerClub || (viewerClub.id !== st.homeClubId && viewerClub.id !== st.awayClubId)) continue;
      send(ws, { type: "state", state: liveStateView(world, st, meta.userId) });
    }
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
        const meta = { matchId, userId } as { matchId: number; userId: number };
        (ws as WebSocket & { meta?: typeof meta }).meta = meta;
        let set = conns.get(matchId);
        if (!set) {
          set = new Set();
          conns.set(matchId, set);
        }
        set.add(ws);
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
  let msg: { type?: string; minutes?: number; outId?: number; inId?: number; resume?: boolean; formation?: number; starters?: number[]; subs?: number[]; penaltyTakerId?: number | null; freeKickTakerId?: number | null; enabled?: boolean };
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
  if (msg.type !== "tick" && msg.type !== "sub" && msg.type !== "state" && msg.type !== "lineup" && msg.type !== "automation" && msg.type !== "halftimeReady") {
    send(ws, { type: "error", message: "Unknown message type" });
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withGlobalLock(async () => {
    const loaded = await loadGlobalWorld(app.prisma);
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
        const isParticipant = humanClub !== undefined && (st.homeClubId === humanClub.id || st.awayClubId === humanClub.id);
        if (msg.type === "state" && !isParticipant) {
          send(ws, { type: "error", message: "You are not a participant in this match" });
          return;
        }
        if (msg.type === "tick") {
          if (!isParticipant) {
            send(ws, { type: "error", message: "You are not a participant in this match" });
            return;
          }
        const beforeEvents = st.events.length;
        const finished = advanceLiveMatches(world, Date.now());
        const res = {
          events: st.events.slice(beforeEvents),
          atHalfTime: isHalftime(st),
        };
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        // Best-effort inbox notifications for finished matches + pro goal pushes
        for (const m of finished) {
          try {
            await notifyMatchFinished(app.prisma, world, m);
          } catch {}
        }
        // Pro goal push (best-effort)
        try {
          const goalEvents = res.events.filter((e) => e.type === EVENT_CODES.GOAL);
          if (goalEvents.length > 0) {
            const u = await app.prisma.user.findUnique({ where: { id: meta.userId } });
            if (u && hasPro(u as never)) {
              for (const g of goalEvents) await createNotification(app.prisma, meta.userId, "MATCH_GOAL", { matchId: st.matchId, fixtureId: st.fixtureId, minute: g.minute, clubId: g.clubId, scores: st.scores });
            }
          }
        } catch {}
        send(ws, { type: "tick", events: res.events, atHalfTime: res.atHalfTime, state: liveStateView(world, st, meta.userId) });
        if (st.ended || !world.liveMatches.some((match) => match.matchId === meta.matchId)) {
          for (const ws2 of conns.get(meta.matchId) ?? []) send(ws2, { type: "finished", matchId: meta.matchId });
        } else {
          broadcastState(world);
        }
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
        broadcastState(world);
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
        rebuildLiveHumanLineup(st, humanClub, world.players);
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        send(ws, { type: "lineup", state: liveStateView(world, st, meta.userId) });
        broadcastState(world);
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
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        send(ws, { type: "automation", enabled, state: liveStateView(world, st, meta.userId) });
        broadcastState(world);
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
        await persistWorld(app.prisma, loaded.save.id, loaded.save.id, world, loaded.save.revision);
        send(ws, { type: "halftimeReady", state: liveStateView(world, st, meta.userId) });
        broadcastState(world);
        return;
      }
      // Matches advance only on the server clock: the "tick" message is a
      // strictly elapsed-time catch-up for viewers and can never accelerate
      // play. There is deliberately no client-driven finish/force-advance.
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
