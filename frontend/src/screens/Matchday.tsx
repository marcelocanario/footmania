import { useNavigate } from "react-router-dom";
import { CalendarDays, Play, Radio, Table2 } from "lucide-react";
import { useGame } from "../store/game";
import { strings } from "../strings";

export function Matchday() {
  const { snapshot, dayResult } = useGame();
  const navigate = useNavigate();
  const matches = dayResult?.playedMatches ?? [];

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

      {dayResult?.humanMatch ? (
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.45)", marginBottom: 16, textAlign: "center", padding: "28px 20px" }}>
          <div className="kicker" style={{ justifyContent: "center", marginBottom: 10 }}>
            {dayResult.matchPending ? "Live now" : strings.matchday.live}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "2.6rem", fontWeight: 800, letterSpacing: "0.05em" }}>
            {dayResult.humanMatch.home} <span style={{ color: "var(--text-3)", fontSize: "1.6rem" }}>vs</span> {dayResult.humanMatch.away}
          </div>
          {dayResult.matchPending ? (
            <div style={{ color: "var(--grass-2)", fontSize: "1.05rem", fontWeight: 700, margin: "8px 0 4px" }}>
              <span className="pulse-dot" /> The match is being played now
            </div>
          ) : (
            <div style={{ fontFamily: "var(--font-display)", fontSize: "3.2rem", fontWeight: 800, margin: "8px 0 4px" }}>
              {dayResult.humanMatch.homeScore} - {dayResult.humanMatch.awayScore}
            </div>
          )}
          <div style={{ color: "var(--text-3)", fontSize: "0.88rem", marginBottom: 16 }}>{dayResult.dateLabel}</div>
          {dayResult.matchPending && (
            <button className="btn gold" style={{ fontSize: "1.05rem" }} onClick={() => navigate("/live-match")}>
              <Radio size={17} /> Watch live
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="empty-state" style={{ padding: "26px 14px" }}>
            <span style={{ fontSize: 26 }}>🏟️</span>
            No match involving your club on {dayResult ? dayResult.dateLabel : "the last played day"}.
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 className="card-title"><CalendarDays size={17} /> {dayResult?.dateLabel}</h2>
          {matches.map((m, i) => (
            <div className={`result-card${m.isHuman ? " human" : ""}`} key={i}>
              <div className="side">{m.home}</div>
              <div className="score">{m.homeScore} - {m.awayScore}</div>
              <div className="side right">{m.away}</div>
            </div>
          ))}
        </div>
      )}

      {snapshot?.nextFixture && (
        <div className="card" style={{ borderColor: "rgba(240,180,41,0.35)" }}>
          <h2 className="card-title" style={{ color: "var(--gold-2)" }}>
            <CalendarDays size={17} /> {strings.dashboard.nextFixture}
          </h2>
          <div className="result-card" style={{ borderColor: "rgba(240,180,41,0.3)", background: "rgba(240,180,41,0.06)" }}>
            <div className="side">
              {snapshot.nextFixture.home}
              {snapshot.nextFixture.isHome && <span className="flag-chip fc-accent">HOME</span>}
            </div>
            <div className="score" style={{ fontSize: "1.05rem", color: "var(--gold-2)" }}>vs</div>
            <div className="side right">{snapshot.nextFixture.away}</div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.88rem", marginTop: 8, display: "flex", alignItems: "center", gap: 7 }}>
            <Play size={12} /> {snapshot.nextFixture.dayLabel}
          </div>
        </div>
      )}
    </div>
  );
}
