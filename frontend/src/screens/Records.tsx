import { Medal, Trophy } from "lucide-react";
import { useGame } from "../store/game";

const LABELS: Record<string, string> = {
  all_time_goals: "All-time goals",
  most_goals_in_season: "Most goals in a season",
  most_titles: "Most league titles",
  longest_unbeaten: "Longest unbeaten run",
};

export function Records() {
  const { snapshot } = useGame();
  const records = snapshot?.records ?? [];
  const awards = snapshot?.seasonAwards ?? [];

  return <div>
    <div className="page-head">
      <div><div className="kicker">Club history</div><h1>Records & awards</h1></div>
    </div>
    <div className="grid cols-2 stagger">
      <div className="card">
        <h2 className="card-title"><Trophy size={17} /> Career records</h2>
        {records.length === 0 ? <div className="empty-state">Records will appear after the first season.</div> : <div className="news-list">
          {records.map((record) => <div className="news-item" key={record.category}>
            <span className="day">{record.value}</span>
            <span>{LABELS[record.category] ?? record.category}</span>
            <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>{record.holderName}</span>
          </div>)}
        </div>}
      </div>
      <div className="card">
        <h2 className="card-title"><Medal size={17} /> Recent awards</h2>
        {awards.length === 0 ? <div className="empty-state">Season awards will appear at rollover.</div> : <div className="news-list">
          {awards.slice(0, 20).map((award, i) => <div className="news-item" key={`${award.season}-${award.category}-${award.competitionId}-${i}`}>
            <span className="day">Y{award.season}</span>
            <span>{award.category.replaceAll("_", " ")}</span>
            <span style={{ marginLeft: "auto", color: "var(--gold-2)" }}>{award.playerNameSnapshot ?? award.detail ?? ""}</span>
          </div>)}
        </div>}
      </div>
    </div>
  </div>;
}
