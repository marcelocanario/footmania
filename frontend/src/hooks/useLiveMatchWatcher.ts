import { useEffect } from "react";
import { useGame } from "../store/game";

/**
 * Keeps the global "a human match is live right now" flag in sync with the
 * backend so the whole UI can swap Continue for "Resume match" while a match
 * is in progress.
 */
export function useLiveMatchWatcher() {
  const checkLiveMatch = useGame((s) => s.checkLiveMatch);
  useEffect(() => {
    void checkLiveMatch();
    const iv = setInterval(() => void checkLiveMatch(), 8000);
    return () => clearInterval(iv);
  }, [checkLiveMatch]);
}
