import type { MatchStats } from "../api/client";

function share(home: number, away: number): [number, number] {
  const total = home + away;
  if (total <= 0) return [50, 50];
  const homeShare = Math.round((home / total) * 100);
  return [homeShare, 100 - homeShare];
}

export function MatchStatsPanel({ stats, usedSubs, mvp }: { stats: MatchStats; usedSubs?: [number, number]; mvp?: { name: string | null; clubName?: string | null } | null }) {
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
          <span className="bar-label">🏆 Man of the match</span>
          <span className="mvp-name">{mvp.name}{mvp.clubName ? ` · ${mvp.clubName}` : ""}</span>
        </div>
      ) : null}
      {bar("Possession", possession[0], possession[1])}
      {bar("Shots", stats.home.shots, stats.away.shots)}
      {bar("Shots on target", stats.home.shotsOnTarget, stats.away.shotsOnTarget)}
      {bar("xG", Number(stats.home.xG.toFixed(2)), Number(stats.away.xG.toFixed(2)))}
      {bar("Field tilt", fieldTilt[0], fieldTilt[1])}
      {bar("Passes", stats.home.passes, stats.away.passes)}
      {bar("Crosses", stats.home.crosses, stats.away.crosses)}
      {bar("Carries", stats.home.carries, stats.away.carries)}
      {bar("Dribbles", stats.home.dribbles, stats.away.dribbles)}
      {bar("Box entries", stats.home.boxEntries, stats.away.boxEntries)}
      {bar("Counterattacks", stats.home.counterattacks, stats.away.counterattacks)}
      {bar("Counter shots", stats.home.counterattackShots, stats.away.counterattackShots)}
      {bar("High recoveries", stats.home.highRecoveries, stats.away.highRecoveries)}
      {bar("Turnovers", stats.home.turnovers, stats.away.turnovers)}
      {bar("Corners", stats.home.corners, stats.away.corners)}
      {bar("Fouls", stats.home.fouls, stats.away.fouls)}
      {bar("Offsides", stats.home.offsides, stats.away.offsides)}
      {bar("Penalties", stats.home.penalties, stats.away.penalties)}
      <div className="live-stat-chips">
        <span className="chip">🟨 {stats.home.yellows} : {stats.away.yellows}</span>
        <span className="chip">🟥 {stats.home.reds} : {stats.away.reds}</span>
        <span className="chip">Injuries {stats.home.injuries} : {stats.away.injuries}</span>
        {usedSubs && <span className="chip">Subs {usedSubs[0]} : {usedSubs[1]}</span>}
      </div>
    </div>
  );
}
