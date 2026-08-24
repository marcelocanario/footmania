import { useEffect, useState } from "react";

// A single shared 1s ticker for every mounted countdown, instead of each
// AuctionCountdown row (auctions/free-agent/loan listings can easily number
// in the dozens) running its own independent setInterval. Behavior per
// instance is unchanged: each subscriber still re-renders once a second with
// a fresh Date.now().
type TickListener = (now: number) => void;
const tickListeners = new Set<TickListener>();
let tickIntervalId: number | null = null;

function subscribeTick(listener: TickListener): () => void {
  tickListeners.add(listener);
  if (tickIntervalId === null) {
    tickIntervalId = window.setInterval(() => {
      const now = Date.now();
      for (const l of tickListeners) l(now);
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickIntervalId !== null) {
      window.clearInterval(tickIntervalId);
      tickIntervalId = null;
    }
  };
}

/** Re-renders every second until `targetMs` passes, then returns 0. */
export function useCountdown(targetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeTick(setNow), []);
  return Math.max(0, targetMs - now);
}

/** "04:31:22" or "1d 04:31:22" for a millisecond duration. */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmmss = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${hhmmss}` : hhmmss;
}
