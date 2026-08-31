import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Dropdown } from "primereact/dropdown";
import { TabView, TabPanel } from "primereact/tabview";
import { ArrowUp, ArrowDown } from "lucide-react";
import { api, type FixtureView, type PyramidResponse, type StandingsRow } from "../api/client";
import { useGame } from "../store/game";
import { groupLabel } from "../components/competition/shared";
import { StandingsTable } from "../components/competition/StandingsTable";
import { FixturesList } from "../components/competition/FixturesList";
import { MatchResultDialog } from "../components/competition/MatchResultDialog";

export function Competitions() {
  const { t } = useTranslation();
  const { status } = useGame();
  const navigate = useNavigate();
  const [pyramid, setPyramid] = useState<PyramidResponse | null>(null);
  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);
  // Finished-match popout: the clicked fixture (history loads in the dialog).
  const [resultFixture, setResultFixture] = useState<FixtureView | null>(null);

  useEffect(() => {
    api.pyramid().then((res) => {
      setPyramid(res);
      // Pre-select the user's own division; fall back to the top of the pyramid.
      const initial =
        res.myDivisionId != null
          ? res.tiers.flatMap((t) => t.divisions).find((d) => d.id === res.myDivisionId)
          : res.tiers[0]?.divisions[0];
      if (initial) {
        setSelectedTier(initial.tier);
        setSelectedDiv(initial.id);
      }
    }).catch(() => undefined);
  }, []);

  const allDivisions = useMemo(() => pyramid?.tiers.flatMap((level) => level.divisions) ?? [], [pyramid]);
  const tierLevels = pyramid?.tiers ?? [];
  const tierOptions = tierLevels.map((level) => ({ label: t("competitions.divisionOption", { tier: level.tier }), value: level.tier }));
  const groupsInTier = useMemo(
    () =>
      [...(tierLevels.find((level) => level.tier === selectedTier)?.divisions ?? [])].sort((a, b) => a.groupIndex - b.groupIndex),
    [tierLevels, selectedTier],
  );
  const groupOptions = groupsInTier.map((d) => ({ label: t("competitions.groupOption", { group: groupLabel(d.groupIndex) }), value: d.id }));

  const selected = allDivisions.find((d) => d.id === selectedDiv) ?? null;
  const isTopDivision = selected?.tier === 1;
  const seasonNumber = status?.season?.seasonNumber ?? "?";
  // "Champion" only once every fixture of the season has been played; before
  // that the top team is merely the leader.
  const seasonComplete = fixtures.length > 0 && fixtures.every((f) => f.played);

  useEffect(() => {
    if (selectedDiv === null) return;
    api.divisionStandings(selectedDiv).then((res) => setTable(res.standings)).catch(() => undefined);
    api.divisionFixtures(selectedDiv).then((res) => setFixtures(res.fixtures)).catch(() => undefined);
  }, [selectedDiv]);

  const openResult = (f: FixtureView) => {
    if (f.matchId == null) return;
    setResultFixture(f);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{t("competitions.seasonKicker", { season: status?.season?.seasonNumber ?? "" })}</div>
          <h1>{selected ? t("competitions.divisionGroupTitle", { tier: selected.tier, group: groupLabel(selected.groupIndex) }) : t("competitions.title")}</h1>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Dropdown
            value={selectedTier}
            options={tierOptions}
            onChange={(e) => {
              const tier = e.value as number;
              setSelectedTier(tier);
              const first = tierLevels.find((level) => level.tier === tier)?.divisions.sort((a, b) => a.groupIndex - b.groupIndex)[0];
              if (first) setSelectedDiv(first.id);
            }}
            placeholder={t("competitions.divisionPlaceholder")}
            style={{ minWidth: 150 }}
            aria-label={t("competitions.divisionPlaceholder")}
          />
          <Dropdown
            value={selectedDiv}
            options={groupOptions}
            onChange={(e) => setSelectedDiv(e.value)}
            placeholder={t("competitions.groupPlaceholder")}
            style={{ minWidth: 150 }}
            disabled={groupsInTier.length === 0}
            aria-label={t("competitions.groupPlaceholder")}
          />
        </div>
      </div>

      <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
        <TabPanel header={t("competitions.standingsTab")}>
          <div className="card" style={{ padding: 20 }}>
            <StandingsTable
              rows={table}
              isTopDivision={isTopDivision}
              seasonComplete={seasonComplete}
              onClubClick={(row) => navigate(`/team/${row.clubId}`)}
            />
          </div>
        </TabPanel>

        <TabPanel header={t("competitions.fixtures")}>
          <FixturesList
            fixtures={fixtures}
            contextBuilder={(f) => ({
              label: t("competitions.fixtureContext", { season: seasonNumber, tier: selected?.tier ?? "?", group: selected ? groupLabel(selected.groupIndex) : "?", round: f.round + 1 }),
              tooltip: t("competitions.fixtureTooltip", { season: seasonNumber, tier: selected?.tier ?? "?", group: selected ? groupLabel(selected.groupIndex) : "?", round: f.round + 1 }),
            })}
            onOpenResult={openResult}
          />
        </TabPanel>
      </TabView>

      <MatchResultDialog fixture={resultFixture} onClose={() => setResultFixture(null)} />

      <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap", color: "var(--text-3)", fontSize: "0.85rem" }}>
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--gold-2)" }} /> {t("competitions.possiblePromotion")}</span>}
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--grass-2)" }} /> {t("competitions.promoted")}</span>}
        <span className="chip"><ArrowDown size={12} style={{ color: "#ff6b6b" }} /> {t("competitions.relegation")}</span>
      </div>
    </div>
  );
}
