import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dropdown } from "primereact/dropdown";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { TabView, TabPanel } from "primereact/tabview";
import { ArrowUp, ArrowDown, Crown, TrendingUp, Trophy } from "lucide-react";
import { api, type FixtureView, type LiveEvent, type MatchEvents, type MatchStats, type PyramidResponse, type StandingsRow } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { ClubCrest } from "../components/ClubCrest";
import { formatKickoff as kickoffLabel } from "../utils/time";

/** Groups are numbered (1-based): the pyramid grows exponentially, so letters run out. */
function groupLabel(groupIndex: number): string {
  return String(groupIndex + 1);
}

/** Mirrors the live-match feed iconography for the results popout timeline. */
const EVENT_LABELS: Record<number, string> = {
  1: "Goal!",
  2: "Yellow card",
  3: "Red card",
  5: "Injury",
  6: "Substitution",
  7: "Missed penalty",
  8: "Assist",
  9: "Coin toss",
};

function EventGlyph({ type, subtype }: { type: number; subtype: number }) {
  let glyph = "⚽";
  if (type === 1) glyph = subtype === 2 ? "🥅" : "⚽";
  else if (type === 2) glyph = "🟨";
  else if (type === 3) glyph = "🟥";
  else if (type === 5) glyph = "🩹";
  else if (type === 6) glyph = "🔄";
  else if (type === 7) glyph = "❌";
  else if (type === 9) glyph = "🪙";
  return <span aria-hidden="true">{glyph}</span>;
}

function formatEventMinute(e: LiveEvent): string {
  return e.addedTime ? `${e.minute}+${e.addedTime}'` : `${e.minute}'`;
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
  const user = useGame((s) => s.user);
  const navigate = useNavigate();
  const [pyramid, setPyramid] = useState<PyramidResponse | null>(null);
  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [selectedDiv, setSelectedDiv] = useState<number | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);
  const [tab, setTab] = useState(0);
  // Finished-match popout: the clicked fixture plus its loaded event history.
  const [resultFixture, setResultFixture] = useState<FixtureView | null>(null);
  const [resultData, setResultData] = useState<MatchEvents | null>(null);
  const [resultBusy, setResultBusy] = useState(false);

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

  const openResult = (f: FixtureView) => {
    if (f.matchId == null) return;
    setResultFixture(f);
    setResultData(null);
    setResultBusy(true);
    api.matchEvents(f.matchId)
      .then((res) => setResultData(res))
      .catch(() => setResultFixture(null))
      .finally(() => setResultBusy(false));
  };

  const isPro = Boolean(user?.isPro);

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
                const isLive = f.liveMatchId != null;
                const isClickable = isLive || (f.played && f.matchId != null);
                return (
                  <div
                    className={`result-card${f.isHuman ? " human" : ""}${isLive ? " live-now" : ""}`}
                    key={f.id}
                    style={{ marginBottom: 6, ...(isClickable ? { cursor: "pointer" } : {})}}
                    role={isClickable ? "button" : undefined}
                    tabIndex={isClickable ? 0 : undefined}
                    onClick={() => {
                      if (isLive && f.liveMatchId != null) navigate(`/live-match/${f.liveMatchId}`);
                      else if (f.played) openResult(f);
                    }}
                    onKeyDown={(e) => {
                      if (!isClickable) return;
                      if (e.key === "Enter") {
                        if (isLive && f.liveMatchId != null) navigate(`/live-match/${f.liveMatchId}`);
                        else if (f.played) openResult(f);
                      }
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <span className="chip" title={contextTooltip} style={{ minWidth: 160, justifyContent: "center" }}>{contextLabel}</span>
                      {isLive && (
                        <span className="live-tag" style={{ fontSize: "0.68rem", padding: "2px 8px" }}>
                          <span className="pulse-dot" /> LIVE
                        </span>
                      )}
                    </div>
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

      <Dialog
        header={resultData
          ? `${resultData.match.home} ${resultData.match.homeScore} – ${resultData.match.awayScore} ${resultData.match.away}`
          : resultFixture ? `${resultFixture.home} vs ${resultFixture.away}` : ""}
        visible={resultFixture !== null}
        onHide={() => setResultFixture(null)}
        style={{ width: 540 }}
      >
        {!resultData ? (
          <div className="empty-state" style={{ padding: 20 }}>{resultBusy ? "Loading…" : "No data"}</div>
        ) : (
          <TabView>
            <TabPanel header="Events">
              <div className="event-feed">
                {resultData.events.length === 0 && (
                  <div className="empty-state" style={{ padding: 14 }}>No goals, cards or injuries to report.</div>
                )}
                {resultData.events.map((e, i) => {
                  return (
                    <div className="event-row" key={i}>
                      <span className="min">{formatEventMinute(e)}</span>
                      <EventGlyph type={e.type} subtype={e.subtype ?? 0} />
                      {e.type === 1 && e.subtype !== 2 && e.player2 ? (
                        <>
                          <span className="ev-label">{EVENT_LABELS[e.type]}</span>
                          <span className="ev-name">{e.player}</span>
                          <span className="ev-label">assist {e.player2}</span>
                        </>
                      ) : e.type === 6 ? (
                        <>
                          <span className="ev-label">{EVENT_LABELS[e.type]}</span>
                          <span className="ev-name">{e.player}</span>
                          <span className="ev-label">↔ {e.player2}</span>
                        </>
                      ) : (
                        <>
                          <span className="ev-label">{EVENT_LABELS[e.type] ?? "Event"}</span>
                          <span className="ev-name">{e.player}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabPanel>
            <TabPanel
              header={isPro ? "Stats" : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Crown size={12} /> Stats</span>}
            >
              {!isPro ? (
                <div className="empty-state" style={{ padding: 20 }}>
                  Detailed match stats are a <b>Pro</b> feature.
                </div>
              ) : resultData.match.stats ? (
                <ResultStats stats={resultData.match.stats} homeName={resultData.match.home} awayName={resultData.match.away} />
              ) : (
                <div className="empty-state" style={{ padding: 14 }}>No stats available.</div>
              )}
            </TabPanel>
          </TabView>
        )}
      </Dialog>

      <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap", color: "var(--text-3)", fontSize: "0.85rem" }}>
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--gold-2)" }} /> Possible promotion · dotted line</span>}
        {!isTopDivision && <span className="chip"><ArrowUp size={12} style={{ color: "var(--grass-2)" }} /> Promoted</span>}
        <span className="chip"><ArrowDown size={12} style={{ color: "#ff6b6b" }} /> Relegation</span>
      </div>
    </div>
  );
}

/** Compact two-sided stats bars for the finished-match popout (Pro tab). */
function ResultStats({ stats, homeName, awayName }: { stats: MatchStats; homeName: string; awayName: string }) {
  const possession = (() => {
    const total = stats.home.controlledBallSeconds + stats.away.controlledBallSeconds;
    if (total <= 0) return [50, 50] as [number, number];
    const home = Math.round((stats.home.controlledBallSeconds / total) * 100);
    return [home, 100 - home] as [number, number];
  })();

  const bar = (label: string, h: number | string, a: number | string) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--line)", fontSize: "0.9rem" }}>
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, minWidth: 40, textAlign: "right" }}>{h}</span>
      <span style={{ color: "var(--text-3)", flex: 1, textAlign: "center" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, minWidth: 40 }}>{a}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 6 }}>
        <span>{homeName}</span>
        <span>{awayName}</span>
      </div>
      {bar("Possession %", possession[0], possession[1])}
      {bar("Shots", stats.home.shots, stats.away.shots)}
      {bar("On target", stats.home.shotsOnTarget, stats.away.shotsOnTarget)}
      {bar("xG", stats.home.xG.toFixed(2), stats.away.xG.toFixed(2))}
      {bar("Corners", stats.home.corners, stats.away.corners)}
      {bar("Passes", stats.home.passes, stats.away.passes)}
      {bar("Fouls", stats.home.fouls, stats.away.fouls)}
      {bar("Yellows", stats.home.yellows, stats.away.yellows)}
      {bar("Reds", stats.home.reds, stats.away.reds)}
    </div>
  );
}
