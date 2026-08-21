import { useEffect, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { TabView, TabPanel } from "primereact/tabview";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { api, type FixtureView, type PyramidTier, type StandingsRow } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { ClubBadge } from "../components/ClubBadge";

function kickoffLabel(kickoffAt: number | null): string {
  if (!kickoffAt) return "";
  return new Date(kickoffAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(row: StandingsRow) {
  if (row.clubType === "AI") {
    return <span className="chip" style={{ borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" }}>AI</span>;
  }
  if (row.promotionStatus === "POSSIBLE") {
    return <span className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}><ArrowUp size={12} /> Possible promotion</span>;
  }
  if (row.promotionStatus === "PROMOTED") {
    return (
      <span className="chip" style={{ borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)" }}>
        <ArrowUp size={12} /> Promotion
      </span>
    );
  }
  if (row.relegationStatus === "RELEGATED") {
    return (
      <span className="chip" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b" }}>
        <ArrowDown size={12} /> Relegation
      </span>
    );
  }
  return <span className="chip" style={{ borderColor: "var(--line)", color: "var(--text-3)" }}><Minus size={12} /> Mid</span>;
}

export function Competitions() {
  const { status } = useGame();
  const [tiers, setTiers] = useState<PyramidTier[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    api.pyramid().then((res) => setTiers(res.tiers)).catch(() => undefined);
  }, []);

  const allDivisions = tiers.flatMap((t) => t.divisions);

  useEffect(() => {
    if (allDivisions.length > 0 && selectedDiv === null) setSelectedDiv(allDivisions[0].id);
  }, [allDivisions, selectedDiv]);

  const selected = allDivisions.find((d) => d.id === selectedDiv) ?? null;
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
            <h1>{selected ? `Division ${selected.name}` : strings.competitions.title}</h1>
          </div>
          <Dropdown
            value={selectedDiv}
            options={allDivisions.map((d) => ({ label: `Division ${d.name} (${d.humanCount}H/${d.aiCount}AI)`, value: d.id }))}
            onChange={(e) => setSelectedDiv(e.value)}
            style={{ minWidth: 260 }}
            aria-label="Division"
          />
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 12, marginBottom: 16 }}>
        {tiers.map((t) => (
          <div className="card" key={t.tier} style={{ padding: 14 }}>
            <h3 style={{ marginBottom: 8, color: "var(--gold-2)" }}>Tier {t.tier}</h3>
            {t.divisions.map((d) => (
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
                <span style={{ fontWeight: 700 }}>{d.name}</span>
                <span style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>{d.humanCount}H · {d.aiCount}AI</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
        <TabPanel header={strings.competitions.table}>
          <div className="card" style={{ padding: 20 }}>
            <div className="table-wrap">
              <DataTable value={table} rowClassName={(r) => (r.isHuman ? "human-row" : "")} rows={20} dataKey="clubId">
                <Column
                  key="pos"
                  header="#"
                  body={(_, { rowIndex }) => <span className="rank-pill">{rowIndex + 1}</span>}
                  style={{ width: 56 }}
                />
                <Column key="team" header={strings.squad.player} body={(r: StandingsRow) => (
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ClubBadge name={r.clubName} primary={r.colors?.primary} secondary={r.colors?.secondary} kit={r.kit} size={26} />
                    <span style={{ fontWeight: 600 }}>{r.clubName}</span>
                    {r.isMine && <span className="flag-chip fc-accent">YOU</span>}
                    {statusBadge(r)}
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
        <span className="chip"><ArrowUp size={12} style={{ color: "var(--grass-2)" }} /> Promotion (eligible humans only)</span>
        <span className="chip"><ArrowDown size={12} style={{ color: "#ff6b6b" }} /> Relegation</span>
        <span className="chip">AI filler never promotes</span>
      </div>
    </div>
  );
}
