import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "primereact/dialog";
import { TabView, TabPanel } from "primereact/tabview";
import { Crown } from "lucide-react";
import { api, type FixtureView, type MatchEvents } from "../../api/client";
import { useGame } from "../../store/game";
import { MatchHistory } from "../MatchHistory";
import { PlayerScoresTable } from "../PlayerScoresTable";
import { MatchStatsPanel } from "../MatchStatsPanel";
import { PlayerDetailsDialog } from "../PlayerDetailsDialog";

/**
 * Finished-match popout shared by the Competitions screen and the admin
 * drill-down. Loads the event history for the clicked fixture.
 */
export function MatchResultDialog({ fixture, onClose }: { fixture: FixtureView | null; onClose: () => void }) {
  const { t } = useTranslation();
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
          <div className="empty-state" style={{ padding: 20 }}>{busy ? t("matchResult.loading") : t("matchResult.noData")}</div>
        ) : (
          <TabView>
            <TabPanel header={t("matchResult.events")}>
              <MatchHistory
                events={resultData.events}
                homeClubId={fixture?.homeClubId ?? 0}
                homeName={resultData.match.home}
                awayName={resultData.match.away}
                emptyText={t("matchResult.noEvents")}
                onPlayerClick={(id, name) => setPlayerTarget({ id, name })}
              />
            </TabPanel>
            <TabPanel header={t("matchResult.scores")}>
              <PlayerScoresTable
                scores={resultData.scores ?? []}
                homeClubId={fixture?.homeClubId ?? 0}
                onPlayerClick={(id, name) => setPlayerTarget({ id, name })}
                emptyText={t("matchResult.noScores")}
              />
            </TabPanel>
            <TabPanel
              header={isPro ? t("matchResult.stats") : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Crown size={12} /> {t("matchResult.stats")}</span>}
            >
              {!isPro ? (
                <div className="empty-state" style={{ padding: 20 }}>
                  {t("matchResult.statsPro")}
                </div>
              ) : resultData.match.stats ? (
                <MatchStatsPanel
                  stats={resultData.match.stats}
                  mvp={{ name: resultData.match.mvpPlayerName ?? null, clubName: null }}
                />
              ) : (
                <div className="empty-state" style={{ padding: 14 }}>{t("matchResult.noStats")}</div>
              )}
            </TabPanel>
          </TabView>
        )}
      </Dialog>
      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </>
  );
}
