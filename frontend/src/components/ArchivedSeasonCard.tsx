import { ChevronDown, ChevronUp, Layers3 } from "lucide-react";
import { useState } from "react";
import type { SeasonHistoryView } from "../api/client";
import { ClubNameLink } from "./ClubNameLink";
import { HistoryStatusBadges } from "./HistoryStatusBadges";

export function ArchivedSeasonCard({ season, initialOpen = false }: { season: SeasonHistoryView; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const divisionCount = season.divisions.length;
  const clubCount = season.divisions.reduce((total, division) => total + division.standings.length, 0);

  return (
    <section className={`archive-season-card${open ? " open" : ""}`}>
      <button type="button" className="archive-season-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="archive-season-mark"><Layers3 size={18} /></span>
        <span className="archive-season-title">
          <span className="kicker">Completed campaign</span>
          <b>Season {season.seasonKey}</b>
        </span>
        <span className="archive-season-meta">{divisionCount} divisions · {clubCount} clubs</span>
        <span className="archive-season-chevron" aria-hidden>{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>

      {open && (
        <div className="archive-season-body">
          {season.divisions.map((division) => (
            <div key={division.divisionId} className="archive-division">
              <div className="archive-division-head">
                <div>
                  <div className="kicker">Tier {division.tier} · Group {division.groupIndex + 1}</div>
                  <h3>Division {division.divisionName}</h3>
                </div>
                <span className="archive-division-count">{division.standings.length} clubs</span>
              </div>
              <div className="table-wrap">
                <table className="standings-table archive-standings-table">
                  <thead>
                    <tr>
                      <th>#</th>
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
                    {division.standings.map((row, index) => (
                      <tr key={row.clubId} className={`${row.isMine ? "my-row " : ""}${index === 0 ? "archive-champion-row" : ""}`}>
                        <td><span className={`rank-pill${index === 0 ? " champion-rank" : ""}`}>{index + 1}</span></td>
                        <td>
                          <div className="archive-club-cell">
                            <ClubNameLink clubId={row.clubId} name={row.clubName} />
                            {row.isMine && <span className="flag-chip fc-accent">YOU</span>}
                            <HistoryStatusBadges champion={index === 0} />
                          </div>
                        </td>
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
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
