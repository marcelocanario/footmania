import { useNavigate } from "react-router-dom";
import { Trophy, ArrowDown, ArrowUp, PartyPopper, Medal } from "lucide-react";
import { useGame } from "../store/game";
import { strings } from "../strings";

export function SeasonEnd() {
  const { snapshot } = useGame();
  const navigate = useNavigate();
  const summary = snapshot?.seasonSummary;
  const clubName = snapshot?.club?.name;
  const promoted = summary?.promoted.includes(clubName ?? "") ?? false;
  const relegated = summary?.relegated.includes(clubName ?? "") ?? false;

  if (!summary) {
    return (
      <div>
        <div className="page-head">
          <div>
            <div className="kicker">{strings.seasonEnd.title}</div>
            <h1>{strings.seasonEnd.title}</h1>
          </div>
        </div>
        <div className="card empty-state">
          <button className="btn" onClick={() => navigate("/dashboard")}>
            {strings.dashboard.continue}
          </button>
        </div>
      </div>
    );
  }

  const champions = [
    { label: "National Champion", value: summary.leagueChampion, icon: <Trophy size={18} /> },
    { label: "National Cup", value: summary.cupChampion, icon: <Medal size={18} /> },
    { label: "State Champion", value: summary.stateChampion, icon: <Medal size={18} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{strings.seasonEnd.title}</div>
          <h1>
            <PartyPopper size={24} style={{ verticalAlign: "middle", color: "var(--gold-2)" }} />{" "}
            {snapshot && snapshot.save.year > 1 ? `Season ${snapshot.save.year - 1} Complete` : "Season Complete"}
          </h1>
        </div>
      </div>

      <div
        className="card"
        style={{
          marginBottom: 16,
          textAlign: "center",
          padding: "30px 22px",
          background: "linear-gradient(180deg, rgba(240,180,41,0.14), rgba(35,165,90,0.08))",
          borderColor: "rgba(240,180,41,0.45)",
        }}
      >
        <div style={{ fontSize: 34, marginBottom: 8 }}>🏆</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "1.7rem", fontWeight: 800, letterSpacing: "0.05em" }}>
          {clubName}
        </div>
        {promoted && (
          <span className="chip" style={{ marginTop: 12, borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)", background: "rgba(35,165,90,0.16)", fontWeight: 800, fontSize: "0.9rem", padding: "8px 18px" }}>
            <ArrowUp size={14} /> PROMOTED!
          </span>
        )}
        {relegated && (
          <span className="chip" style={{ marginTop: 12, borderColor: "rgba(229,72,77,0.5)", color: "var(--red-2)", background: "rgba(229,72,77,0.14)", fontWeight: 800, fontSize: "0.9rem", padding: "8px 18px" }}>
            <ArrowDown size={14} /> RELEGATED
          </span>
        )}
        {!promoted && !relegated && (
          <div style={{ color: "var(--text-2)", fontSize: "0.92rem", marginTop: 12 }}>
            {summary.leagueChampion === clubName
              ? "You are the National Champions!"
              : "Another year in the books. See you next season, manager."}
          </div>
        )}
      </div>

      <div className="grid cols-3 stagger">
        {champions.map((c) => (
          <div className="card" key={c.label} style={{ textAlign: "center", padding: "22px 16px" }}>
            <div style={{ color: "var(--gold-2)", marginBottom: 8, display: "flex", justifyContent: "center" }}>{c.icon}</div>
            <div style={{ color: "var(--text-3)", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>{c.label}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "1.35rem", fontWeight: 700, marginTop: 6 }}>
              {c.value ?? "—"}
            </div>
          </div>
        ))}
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title" style={{ color: "var(--grass-2)" }}>
            <ArrowUp size={17} /> {strings.seasonEnd.promoted}
          </h2>
          <div className="news-list">
            {summary.promoted.length === 0 && <div className="empty-state" style={{ padding: "20px 10px" }}>No promotions</div>}
            {summary.promoted.map((name) => (
              <div className="news-item" key={name}>
                <span className="day" style={{ color: "var(--grass-2)" }}>↑</span> {name}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2 className="card-title" style={{ color: "var(--red-2)" }}>
            <ArrowDown size={17} /> {strings.seasonEnd.relegated}
          </h2>
          <div className="news-list">
            {summary.relegated.length === 0 && <div className="empty-state" style={{ padding: "20px 10px" }}>No relegations</div>}
            {summary.relegated.map((name) => (
              <div className="news-item" key={name}>
                <span className="day" style={{ color: "var(--red-2)" }}>↓</span> {name}
              </div>
            ))}
          </div>
        </div>
      </div>

      {snapshot?.seasonAwards && snapshot.seasonAwards.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="card-title"><Medal size={17} /> Season awards</h2>
          <div className="news-list">
            {snapshot.seasonAwards.slice(0, 12).map((award, i) => (
              <div className="news-item" key={`${award.category}-${award.competitionId}-${i}`}>
                <span className="day">{award.category.replaceAll("_", " ")}</span>
                <span>{award.playerNameSnapshot ?? "Club award"}</span>
                <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>{award.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, textAlign: "center" }}>
        <button className="btn gold" style={{ fontSize: "1.1rem", minHeight: 52, padding: "14px 40px" }} onClick={() => navigate("/dashboard")}>
          <Trophy size={18} /> {strings.seasonEnd.newYear}
        </button>
      </div>
    </div>
  );
}
