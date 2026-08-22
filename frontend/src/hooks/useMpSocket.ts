import { useEffect, useRef, useState } from "react";
import { api, type MarketUpdate } from "../api/client";
import { useGame } from "../store/game";

interface MpWsMessage {
  type: string;
  scope?: string;
  matchId?: number;
  userId?: number;
  marketType?: "TRANSFER" | "FREE_AGENT";
  listingId?: number;
  status?: string;
  currentPrice?: number;
  deadline?: number;
  bidderCount?: number;
  amILeading?: boolean;
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
 * carries server-driven match deltas and manager commands.
 */
export function useMpSocket() {
  const { user, setUser, setLiveMatch, refresh } = useGame();
  const [attempts, setAttempts] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(5_000);

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
        case "dayAdvanced":
          void refresh();
          break;
        case "marketUpdated": {
          if (msg.marketType && msg.listingId !== undefined && msg.status) {
            api.cache.emitMarketUpdated({
              type: "marketUpdated",
              marketType: msg.marketType,
              listingId: msg.listingId,
              status: msg.status,
              ...(msg.currentPrice !== undefined ? { currentPrice: msg.currentPrice } : {}),
              ...(msg.deadline !== undefined ? { deadline: msg.deadline } : {}),
              ...(msg.bidderCount !== undefined ? { bidderCount: msg.bidderCount } : {}),
              ...(msg.amILeading !== undefined ? { amILeading: msg.amILeading } : {}),
            } satisfies MarketUpdate);
          }
          break;
        }
        case "permissionsChanged":
          void api.me().then((res) => setUser(res.user)).catch(() => undefined);
          break;
        case "pong":
          // heartbeat ack — nothing to do
          break;
      }
    };

    ws.onclose = () => {
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    };
    }, [user?.id, attempts, setUser, setLiveMatch, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
}
