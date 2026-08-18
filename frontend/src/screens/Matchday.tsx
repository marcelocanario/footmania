import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Radio, Table2, Clock } from "lucide-react";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { api, type FixtureView } from "../api/client";

function kickoffLabel(kickoffAt: number | null): string {
  if (!kickoffAt) return "";
  const d = new Date(kickoffAt);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Matchday() {
  const { snapshot, liveMatchId, checkLiveMatch } = useGame();
  const navigate = useNavigate();
  const [fixtures, setFixtures] = useState<FixtureView[]>([]);

  const myDivision = snapshot?.competitions.find((c) => c.kind === "division" || c.kind === "league");

  useEffect(() => {
    if (!myDivision) return;
    api.divisionFixtures(myDivision.id).then((res) => setFixtures(res.fixtures)).catch(() => undefined);
  }, [myDivision?.id]);

  const myFixtures = fixtures.filter((f) => f.isHuman);
  const next = myFixtures.find((f) => !f.played);
  const live = liveMatchId;

  const resume = () => {
    void checkLiveMatch().then((id) => {
      if (id) navigate("/live-match");
    });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{strings.matchday.title}</div>
          <h1>{strings.matchday.results}</h1>
        </div>
        <button className="btn ghost" onClick={() => navigate("/competitions")}>
          <Table2 size={15} /> {strings.competitions.title}
        </button>
      </div>

      {live && (
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.45)", marginBottom: 16, textAlign: "center", padding: "28px 20px" }}>
          <div className="kicker" style={{ justifyContent: "center", marginBottom: 10 }}>
            <span className="pulse-dot" /> Live now
          </div>
          <button className="btn gold" style={{ fontSize: "1.05rem" }} onClick={resume}>
            <Radio size={17} /> Watch live
          </button>
        </div>
      )}

      {!live && next && (
        <div className="card" style={{ borderColor: "rgba(240,180,41,0.35)", marginBottom: 16 }}>
          <h2 className="card-title" style={{ color: "var(--gold-2)" }}>
            <CalendarDays size={17} /> Next match
          </h2>
          <div className="result-card" style={{ borderColor: "rgba(240,180,41,0.3)", background: "rgba(240,180,41,0.06)" }}>
            <div className="side">{next.home}</div>
            <div className="score" style={{ fontSize: "1.05rem", color: "var(--gold-2)" }}>vs</div>
            <div className="side right">{next.away}</div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.88rem", marginTop: 8, display: "flex", alignItems: "center", gap: 7 }}>
            <Clock size={12} /> Kicks off {kickoffLabel(next.kickoffAt)}
          </div>
        </div>
      )}

      {!live && !next && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="empty-state" style={{ padding: "26px 14px" }}>
            <span style={{ fontSize: 26 }}>🏟️</span>
            No upcoming fixture for your club.
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="card-title"><CalendarDays size={17} /> {myDivision?.name ?? "Division"} fixtures</h2>
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
    </div>
  );
}
