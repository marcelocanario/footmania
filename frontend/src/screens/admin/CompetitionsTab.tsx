import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { TabView, TabPanel } from "primereact/tabview";
import { api, type FixtureView, type StandingsRow } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { groupLabel } from "../../components/competition/shared";
import { StandingsTable } from "../../components/competition/StandingsTable";
import { FixturesList } from "../../components/competition/FixturesList";
import { MatchResultDialog } from "../../components/competition/MatchResultDialog";
import { ClubModerationDialog } from "./ClubModerationDialog";

/**
 * Admin world browser: the full division/group tree on the left and the
 * selected group's standings/fixtures on the right. Reuses the same
 * competition endpoints (`/mp/pyramid`, `/mp/divisions/:id/…`) and extracted
 * components as the player-facing Competitions screen. Clicking a team opens
 * the club moderation drawer.
 */
export function CompetitionsTab({ version, notify }: TabProps) {
  const pyramid = useAdminFetch(() => api.pyramid(), [version]);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [expandedTiers, setExpandedTiers] = useState<Set<number>>(new Set());
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);
  const [resultFixture, setResultFixture] = useState<FixtureView | null>(null);
  const [moderationClubId, setModerationClubId] = useState<number | null>(null);

  const tiers = useMemo(() => [...(pyramid.data?.tiers ?? [])].sort((a, b) => a.tier - b.tier), [pyramid.data]);
  const allDivisions = useMemo(() => tiers.flatMap((level) => level.divisions), [tiers]);
  const selected = allDivisions.find((d) => d.id === selectedDiv) ?? null;

  // Pre-select the top of the pyramid once it arrives.
  useEffect(() => {
    const first = tiers[0]?.divisions[0];
    if (selectedDiv === null && first) selectDivision(first.tier, first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers]);

  useEffect(() => {
    if (selectedDiv === null) return;
    // Guard against a stale, slower response from a previously selected
    // division overwriting the table/fixtures for the one selected now.
    let active = true;
    api.divisionStandings(selectedDiv).then((res) => { if (active) setTable(res.standings); }).catch(() => undefined);
    api.divisionFixtures(selectedDiv).then((res) => { if (active) setFixtures(res.fixtures); }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedDiv]);

  const selectDivision = (tier: number, id: number) => {
    setSelectedDiv(id);
    // Keep the chosen branch open; collapse nothing else.
    setExpandedTiers((prev) => new Set(prev).add(tier));
  };

  const toggleTier = (tier: number) =>
    setExpandedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });

  const seasonComplete = fixtures.length > 0 && fixtures.every((f) => f.played);
  const seasonKey = pyramid.data?.seasonKey ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <AdminCard
        icon={<ListTree size={17} />}
        title="World browser"
        subtitle="Every division and group of the active season. Click a group for its table and fixtures; click a team inside a table for moderation actions."
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="card" style={{ width: 290, padding: 10, flexShrink: 0, background: "var(--bg-2)" }}>
            {pyramid.loading && <div className="empty-state" style={{ padding: 20 }}>Loading…</div>}
            {pyramid.error && <div style={{ color: "#ff6b6b", fontSize: "0.85rem" }}>{pyramid.error}</div>}
            {!pyramid.loading && !pyramid.error && tiers.length === 0 && <div className="empty-state" style={{ padding: 20 }}>No active divisions.</div>}
            {tiers.map((level) => {
              const expanded = expandedTiers.has(level.tier) || level.divisions.some((d) => d.id === selectedDiv);
              const humans = level.divisions.reduce((sum, d) => sum + d.humanCount, 0);
              return (
                <div key={level.tier}>
                  <button
                    className="btn ghost sm"
                    style={{ width: "100%", justifyContent: "space-between", border: "none", fontWeight: 700 }}
                    onClick={() => toggleTier(level.tier)}
                    aria-expanded={expanded}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      Division {level.tier}
                      <span className="chip" style={{ fontSize: "0.68rem", padding: "1px 6px" }}>{level.divisions.length} grp · {humans}H</span>
                    </span>
                  </button>
                  {expanded && (
                    <div style={{ paddingLeft: 18 }}>
                      {[...level.divisions].sort((a, b) => a.groupIndex - b.groupIndex).map((d) => (
                        <button
                          key={d.id}
                          className={`btn sm${d.id === selectedDiv ? "" : " ghost"}`}
                          style={{ width: "100%", justifyContent: "space-between", marginBottom: 4 }}
                          onClick={() => selectDivision(level.tier, d.id)}
                        >
                          <span>Group {groupLabel(d.groupIndex)}</span>
                          <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>{d.humanCount}H / {d.aiCount}AI</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ flex: 1, minWidth: 340 }}>
            <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
              <TabPanel header="Standings">
                <div className="card" style={{ padding: 20 }}>
                  {selected ? (
                    <>
                      <div style={{ marginBottom: 10, color: "var(--text-3)", fontSize: "0.85rem" }}>
                        Division {selected.tier} · Group {groupLabel(selected.groupIndex)} — click a team for moderation actions.
                      </div>
                      <StandingsTable
                        rows={table}
                        isTopDivision={selected.tier === 1}
                        seasonComplete={seasonComplete}
                        onClubClick={(row) => setModerationClubId(row.clubId)}
                      />
                    </>
                  ) : (
                    <div className="empty-state" style={{ padding: 20 }}>Select a group.</div>
                  )}
                </div>
              </TabPanel>
              <TabPanel header="Fixtures">
                <FixturesList
                  fixtures={fixtures}
                  contextBuilder={(f) => ({
                    label: `${seasonKey ? `S${seasonKey} · ` : ""}D${selected?.tier ?? "?"} · G${selected ? groupLabel(selected.groupIndex) : "?"} · R${f.round + 1}`,
                    tooltip: `${seasonKey ? `Season ${seasonKey} · ` : ""}Division ${selected?.tier ?? "?"} · Group ${selected ? groupLabel(selected.groupIndex) : "?"} · Round ${f.round + 1}`,
                  })}
                  onOpenResult={setResultFixture}
                />
              </TabPanel>
            </TabView>
          </div>
        </div>
      </AdminCard>

      <MatchResultDialog fixture={resultFixture} onClose={() => setResultFixture(null)} />
      <ClubModerationDialog clubId={moderationClubId} onClose={() => setModerationClubId(null)} notify={notify} />
    </div>
  );
}
