import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../store/game";

/**
 * Shared "advance to next match day" flow used by the Dashboard button
 * and the mobile play FAB. When a live match is already in progress it
 * resumes it; otherwise it advances to the next match day.
 */
export function useAdvanceDay() {
  const { advance, checkLiveMatch } = useGame();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const live = await checkLiveMatch();
      if (live) {
        navigate("/live-match");
        return true;
      }
      const result = await advance();
      if (!result) return false;
      if (result.seasonEnded) {
        navigate("/season-end");
        return true;
      }
      if (result.humanMatch || result.matchPending) {
        navigate("/live-match");
        return true;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, [advance, navigate, busy, checkLiveMatch]);

  return { busy, run };
}
