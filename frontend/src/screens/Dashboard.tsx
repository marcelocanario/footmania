import { useNavigate } from "react-router-dom";
import { Play, TrendingUp, Wallet, CalendarDays, Activity, Users, Trophy, ArrowRight, ChartNoAxesColumn } from "lucide-react";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { useAdvanceDay } from "../hooks/useAdvanceDay";
import { money } from "../format";

function confidenceDot(v: number): string {
  return v >= 65 ? "good" : v >= 40 ? "mid" : "bad";
}

export function Dashboard() {
  const { snapshot, dayResult } = useGame();
  const navigate = useNavigate();
  const { busy, run } = useAdvanceDay();

  const club = snapshot?.club;

  if (!snapshot || !club) {
    return (
      <div>
        <div className="empty-state" style={{ paddingTop: 80 }}>{strings.common.loading}</div>
      </div>
    );
  }

  const league = snapshot.competitions.find((c) => c.kind === "league" && c.division === 1)
    ?? snapshot.competitions.find((c) => c.kind === "league");
  const position = league?.position ?? null;
  const posClass = position !== null ? (position <= 4 ? "gold" : position >= 17 ? "red" : "") : "";
  const results = dayResult;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
            {snapshot.save.dateLabel} · {snapshot.save.dayOfWeek} · Year {snapshot.save.year}
          </div>
          <h1>{club.name}</h1>
          <div className="head-chips">
            <span className="chip"><span className={`dot ${confidenceDot(club.boardConfidence)}`} /> Board {club.boardConfidence}%</span>
            <span className="chip"><span className={`dot ${confidenceDot(club.fanConfidence)}`} /> Fans {club.fanConfidence}%</span>
            {league && <span className="chip">Division {league.division}</span>}
          </div>
        </div>
        <button className="btn gold" style={{ fontSize: "1.05rem", minHeight: 50, padding: "14px 34px" }} onClick={() => run()} disabled={busy}>
          <Play size={19} /> {busy ? strings.common.loading : strings.dashboard.continue}
        </button>
      </div>

      {results && (results.playedMatches.length > 0 || results.events.length > 0) && (
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.4)", marginBottom: 16 }}>
          <h2 className="card-title" style={{ color: "var(--grass-2)" }}>
            <Activity size={17} /> Day {results.dateLabel}
          </h2>
          {results.playedMatches.map((m, i) => (
            <div className={`result-card${m.isHuman ? " human" : ""}`} key={i}>
              <div className="side">{m.home}</div>
              <div className="score">{m.homeScore} - {m.awayScore}</div>
              <div className="side right">{m.away}</div>
            </div>
          ))}
          {results.events.map((e, i) => (
            <div className="news-item" key={`e${i}`}>
              <span className="day">{results.dateLabel}</span>
              {e}
            </div>
          ))}
        </div>
      )}

      <div className="grid cols-3 stagger">
        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><TrendingUp size={12} /> {strings.dashboard.position}</div>
            <div className="value" style={{ fontSize: "2.6rem", color: posClass === "gold" ? "var(--gold-2)" : posClass === "red" ? "var(--red-2)" : undefined }}>
              {position ? `#${position}` : "—"}
            </div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>{league?.name ?? "League"}</div>
        </div>

        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><Wallet size={12} /> {strings.dashboard.cash}</div>
            <div className="value" style={{ color: (club.cash ?? 0) >= 0 ? "var(--grass-2)" : "var(--red-2)" }}>{money(club.cash ?? 0)}</div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>{club.stadiumName} · {club.stadiumCapacity.toLocaleString()}</div>
        </div>

        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><CalendarDays size={12} /> {strings.dashboard.nextFixture}</div>
            <div className="value" style={{ fontSize: "1.25rem" }}>
              {snapshot.nextFixture ? `${snapshot.nextFixture.home} vs ${snapshot.nextFixture.away}` : strings.dashboard.noNextFixture}
            </div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>
            {snapshot.nextFixture ? snapshot.nextFixture.dayLabel : ""}
          </div>
        </div>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title"><Activity size={17} /> {strings.dashboard.news}</h2>
          <div className="news-list">
            {snapshot.news.length === 0 && <div className="empty-state" style={{ padding: "24px 10px" }}>No news yet. Continue to the next day.</div>}
            {snapshot.news.slice(0, 10).map((n, i) => (
              <div className="news-item" key={i}>
                <span className="day">{n.dayLabel}</span>
                {n.text}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h2 className="card-title"><Users size={17} /> Squad</h2>
            <div className="stats-row">
              <div className="stat">
                <div className="label">Seniors</div>
                <div className="value" style={{ fontSize: "1.5rem" }}>{snapshot.squad.length}</div>
              </div>
              <div className="stat">
                <div className="label">Youth</div>
                <div className="value" style={{ fontSize: "1.5rem" }}>{snapshot.juniors.length}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => navigate("/squad")}>
                <Users size={14} /> {strings.squad.title} <ArrowRight size={13} />
              </button>
              <button className="btn sm ghost" onClick={() => navigate("/competitions")}>
                <ChartNoAxesColumn size={14} /> {strings.competitions.title} <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title"><Trophy size={17} /> {club.shortName} Trophy Cabinet</h2>
            {Object.keys(club.trophies).length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: "0.9rem" }}>
                Empty so far. The first trophy starts with a single match.
              </div>
            ) : (
              <div className="news-list">
                {Object.entries(club.trophies).map(([name, count]) => (
                  <div className="news-item" key={name}>
                    <span className="day" style={{ color: "var(--gold-2)" }}>🏆 {count}×</span>
                    {name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
