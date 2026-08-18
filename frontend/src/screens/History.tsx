import { useEffect, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import { api, type SeasonHistoryView } from "../api/client";

export function History() {
  const [seasons, setSeasons] = useState<SeasonHistoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .history()
      .then((res) => setSeasons(res.seasons))
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="empty-state" style={{ paddingTop: 80 }}>Could not load history: {error}</div>;
  if (!seasons) return <div className="empty-state" style={{ paddingTop: 80 }}>Loading…</div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">Club history</div>
          <h1><HistoryIcon size={22} style={{ verticalAlign: -3 }} /> Season History</h1>
        </div>
      </div>

      {seasons.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: 40 }}>
          <HistoryIcon size={30} />
          <div style={{ marginTop: 8 }}>No completed seasons yet. History appears after the first season rollover.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {seasons.map((season) => (
            <div className="card" key={season.seasonId}>
              <h2 className="card-title" style={{ marginBottom: 12 }}>Season {season.seasonKey}</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {season.divisions.map((div) => (
                  <div key={div.divisionId}>
                    <div style={{ color: "var(--text-2)", fontWeight: 700, marginBottom: 6 }}>
                      Division {div.divisionName}
                    </div>
                    <table className="standings-table">
                      <thead>
                        <tr>
                          <th>P</th>
                          <th>Club</th>
                          <th>Pld</th>
                          <th>W</th>
                          <th>D</th>
                          <th>L</th>
                          <th>GF</th>
                          <th>GA</th>
                          <th>Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {div.standings.map((row, i) => (
                          <tr key={row.clubId} className={row.isMine ? "my-row" : ""}>
                            <td>{i + 1}</td>
                            <td>{row.clubName}{row.isMine ? " ·" : ""}</td>
                            <td>{row.played}</td>
                            <td>{row.wins}</td>
                            <td>{row.draws}</td>
                            <td>{row.losses}</td>
                            <td>{row.goalsFor}</td>
                            <td>{row.goalsAgainst}</td>
                            <td><b>{row.points}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
