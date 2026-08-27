import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { TabView, TabPanel } from "primereact/tabview";
import { Crown } from "lucide-react";
import { api, type FixtureView, type MatchEvents } from "../../api/client";
import { useGame } from "../../store/game";
import { MatchHistory } from "../MatchHistory";
import { MatchStatsPanel } from "../MatchStatsPanel";
import { PlayerDetailsDialog } from "../PlayerDetailsDialog";

/**
 * Finished-match popout shared by the Competitions screen and the admin
 * drill-down. Loads the event history for the clicked fixture.
 */
export function MatchResultDialog({ fixture, onClose }: { fixture: FixtureView | null; onClose: () => void }) {
  const user = useGame((s) => s.user);
  const [resultData, setResultData] = useState<MatchEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    if (fixture?.matchId == null) return;
    // Guard against a stale response landing after a rapid re-selection
    // (a slower earlier fetch resolving after a newer one has already set data).
    let active = true;
    setResultData(null);
    setBusy(true);
    api.matchEvents(fixture.matchId)
      .then((res) => { if (active) setResultData(res); })
      .catch(() => { if (active) onClose(); })
      .finally(() => { if (active) setBusy(false); });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture?.matchId]);

  const isPro = Boolean(user?.isPro);

  return (
    <>
      <Dialog
        header={resultData
          ? `${resultData.match.home} ${resultData.match.homeScore} – ${resultData.match.awayScore} ${resultData.match.away}`
          : fixture ? `${fixture.home} vs ${fixture.away}` : ""}
        visible={fixture !== null}
        onHide={onClose}
        dismissableMask
        style={{ width: 540 }}
      >
        {!resultData ? (
          <div className="empty-state" style={{ padding: 20 }}>{busy ? "Loading…" : "No data"}</div>
        ) : (
          <TabView>
            <TabPanel header="Events">
              <MatchHistory
                events={resultData.events}
                homeClubId={fixture?.homeClubId ?? 0}
                homeName={resultData.match.home}
                awayName={resultData.match.away}
                emptyText="No goals, cards or injuries to report."
                onPlayerClick={(id, name) => setPlayerTarget({ id, name })}
              />
            </TabPanel>
            <TabPanel
              header={isPro ? "Stats" : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Crown size={12} /> Stats</span>}
            >
              {!isPro ? (
                <div className="empty-state" style={{ padding: 20 }}>
                  Detailed match stats are a <b>Pro</b> feature.
                </div>
              ) : resultData.match.stats ? (
                <MatchStatsPanel stats={resultData.match.stats} />
              ) : (
                <div className="empty-state" style={{ padding: 14 }}>No stats available.</div>
              )}
            </TabPanel>
          </TabView>
        )}
      </Dialog>
      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </>
  );
}
