import { ChevronDown, ChevronUp, Layers3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SeasonHistoryView } from "../api/client";
import { ClubNameLink } from "./ClubNameLink";
import { HistoryStatusBadges } from "./HistoryStatusBadges";

export function ArchivedSeasonCard({ season, initialOpen = false }: { season: SeasonHistoryView; initialOpen?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const divisionCount = season.divisions.length;
  const clubCount = season.divisions.reduce((total, division) => total + division.standings.length, 0);

  return (
    <section className={`archive-season-card${open ? " open" : ""}`}>
      <button type="button" className="archive-season-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="archive-season-mark"><Layers3 size={18} /></span>
        <span className="archive-season-title">
          <span className="kicker">{t("archivedSeason.completedCampaign")}</span>
          <b>{t("archivedSeason.season", { key: season.seasonKey })}</b>
        </span>
        <span className="archive-season-meta">{t("archivedSeason.divisionsClubs", { divisions: divisionCount, clubs: clubCount })}</span>
        <span className="archive-season-chevron" aria-hidden>{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>

      {open && (
        <div className="archive-season-body">
          {season.divisions.map((division) => (
            <div key={division.divisionId} className="archive-division">
              <div className="archive-division-head">
                <div>
                  <div className="kicker">{t("archivedSeason.tierGroup", { tier: division.tier, group: division.groupIndex + 1 })}</div>
                  <h3>{t("archivedSeason.division", { name: division.divisionName })}</h3>
                </div>
                <span className="archive-division-count">{t("archivedSeason.clubs", { count: division.standings.length })}</span>
              </div>
              <div className="table-wrap">
                <table className="standings-table archive-standings-table">
                  <thead>
                    <tr>
                      <th>{t("archivedSeason.rank")}</th>
                      <th>{t("archivedSeason.club")}</th>
                      <th>{t("archivedSeason.pld")}</th>
                      <th>{t("archivedSeason.w")}</th>
                      <th>{t("archivedSeason.d")}</th>
                      <th>{t("archivedSeason.l")}</th>
                      <th>{t("archivedSeason.gf")}</th>
                      <th>{t("archivedSeason.ga")}</th>
                      <th>{t("archivedSeason.pts")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {division.standings.map((row, index) => (
                      <tr key={row.clubId} className={`${row.isMine ? "my-row " : ""}${index === 0 ? "archive-champion-row" : ""}`}>
                        <td><span className={`rank-pill${index === 0 ? " champion-rank" : ""}`}>{index + 1}</span></td>
                        <td>
                          <div className="archive-club-cell">
                            <ClubNameLink clubId={row.clubId} name={row.clubName} />
                            {row.isMine && <span className="flag-chip fc-accent">{t("archivedSeason.you")}</span>}
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
