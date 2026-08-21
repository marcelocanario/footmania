import { useNavigate } from "react-router-dom";
import { Radio, TrendingUp, Wallet, CalendarDays, Activity, Users, Trophy, ArrowRight, ChartNoAxesColumn, Clock, Hourglass, AlertTriangle } from "lucide-react";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { useLiveMatch } from "../hooks/useAdvanceDay";
import { money } from "../format";

export function Dashboard() {
  const { snapshot, status, liveMatchId } = useGame();
  const navigate = useNavigate();
  const { busy, run } = useLiveMatch();

  const club = snapshot?.club;
  const provisional = club?.competitionState === "PROVISIONAL";
  const inactive = status?.club?.inactivity?.eligible;

  if (!snapshot || !club) {
    return (
      <div>
        <div className="empty-state" style={{ paddingTop: 80 }}>{strings.common.loading}</div>
      </div>
    );
  }

  const league = snapshot.competitions.find((c) => c.kind === "division" || c.kind === "league");
  const position = league?.position ?? null;
  const posClass = position !== null ? (position === 1 ? "gold" : "") : "";
  const season = status?.season;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">
            Season {season?.key ?? ""} · Round {season?.completedRounds ?? 0}
            {season?.joinState === "OPEN" ? " · joining open" : " · joining locked"}
             {season && ` · Day ${season.seasonDay} / ${season.seasonDays} · ${season.phase.toLowerCase().replace("_", " ")}`}
          </div>
          <h1>{club.name}</h1>
          <div className="head-chips">
            <span className="chip">{strings.team.country} {club.country}</span>
          </div>
        </div>
        {liveMatchId && (
          <button className="btn gold" style={{ fontSize: "1.05rem", minHeight: 50, padding: "14px 34px" }} onClick={() => run()} disabled={busy}>
            <Radio size={19} /> {strings.dashboard.resume}
          </button>
        )}
      </div>

      {provisional && (
        <div className="card" style={{ borderColor: "rgba(240,180,41,0.5)", marginBottom: 16, padding: "22px 18px" }}>
          <h2 className="card-title" style={{ color: "var(--gold-2)" }}>
            <Hourglass size={17} /> Your club is ready for next season
          </h2>
          <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.55 }}>
            You joined after the season's join lock, so you'll enter the pyramid next month.
            Your squad, contracts and finances are fully playable now — contracts and salaries
            stay paused until you're placed.
          </div>
          <div style={{ color: "var(--gold-2)", fontSize: "0.9rem", marginTop: 8 }}>
            Your next season's budget is already reserved — there is no additional allocation when you enter the league.
            {status?.club?.reservedNextSeasonAllocation && ` Reserved amount: ${money(status.club.reservedNextSeasonAllocation.amount)}.`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => navigate("/squad")}><Users size={14} /> Squad</button>
            <button className="btn sm ghost" onClick={() => navigate("/transfers")}><ArrowRight size={14} /> Transfers</button>
            <button className="btn sm ghost" onClick={() => navigate("/matchday")}><CalendarDays size={14} /> Matches</button>
          </div>
        </div>
      )}

      {inactive && (
        <div className="card" style={{ borderColor: "rgba(220,120,60,0.5)", marginBottom: 16, padding: "18px 16px" }}>
          <h2 className="card-title" style={{ color: "var(--red-2)" }}>
            <Activity size={17} /> Inactivity warning
          </h2>
          <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
            Your club may lose its league position at the end of the season if inactivity continues.
            Your club, squad and progression are retained — returning later means re-entering from the lowest available level.
          </div>
        </div>
      )}

      {club.finance && club.finance.status !== "SAFE" && (
        <div className="card" style={{ borderColor: club.finance.status === "NEGATIVE_CASH" ? "rgba(220,80,80,0.5)" : "rgba(240,180,41,0.5)", marginBottom: 16, padding: "18px 16px" }}>
          <h2 className="card-title" style={{ color: club.finance.status === "NEGATIVE_CASH" ? "var(--red-2)" : "var(--gold-2)" }}>
            <AlertTriangle size={17} /> {club.finance.status === "NEGATIVE_CASH" ? "Financial Emergency" : "Financial Warning"}
          </h2>
          {provisional ? (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              Your funded upcoming-season salary commitments currently exceed the club's available funds
              (financial cushion: <b style={{ color: "var(--red-2)" }}>{money(club.finance.financialCushion)}</b>).
              Salaries are frozen while the club is provisional; the warning will be recalculated when the club activates.
            </div>
          ) : club.finance.status === "NEGATIVE_CASH" ? (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              Current cash: <b style={{ color: "var(--red-2)" }}>{money(club.cash)}</b>.
              If the club is still in a negative cash position when the next payroll cycle is processed,
              a financial intervention may force players to leave.
            </div>
          ) : (
            <div style={{ color: "var(--text-2)", fontSize: "0.95rem", lineHeight: 1.5 }}>
              Your current cash does not cover your existing bids and remaining salary commitments through season end
              (financial cushion: <b style={{ color: "var(--red-2)" }}>{money(club.finance.financialCushion)}</b>).
              Future income may improve this position, but if your cash balance becomes negative and remains negative
              until a later payroll cycle, players may be forced to leave the club.
            </div>
          )}
          <button className="btn sm ghost" style={{ marginTop: 12 }} onClick={() => navigate("/finances")}>
            <Wallet size={14} /> View finances
          </button>
        </div>
      )}

      {liveMatchId && (
        <div className="card" style={{ borderColor: "rgba(61,220,132,0.5)", marginBottom: 16, textAlign: "center", padding: "22px 18px" }}>
          <div className="live-tag" style={{ marginBottom: 8 }}>
            <span className="pulse-dot" /> {strings.dashboard.liveMatch}
          </div>
          <div style={{ color: "var(--text-2)", fontSize: "0.95rem" }}>
            A match is being played right now. Watch it live and make substitutions.
          </div>
          <button className="btn gold" style={{ marginTop: 12 }} onClick={() => navigate("/live-match")}>
            <Radio size={16} /> {strings.dashboard.resume}
          </button>
        </div>
      )}

      <div className="grid cols-3 stagger">
        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><TrendingUp size={12} /> {strings.dashboard.position}</div>
            <div className="value" style={{ fontSize: "2.6rem", color: posClass === "gold" ? "var(--gold-2)" : undefined }}>
              {position ? `#${position}` : "—"}
            </div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>
            {league?.name ?? "League"}
          </div>
        </div>

        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><Wallet size={12} /> {strings.dashboard.cash}</div>
            <div className="value" style={{ color: (club.cash ?? 0) >= 0 ? "var(--grass-2)" : "var(--red-2)" }}>{money(club.cash ?? 0)}</div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8 }}>{club.stadiumName}</div>
        </div>

        <div className="card">
          <div className="stat" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div className="label"><CalendarDays size={12} /> {strings.dashboard.nextFixture}</div>
            <div className="value" style={{ fontSize: "1.15rem" }}>
              {snapshot.nextFixture ? `${snapshot.nextFixture.home} vs ${snapshot.nextFixture.away}` : strings.dashboard.noNextFixture}
            </div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.85rem", marginTop: 8, display: "flex", alignItems: "center", gap: 5 }}>
            {snapshot.nextFixture && <Clock size={12} />} {snapshot.nextFixture ? snapshot.nextFixture.dayLabel : ""}
          </div>
        </div>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title"><Activity size={17} /> {strings.dashboard.news}</h2>
          <div className="news-list">
            {snapshot.news.length === 0 && <div className="empty-state" style={{ padding: "24px 10px" }}>No news yet.</div>}
            {snapshot.news.slice(0, 12).map((n, i) => (
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
