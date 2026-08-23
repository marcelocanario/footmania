import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGame } from "../store/game";

/**
 * Live-match flow used by the Dashboard and mobile match shortcut: checks for an
 * in-progress live match and navigates to it if one exists.
 */
export function useLiveMatch() {
  const { checkLiveMatch } = useGame();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const id = await checkLiveMatch();
      if (id) {
        navigate("/live-match");
        return true;
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [checkLiveMatch, navigate, busy]);

  return { busy, run };
}
