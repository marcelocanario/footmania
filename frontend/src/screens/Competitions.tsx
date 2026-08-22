import { useEffect, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { TabView, TabPanel } from "primereact/tabview";
import { ArrowUp, ArrowDown, Trophy } from "lucide-react";
import { api, type FixtureView, type PyramidTier, type StandingsRow } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { ClubBadge } from "../components/ClubBadge";

function kickoffLabel(kickoffAt: number | null): string {
  if (!kickoffAt) return "";
  return new Date(kickoffAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function groupLabel(groupIndex: number): string {
  return String.fromCharCode("A".charCodeAt(0) + groupIndex);
}

function statusBadge(row: StandingsRow, position: number, isTopDivision: boolean) {
  const badges: React.ReactNode[] = [];
  if (position === 1) {
    badges.push(
      <span key="champion" className="chip" style={{ borderColor: "rgba(240,180,41,0.65)", color: "var(--gold-2)", background: "rgba(240,180,41,0.12)" }}>
        <Trophy size={12} /> Champion
      </span>,
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
  const [divisionLevels, setDivisionLevels] = useState<PyramidTier[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    api.pyramid().then((res) => setDivisionLevels(res.tiers)).catch(() => undefined);
  }, []);

  const allDivisions = divisionLevels.flatMap((level) => level.divisions);

  useEffect(() => {
    if (allDivisions.length > 0 && selectedDiv === null) setSelectedDiv(allDivisions[0].id);
  }, [allDivisions, selectedDiv]);

  const selected = allDivisions.find((d) => d.id === selectedDiv) ?? null;
  const tableRows = table.map((row, index) => ({ ...row, displayPosition: index + 1 }));
  const isTopDivision = selected?.tier === 1;
  useEffect(() => {
    if (selectedDiv === null) return;
    api.divisionStandings(selectedDiv).then((res) => setTable(res.standings)).catch(() => undefined);
    api.divisionFixtures(selectedDiv).then((res) => setFixtures(res.fixtures)).catch(() => undefined);
  }, [selectedDiv]);

  return (
    <div>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div className="kicker">{strings.competitions.title} · {status?.season?.key ?? ""}</div>
            <h1>{selected ? `Division ${selected.tier} · Group ${groupLabel(selected.groupIndex)}` : strings.competitions.title}</h1>
          </div>
          <Dropdown
            value={selectedDiv}
            options={allDivisions.map((d) => ({ label: `Division ${d.tier} · Group ${groupLabel(d.groupIndex)}`, value: d.id }))}
            onChange={(e) => setSelectedDiv(e.value)}
            style={{ minWidth: 260 }}
            aria-label="Division"
          />
        </div>
      </div>

       <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12, marginBottom: 16 }}>
         {divisionLevels.map((level) => (
           <div className="card" key={level.tier} style={{ padding: 14 }}>
             <div className="section-label" style={{ marginBottom: 8 }}>Division {level.tier}</div>
             <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginBottom: 10 }}>Choose a group</div>
             {level.divisions.map((d) => (
               <button
                key={d.id}
                onClick={() => setSelectedDiv(d.id)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "8px 10px",
                  marginBottom: 6,
                  borderRadius: 10,
                  border: selectedDiv === d.id ? "1px solid var(--grass-2)" : "1px solid var(--line)",
                  background: selectedDiv === d.id ? "rgba(61,220,132,0.08)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                   <span style={{ fontWeight: 700 }}>Group {groupLabel(d.groupIndex)}</span>
                   <span style={{ color: selectedDiv === d.id ? "var(--grass-2)" : "var(--text-3)", fontSize: "0.82rem" }}>{selectedDiv === d.id ? "Viewing" : "View table"}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

       <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
         <TabPanel header="Standings">
           <div className="card" style={{ padding: 20 }}>
             <div className="table-wrap">
               <DataTable
                 value={tableRows}
                 rowClassName={(r) => [
                   r.isHuman ? "human-row" : "",
                   r.displayPosition === 1 ? "standings-champion" : "",
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
                     <ClubBadge name={r.clubName} primary={r.colors?.primary} secondary={r.colors?.secondary} kit={r.kit} size={26} />
                     <span style={{ fontWeight: 600 }}>{r.clubName}</span>
                     {r.isMine && <span className="flag-chip fc-accent">YOU</span>}
                     {statusBadge(r, r.displayPosition, isTopDivision === true)}
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
              {fixtures.map((f) => (
                <div className={`result-card${f.isHuman ? " human" : ""}`} key={f.id} style={{ marginBottom: 6 }}>
                  <span className="chip" style={{ minWidth: 90 }}>R{f.round + 1}</span>
                  <div className="side">{f.home}</div>
                  <div className="score">
                    {f.played ? `${f.homeScore} - ${f.awayScore}` : <span style={{ color: "var(--text-3)", fontSize: "0.8rem" }}>{kickoffLabel(f.kickoffAt)}</span>}
                  </div>
                  <div className="side right">{f.away}</div>
                </div>
              ))}
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
