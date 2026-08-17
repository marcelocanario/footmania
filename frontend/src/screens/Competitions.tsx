import { useEffect, useState, type ReactNode } from "react";
import { Dropdown } from "primereact/dropdown";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { TabView, TabPanel } from "primereact/tabview";
import { Trophy } from "lucide-react";
import { api, type TableRow } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { ClubBadge } from "../components/ClubBadge";

type GroupTable = { groupName: string; rows: TableRow[] };

export function Competitions() {
  const { snapshot, saveId } = useGame();
  const [compId, setCompId] = useState<number | null>(null);
  const [table, setTable] = useState<TableRow[] | GroupTable[] | null>(null);
  const [fixtures, setFixtures] = useState<{ id: number; round: number; roundLabel: string; leg: number; home: string; away: string; dayLabel: string; played: boolean; homeScore?: number; awayScore?: number; isHuman: boolean }[]>([]);
  const [bracket, setBracket] = useState<{ round: number; ties: { home: string; away: string; leg1: string | null; leg2: string | null; pen: string | null; winner: string; played: boolean }[] }[] | null>(null);
  const [tab, setTab] = useState(0);

  const comps = snapshot?.competitions ?? [];

  useEffect(() => {
    if (comps.length > 0 && compId === null) setCompId(comps[0].id);
  }, [comps, compId]);

  useEffect(() => {
    if (!saveId || compId === null) return;
    api.competitionTable(saveId, compId).then((res) => setTable(res.table as TableRow[] | GroupTable[]));
    api.competitionFixtures(saveId, compId).then((res) => setFixtures(res.fixtures));
    api.competitionBracket(saveId, compId).then((res) => setBracket(res.bracket as never));
  }, [saveId, compId]);

  const comp = comps.find((c) => c.id === compId);
  const isGrouped = !!table && table.length > 0 && "groupName" in table[0];
  const leagueRows = isGrouped ? null : (table as TableRow[] | null);
  const isLeague = comp?.kind === "league";
  const isNational = comp?.kind === "cup" && comp.stage !== "group";

  const rankClass = (i: number) => {
    if (!isLeague) return "";
    if (i === 0) return "gold";
    return "";
  };

  const tableColumns = (): ReactNode[] => [
    <Column
      key="pos"
      header="#"
      body={(_, { rowIndex }) => <span className={`rank-pill ${rankClass(rowIndex)}`}>{rowIndex + 1}</span>}
      style={{ width: 56 }}
    />,
    <Column key="team" header={strings.squad.player} body={(r: TableRow) => (
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ClubBadge name={r.clubName} primary={r.colors?.primary} secondary={r.colors?.secondary} size={26} />
        <span style={{ fontWeight: 600 }}>{r.clubName}</span>
        {r.isHuman && <span className="flag-chip fc-star">YOU</span>}
      </span>
    )} style={{ minWidth: 220 }} />,
    <Column key="p" field="played" header="P" style={{ width: 44 }} />,
    <Column key="w" field="wins" header="W" style={{ width: 44 }} />,
    <Column key="d" field="draws" header="D" style={{ width: 44 }} />,
    <Column key="l" field="losses" header="L" style={{ width: 44 }} />,
    <Column key="gd" header="GD" body={(r: TableRow) => r.goalsFor - r.goalsAgainst} style={{ width: 52 }} />,
    <Column key="pts" field="points" header="Pts" style={{ width: 64 }} body={(r: TableRow) => <b style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem" }}>{r.points}</b>} />,
  ];

  return (
    <div>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div className="kicker">{strings.competitions.title}</div>
            <h1>{comp?.name ?? strings.competitions.title}</h1>
          </div>
          <Dropdown
            value={compId}
            options={comps.map((c) => ({ label: c.name, value: c.id }))}
            onChange={(e) => setCompId(e.value)}
            style={{ minWidth: 240 }}
            aria-label="Competition"
          />        </div>
      </div>

      <TabView activeIndex={tab} onTabChange={(e) => setTab(e.index)}>
        <TabPanel header={strings.competitions.table}>
          {leagueRows && leagueRows.length > 0 ? (
            <div className="card" style={{ padding: isNational ? 10 : 20 }}>
              <div className="table-wrap">
                <DataTable value={leagueRows} rowClassName={(r) => (r.isHuman ? "human-row" : "")} rows={20} dataKey="clubId">
                  {tableColumns()}
                </DataTable>
              </div>
            </div>
          ) : isGrouped ? (
            <div className="grid">
              {(table as GroupTable[]).map((g) => (
                <div className="card" key={g.groupName}>
                  <h3 style={{ marginBottom: 10 }}>{strings.competitions.group} {g.groupName}</h3>
                  <div className="table-wrap">
                    <DataTable value={g.rows} rowClassName={(r) => (r.isHuman ? "human-row" : "")} rows={10} dataKey="clubId">
                      {tableColumns()}
                    </DataTable>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Trophy size={30} style={{ opacity: 0.5 }} />
              {comp?.kind === "cup" ? strings.competitions.knockoutTable : strings.competitions.finished}
            </div>
          )}
        </TabPanel>

        <TabPanel header={strings.competitions.fixtures}>
          <div className="card">
            <div className="table-wrap">
              <DataTable value={fixtures} rowClassName={(r) => (r.isHuman ? "human-row" : "")} rows={20} dataKey="id">
                <Column header={strings.competitions.round} body={(r) => `${r.roundLabel}${r.leg === 2 ? " (2)" : ""}`} style={{ width: 130 }} />
                <Column header={strings.matchday.home} field="home" style={{ minWidth: 150 }} />
                <Column
                  header=""
                  body={(r) =>
                    r.played ? (
                      <b style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", letterSpacing: "0.04em" }}>
                        {r.homeScore} - {r.awayScore}
                      </b>
                    ) : (
                      <span style={{ color: "var(--text-3)" }}>—</span>
                    )
                  }
                  style={{ width: 90, textAlign: "center" }}
                />
                <Column header={strings.matchday.away} field="away" style={{ minWidth: 150 }} />
                <Column header={strings.saves.date} field="dayLabel" style={{ width: 110 }} />
              </DataTable>
            </div>
          </div>
        </TabPanel>

        <TabPanel header={strings.competitions.bracket}>
          <div className="card">
            {bracket && bracket.length > 0 ? (
              <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 6 }}>
                {bracket.map((round) => (
                  <div key={round.round} style={{ minWidth: 230 }}>
                    <h3 style={{ marginBottom: 10, color: "var(--gold-2)" }}>{strings.competitions.round} {round.round + 1}</h3>
                    {round.ties.map((tie, i) => (
                      <div
                        key={i}
                        style={{
                          background: "rgba(4,13,8,0.55)",
                          border: "1px solid var(--line)",
                          borderRadius: 13,
                          padding: 12,
                          marginBottom: 9,
                          boxShadow: tie.winner ? "0 0 0 1px rgba(240,180,41,0.3)" : "none",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{tie.home}</div>
                        <div style={{ color: "var(--text-2)", fontWeight: 600 }}>{tie.away}</div>
                        <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 7 }}>
                          {tie.leg1 && <div>1st leg: {tie.leg1}</div>}
                          {tie.leg2 && <div>2nd leg: {tie.leg2}</div>}
                          {tie.pen && <div style={{ color: "var(--gold-2)" }}>Pens: {tie.pen}</div>}
                          {tie.winner && <div style={{ color: "var(--grass-2)", fontWeight: 700, marginTop: 3 }}>✓ {tie.winner}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <Trophy size={30} style={{ opacity: 0.5 }} />
                {strings.competitions.finished}
              </div>
            )}
          </div>
        </TabPanel>
      </TabView>
    </div>
  );
}
