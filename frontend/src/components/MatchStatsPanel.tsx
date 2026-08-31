import type { MatchStats } from "../api/client";
import { useTranslation } from "react-i18next";

function share(home: number, away: number): [number, number] {
  const total = home + away;
  if (total <= 0) return [50, 50];
  const homeShare = Math.round((home / total) * 100);
  return [homeShare, 100 - homeShare];
}

export function MatchStatsPanel({ stats, usedSubs, mvp }: { stats: MatchStats; usedSubs?: [number, number]; mvp?: { name: string | null; clubName?: string | null } | null }) {
  const { t } = useTranslation();
  const possession = share(stats.home.controlledBallSeconds, stats.away.controlledBallSeconds);
  const fieldTilt = share(stats.home.attackingThirdControlledSeconds, stats.away.attackingThirdControlledSeconds);
  const bar = (label: string, home: number, away: number) => {
    const total = home + away || 1;
    const homePercent = (home / total) * 100;
    return (
      <div className="stat-bar">
        <span className="side-num">{home}</span>
        <div className="track"><div className="fill-h" style={{ width: `${homePercent}%` }} /><div className="fill-a" style={{ width: `${100 - homePercent}%` }} /></div>
        <span className="side-num right">{away}</span>
        <span className="bar-label">{label}</span>
      </div>
    );
  };

  return (
    <div className="match-stats-panel live-stats">
      {mvp?.name ? (
        <div className="mvp-line">
          <span className="bar-label">{t("stats.manOfMatch")}</span>
          <span className="mvp-name">{mvp.name}{mvp.clubName ? ` · ${mvp.clubName}` : ""}</span>
        </div>
      ) : null}
      {bar(t("stats.possession"), possession[0], possession[1])}
      {bar(t("stats.shots"), stats.home.shots, stats.away.shots)}
      {bar(t("stats.shotsOnTarget"), stats.home.shotsOnTarget, stats.away.shotsOnTarget)}
      {bar(t("stats.xG"), Number(stats.home.xG.toFixed(2)), Number(stats.away.xG.toFixed(2)))}
      {bar(t("stats.fieldTilt"), fieldTilt[0], fieldTilt[1])}
      {bar(t("stats.passes"), stats.home.passes, stats.away.passes)}
      {bar(t("stats.crosses"), stats.home.crosses, stats.away.crosses)}
      {bar(t("stats.carries"), stats.home.carries, stats.away.carries)}
      {bar(t("stats.dribbles"), stats.home.dribbles, stats.away.dribbles)}
      {bar(t("stats.boxEntries"), stats.home.boxEntries, stats.away.boxEntries)}
      {bar(t("stats.counterattacks"), stats.home.counterattacks, stats.away.counterattacks)}
      {bar(t("stats.counterShots"), stats.home.counterattackShots, stats.away.counterattackShots)}
      {bar(t("stats.highRecoveries"), stats.home.highRecoveries, stats.away.highRecoveries)}
      {bar(t("stats.turnovers"), stats.home.turnovers, stats.away.turnovers)}
      {bar(t("stats.corners"), stats.home.corners, stats.away.corners)}
      {bar(t("stats.fouls"), stats.home.fouls, stats.away.fouls)}
      {bar(t("stats.offsides"), stats.home.offsides, stats.away.offsides)}
      {bar(t("stats.penalties"), stats.home.penalties, stats.away.penalties)}
      <div className="live-stat-chips">
        <span className="chip">🟨 {stats.home.yellows} : {stats.away.yellows}</span>
        <span className="chip">🟥 {stats.home.reds} : {stats.away.reds}</span>
        <span className="chip">{t("stats.injuries")} {stats.home.injuries} : {stats.away.injuries}</span>
        {usedSubs && <span className="chip">{t("stats.subs")} {usedSubs[0]} : {usedSubs[1]}</span>}
      </div>
    </div>
  );
}
