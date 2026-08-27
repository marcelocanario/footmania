import { money } from "../format";

/**
 * Compact inline-SVG trend line for a player's per-season overall or market
 * value. Null values (seasons archived before the snapshot existed) are
 * skipped. A single data point still renders (as a dot) so current-season
 * values show before the season ends.
 */
export function PlayerTrendSparkline({
  label,
  values,
  unit = "ovr",
}: {
  label: string;
  values: (number | null)[];
  unit?: "ovr" | "money";
}) {
  const points = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const labelValue = (v: number) => (unit === "money" ? money(v) : `OVR ${v}`);

  if (points.length === 0) {
    return (
      <div className="player-trend player-trend-empty">
        <span className="player-trend-label">{label}</span>
        <span className="player-trend-note">No data yet</span>
      </div>
    );
  }

  const width = 220;
  const height = 44;
  const pad = 4;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const x = (i: number) => pad + (points.length > 1 ? i * step : (width - pad * 2) / 2);
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / range);
  const polyline = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1]);
  const color = unit === "money" ? "var(--gold-2)" : "var(--grass-2)";

  return (
    <div className="player-trend">
      <span className="player-trend-label">{label}</span>
      <div className="player-trend-chart">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${points.map(labelValue).join(", ")}`} style={{ width: "100%", height: 44 }}>
          {points.length > 1 && (
            <polyline points={polyline} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
          )}
          <circle cx={lastX} cy={lastY} r={3} fill={color} />
        </svg>
        <span className="player-trend-current" style={{ color }}>{labelValue(points[points.length - 1])}</span>
      </div>
    </div>
  );
}
