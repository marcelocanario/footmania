import { ArrowDown, ArrowUp, Award, CalendarDays, History as HistoryIcon, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TeamHistoryRow } from "../api/client";
import { HistoryStatusBadges } from "./HistoryStatusBadges";

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="season-timeline-metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function SeasonHistoryTimeline({ rows, trophies }: { rows: TeamHistoryRow[]; trophies: Record<string, number> }) {
  const { t } = useTranslation();
  const orderedRows = [...rows].reverse();
  const titles = Object.values(trophies).reduce((sum, count) => sum + count, 0);
  const bestFinish = rows.length > 0 ? Math.min(...rows.map((row) => row.position)) : null;
  const promotions = rows.filter((row) => row.promoted).length;
  const relegations = rows.filter((row) => row.relegated).length;
  const titleEntries = Object.entries(trophies);

  return (
    <div className="season-history-module">
      <div className="season-history-summary">
        <div className="season-history-stat"><CalendarDays size={16} /><span>{t("seasonTimeline.seasons")}</span><b>{rows.length}</b></div>
        <div className="season-history-stat"><Award size={16} /><span>{t("seasonTimeline.bestFinish")}</span><b>{bestFinish === null ? "—" : `#${bestFinish}`}</b></div>
        <div className="season-history-stat"><ArrowUp size={16} /><span>{t("seasonTimeline.promotions")}</span><b>{promotions}</b></div>
        <div className="season-history-stat"><ArrowDown size={16} /><span>{t("seasonTimeline.relegations")}</span><b>{relegations}</b></div>
        <div className="season-history-stat gold"><Trophy size={16} /><span>{t("seasonTimeline.titles")}</span><b>{titles}</b></div>
      </div>

      {titleEntries.length > 0 && (
        <div className="season-history-trophies">
          <div className="season-history-trophies-head"><Trophy size={15} /> {t("seasonTimeline.trophyHaul")}</div>
          <div className="season-history-trophy-list">
            {titleEntries.map(([name, count]) => <span key={name} className="season-history-trophy"><Trophy size={12} /> {name} · {count}×</span>)}
          </div>
        </div>
      )}

      {orderedRows.length === 0 ? (
        <div className="empty-state season-history-empty">
          <HistoryIcon size={28} />
          <span>{t("seasonTimeline.noCompletedSeasons")}</span>
        </div>
      ) : (
        <div className="season-timeline">
          {orderedRows.map((row) => (
            <article key={`${row.seasonKey}-${row.divisionName}`} className={`season-timeline-item${row.champion ? " champion" : ""}`}>
              <div className="season-timeline-marker"><span>{row.seasonKey}</span></div>
              <div className="season-timeline-card">
                <div className="season-timeline-head">
                  <div>
                    <div className="kicker">{t("seasonTimeline.division", { name: row.divisionName })}</div>
                    <div className="season-timeline-sub">{t("seasonTimeline.tier", { tier: row.tier })}</div>
                  </div>
                  <div className={`season-timeline-position${row.position === 1 ? " champion" : ""}`}>
                    <span>{t("seasonTimeline.finish")}</span>
                    <b>#{row.position}</b>
                  </div>
                </div>
                <div className="season-timeline-metrics">
                  <Metric label={t("seasonTimeline.record")} value={`${row.wins}-${row.draws}-${row.losses}`} />
                  <Metric label={t("seasonTimeline.goals")} value={`${row.goalsFor}:${row.goalsAgainst}`} />
                  <Metric label={t("seasonTimeline.points")} value={row.points} />
                </div>
                <HistoryStatusBadges champion={row.champion} promoted={row.promoted} relegated={row.relegated} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
