import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useGame } from "../store/game";

interface MpWsMessage {
  type: string;
  scope?: string;
  matchId?: number;
  userId?: number;
}

/**
 * User-scoped WebSocket manager for the multiplayer world socket (`/api/mp/ws`).
 *
 * Replaces the old 8-second polling loop in `useLiveMatchWatcher`. The socket
 * pushes live-match start/end events and cache-invalidation scopes, so the UI
 * stays fresh without hammering the backend. Reconnect uses exponential
 * backoff (5s … 60s cap). If the server does not support the socket, it
 * degrades to no polling — cached data and on-demand fetches remain available.
 *
 * The match-specific WebSocket in `LiveMatch.tsx` (per-match `/api/matches/:id/ws`)
 * is preserved and untouched.
 */
export function useMpSocket() {
  const { user, setUser, setLiveMatch, refresh } = useGame();
  const [attempts, setAttempts] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(5_000);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Only connect when authenticated. The `user` is set by the Gate component
    // on app load; `attempts` drives reconnection via exponential backoff.
    if (!user) return;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/mp/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    ws.onopen = () => {
      backoffRef.current = 5_000; // reset backoff on successful connect
      // WebSocket events are ephemeral, so re-read the authoritative session
      // state after every connection or reconnect.
      void api.me().then((res) => setUser(res.user)).catch(() => undefined);
    };

    // Heartbeat: send ping every 30s to keep the socket alive through proxies
    // that silently drop idle connections.
    pingRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30_000);

    ws.onmessage = (ev) => {
      let msg: MpWsMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case "liveMatchStarted":
          setLiveMatch(msg.matchId ?? null);
          break;
        case "liveMatchEnded":
          setLiveMatch(null);
          api.cache.invalidate();
          void refresh();
          break;
        case "invalidate":
          // Server pushes a scope (e.g. "mp", "club", "transfers") to tell us
          // exactly what went stale.
          api.cache.invalidate(msg.scope);
           if (!msg.scope || msg.scope === "mp" || msg.scope === "club" || msg.scope === "records") {
             void refresh();
           }
          break;
        case "mpStatus":
          void refresh();
          break;
        case "permissionsChanged":
          void api.me().then((res) => setUser(res.user)).catch(() => undefined);
          break;
        case "pong":
          // heartbeat ack — nothing to do
          break;
      }
    };

    ws.onclose = () => {
      if (pingRef.current) clearInterval(pingRef.current);
      wsRef.current = null;
      if (disposed) return;

      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 1.5, 60_000);
      reconnectTimer = setTimeout(() => setAttempts((a) => a + 1), delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => {
      disposed = true;
      if (pingRef.current) clearInterval(pingRef.current);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    };
    }, [user?.id, attempts, setUser, setLiveMatch, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
}
