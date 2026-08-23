import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { TabView, TabPanel } from "primereact/tabview";
import { ArrowUp, ArrowDown, TrendingUp, Trophy } from "lucide-react";
import { api, type FixtureView, type PyramidResponse, type StandingsRow } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { ClubCrest } from "../components/ClubCrest";

function kickoffLabel(kickoffAt: number | null): string {
  if (!kickoffAt) return "";
  return new Date(kickoffAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Groups are numbered (1-based): the pyramid grows exponentially, so letters run out. */
function groupLabel(groupIndex: number): string {
  return String(groupIndex + 1);
}

function statusBadge(row: StandingsRow, position: number, isTopDivision: boolean, seasonComplete: boolean) {
  const badges: React.ReactNode[] = [];
  if (position === 1) {
    badges.push(
      seasonComplete ? (
        <span key="champion" className="chip" style={{ borderColor: "rgba(240,180,41,0.65)", color: "var(--gold-2)", background: "rgba(240,180,41,0.12)" }}>
          <Trophy size={12} /> Champion
        </span>
      ) : (
        <span key="leader" className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}>
          <TrendingUp size={12} /> Leader
        </span>
      ),
    );
  }
  if (!isTopDivision && row.promotionStatus === "POSSIBLE") {
    badges.push(<span key="possible" className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}><ArrowUp size={12} /> Possible promotion</span>);
  }
  if (!isTopDivision && row.promotionStatus === "PROMOTED") {
    badges.push(<span key="promoted" className="chip" style={{ borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)" }}><ArrowUp size={12} /> Promoted</span>);
  }
  if (row.relegationStatus === "RELEGATED") {
    badges.push(<span key="relegated" className="chip" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b" }}><ArrowDown size={12} /> Relegated</span>);
  }
  if (row.clubType === "AI") {
    badges.push(<span key="ai" className="chip" style={{ borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" }}>AI</span>);
  }
  return badges.length > 0 ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>{badges}</span> : null;
}

export function Competitions() {
  const { status } = useGame();
  const [pyramid, setPyramid] = useState<PyramidResponse | null>(null);
  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);

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
  const tierOptions = tierLevels.map((level) => ({ label: `Division ${level.tier}`, value: level.tier }));
  const groupsInTier = useMemo(
    () =>
      [...(tierLevels.find((level) => level.tier === selectedTier)?.divisions ?? [])].sort((a, b) => a.groupIndex - b.groupIndex),
    [tierLevels, selectedTier],
  );
  const groupOptions = groupsInTier.map((d) => ({ label: `Group ${groupLabel(d.groupIndex)}`, value: d.id }));

  const selected = allDivisions.find((d) => d.id === selectedDiv) ?? null;
  const tableRows = table.map((row, index) => ({ ...row, displayPosition: index + 1 }));
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

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{strings.competitions.title} · Season {status?.season?.seasonNumber ?? ""}</div>
          <h1>{selected ? `Division ${selected.tier} · Group ${groupLabel(selected.groupIndex)}` : strings.competitions.title}</h1>
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
            placeholder="Division"
            style={{ minWidth: 150 }}
            aria-label="Division"
          />
          <Dropdown
            value={selectedDiv}
            options={groupOptions}
            onChange={(e) => setSelectedDiv(e.value)}
            placeholder="Group"
            style={{ minWidth: 150 }}
            disabled={groupsInTier.length === 0}
            aria-label="Group"
          />
        </div>
      </div>

      <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
        <TabPanel header="Standings">
          <div className="card" style={{ padding: 20 }}>
            <div className="table-wrap">
              <DataTable
                value={tableRows}
                rowClassName={(r) => [
                  r.isHuman ? "human-row" : "",
                  r.displayPosition === 1 && seasonComplete ? "standings-champion" : "",
                  !isTopDivision && r.promotionStatus === "POSSIBLE" ? "standings-promotion-possible" : "",
                  !isTopDivision && r.promotionStatus === "PROMOTED" ? "standings-promoted" : "",
                  r.relegationStatus === "RELEGATED" ? "standings-relegated" : "",
                ].filter(Boolean).join(" ")}
                rows={20}
                dataKey="clubId"
              >
                <Column
                  key="pos"
                  header="#"
                  body={(r) => <span className={`rank-pill${r.displayPosition === 1 ? " champion-rank" : ""}`}>{r.displayPosition}</span>}
                  style={{ width: 56 }}
                />
                <Column key="team" header="Team" body={(r: StandingsRow & { displayPosition: number }) => (
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ClubCrest name={r.clubName} primary={r.colors?.primary} secondary={r.colors?.secondary} kit={r.kit} size={26} clubId={r.clubId} hasCustomLogo={r.hasCustomLogo} />
                    <span style={{ fontWeight: 600 }}>{r.clubName}</span>
                    {r.isMine && <span className="flag-chip fc-accent">YOU</span>}
                    {statusBadge(r, r.displayPosition, isTopDivision === true, seasonComplete)}
                  </span>
                )} style={{ minWidth: 260 }} />
                <Column key="p" field="played" header="P" style={{ width: 44 }} />
                <Column key="w" field="wins" header="W" style={{ width: 44 }} />
                <Column key="d" field="draws" header="D" style={{ width: 44 }} />
                <Column key="l" field="losses" header="L" style={{ width: 44 }} />
                <Column key="gd" header="GD" body={(r: StandingsRow) => r.goalsFor - r.goalsAgainst} style={{ width: 52 }} />
                <Column key="pts" field="points" header="Pts" style={{ width: 64 }} body={(r: StandingsRow) => <b style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem" }}>{r.points}</b>} />
              </DataTable>
            </div>
          </div>
        </TabPanel>

        <TabPanel header={strings.competitions.fixtures}>
          <div className="card">
            <div className="table-wrap">
              {fixtures.map((f) => {
                // Full competition context per fixture; plain text on hover.
                const contextLabel = `S${seasonNumber} · D${selected?.tier ?? "?"} · G${selected ? groupLabel(selected.groupIndex) : "?"} · R${f.round + 1}`;
                const contextTooltip = `Season ${seasonNumber} · Division ${selected?.tier ?? "?"} · Group ${selected ? groupLabel(selected.groupIndex) : "?"} · Round ${f.round + 1}`;
                return (
                  <div className={`result-card${f.isHuman ? " human" : ""}`} key={f.id} style={{ marginBottom: 6 }}>
                    <span className="chip" title={contextTooltip} style={{ minWidth: 160, justifyContent: "center" }}>{contextLabel}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div className="side">
                          <ClubCrest name={f.home} kit={f.homeKit} size={24} clubId={f.homeClubId} hasCustomLogo={f.homeHasCustomLogo} />
                          {f.home}
                        </div>
                        <div className="score">
                          {f.played ? `${f.homeScore} - ${f.awayScore}` : "vs"}
                        </div>
                        <div className="side right">
                          {f.away}
                          <ClubCrest name={f.away} kit={f.awayKit} size={24} clubId={f.awayClubId} hasCustomLogo={f.awayHasCustomLogo} />
                        </div>
                      </div>
                      {/* Kickoff date/time and stadium, shown for every match (finished ones too). */}
                      {(f.kickoffAt || f.venue) && (
                        <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 4, textAlign: "center" }}>
                          {[kickoffLabel(f.kickoffAt), f.venue].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {fixtures.length === 0 && <div className="empty-state" style={{ padding: 20 }}>No fixtures yet.</div>}
            </div>
          </div>
        </TabPanel>
      </TabView>

      <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap", color: "var(--text-3)", fontSize: "0.85rem" }}>
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--gold-2)" }} /> Possible promotion · dotted line</span>}
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--grass-2)" }} /> Promoted</span>}
        <span className="chip"><ArrowDown size={12} style={{ color: "#ff6b6b" }} /> Relegation</span>
      </div>
    </div>
  );
}
