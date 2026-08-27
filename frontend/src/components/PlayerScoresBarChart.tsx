/**
 * Compact line chart for a player's performance ratings (this season or
 * per-season averages). Rendered as inline SVG; points with a null value are
 * skipped. A single data point still renders (as a dot) so current-season
 * ratings show before the season ends.
 */
export function PlayerScoresBarChart({
  label,
  points,
  unit = "score",
  maxScore = 10,
}: {
  label: string;
  points: { key: string; value: number | null; title?: string }[];
  unit?: "score" | "avg";
  maxScore?: number;
}) {
  const valid = points.filter((p): p is { key: string; value: number; title?: string } => p.value !== null && Number.isFinite(p.value));
  const fmt = (v: number) => (unit === "avg" ? v.toFixed(2) : v.toFixed(1));

  if (valid.length === 0) {
    return (
      <div className="player-trend player-trend-empty">
        <span className="player-trend-label">{label}</span>
        <span className="player-trend-note">No data yet</span>
      </div>
    );
  }

  const width = 220;
  const height = 56;
  const pad = 4;
  const max = Math.max(maxScore, ...valid.map((p) => p.value));
  const min = Math.min(...valid.map((p) => p.value));
  const range = max - min || 1;
  const step = valid.length > 1 ? (width - pad * 2) / (valid.length - 1) : 0;
  const x = (i: number) => pad + (valid.length > 1 ? i * step : (width - pad * 2) / 2);
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / range);
  const polyline = valid.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");

  return (
    <div className="player-trend">
      <span className="player-trend-label">{label}</span>
      <div className="player-trend-chart">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${valid.map((p) => fmt(p.value)).join(", ")}`} style={{ width: "100%", height }}>
          {valid.length > 1 && (
            <polyline points={polyline} fill="none" stroke="var(--grass-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
          )}
          {valid.map((p, i) => (
            <circle
              key={p.key}
              cx={x(i)}
              cy={y(p.value)}
              r={i === valid.length - 1 ? 3.2 : 2.4}
              fill={i === valid.length - 1 ? "var(--grass-2)" : "var(--grass)"}
            >
              <title>{p.title ?? `${p.key}: ${fmt(p.value)}`}</title>
            </circle>
          ))}
        </svg>
        <span className="player-trend-current">{fmt(valid[valid.length - 1].value)}</span>
      </div>
    </div>
  );
}
