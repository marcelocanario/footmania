import { useEffect } from "react";
import { useGame } from "../store/game";
import { useMpSocket } from "./useMpSocket";

/**
 * Keeps the global "a match is live right now" flag in sync so the whole UI
 * can show a dashboard "Go to match" action while a match
 * is in progress.
 *
 * Previously this polled `/api/mp/live-match` every 8 seconds. Now it mounts
 * the user-scoped `useMpSocket` WebSocket manager (/api/mp/ws) which pushes
 * liveMatchStarted/LiveEnded events and cache invalidation directly, so there
 * is no fixed-interval polling. Falls back gracefully when the socket is
 * unavailable — the store still has cached data and `checkLiveMatch` can be
 * called on-demand.
 */
export function useLiveMatchWatcher() {
  useMpSocket();

  const checkLiveMatch = useGame((s) => s.checkLiveMatch);
  useEffect(() => {
    void checkLiveMatch();
  }, [checkLiveMatch]);
}
