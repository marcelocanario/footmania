import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../store/game";

/**
 * Shared "advance to next match day" flow used by the Dashboard button
 * and the mobile play FAB. Navigates to the live match when the human
 * club plays, or to the season review when the year ends.
 */
export function useAdvanceDay() {
  const { advance } = useGame();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await advance();
      if (!result) return false;
      if (result.seasonEnded) {
        navigate("/season-end");
        return true;
      }
      if (result.humanMatch) {
        navigate("/live-match");
        return true;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, [advance, navigate, busy]);

  return { busy, run };
}
