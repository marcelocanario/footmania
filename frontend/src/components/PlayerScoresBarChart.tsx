import { useTranslation } from "react-i18next";

/**
 * Compact line chart for a player's performance ratings (this season or
 * per-season averages). Rendered as inline SVG; points with a null value are
 * skipped. A single data point still renders (as a dot) so current-season
 * ratings show before the season ends.
 *
 * For "Avg rating · this season" the chart also renders horizontal axis
 * labels underneath each point, showing the match sequence like 1, 2, 3.
 * The right-side value now shows the season average (when provided) instead
 * of the last game's rating, and Y axis labels show the rating scale.
 */
export function PlayerScoresBarChart({
  label,
  points,
  unit = "score",
  maxScore = 10,
  sideValue,
}: {
  label: string;
  points: { key: string; value: number | null; title?: string }[];
  unit?: "score" | "avg";
  maxScore?: number;
  /** Value shown on the right (season average). When provided, it overrides the last-point value. */
  sideValue?: number | null;
}) {
  const { t } = useTranslation();
  const valid = points.filter((p): p is { key: string; value: number; title?: string } => p.value !== null && Number.isFinite(p.value));
  // Both match ratings and season averages are now shown with 1 decimal (user request).
  const fmt = (v: number) => v.toFixed(1);

  if (valid.length === 0) {
    return (
      <div className="player-trend player-trend-empty">
        <span className="player-trend-label">{label}</span>
        <span className="player-trend-note">{t("playerScores.noData")}</span>
      </div>
    );
  }

  const width = 220;
  const chartHeight = 56;
  // The "this season" mode (match-sequence ratings) reserves vertical space
  // for match-number labels under the chart; per-season averages do not.
  const isThisSeason = unit === "score";
  // Reserve extra vertical space for match-number labels under the chart.
  const xLabelHeight = isThisSeason ? 14 : 0;
  const height = chartHeight + xLabelHeight;
  const yAxisWidth = 26;
  const padRight = 4;
  const padTop = 4;
  const padBottom = 4;
  const chartLeft = yAxisWidth;
  const chartRight = width - padRight;
  const chartTop = padTop;
  const chartBottom = chartHeight - padBottom;
  const chartWidth = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;
  const max = Math.max(maxScore, ...valid.map((p) => p.value));
  const min = Math.min(...valid.map((p) => p.value));
  const range = max - min || 1;
  const step = valid.length > 1 ? chartWidth / (valid.length - 1) : 0;
  const x = (i: number) => chartLeft + (valid.length > 1 ? i * step : chartWidth / 2);
  const y = (v: number) => chartTop + chartH * (1 - (v - min) / range);
  const polyline = valid.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  // Y axis ticks: show max, mid, min (avoid duplicate when range tiny)
  const mid = (max + min) / 2;
  const yTicks = range < 0.3 ? [max, min] : [max, mid, min].filter((v, idx, arr) => arr.findIndex((a) => Math.abs(a - v) < 0.05) === idx);
  const sideDisplay = sideValue != null && Number.isFinite(sideValue) ? sideValue : valid[valid.length - 1].value;

  return (
    <div className="player-trend">
      <span className="player-trend-label">{label}</span>
      <div className="player-trend-chart">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${valid.map((p) => fmt(p.value)).join(", ")}`} style={{ width: "100%", height }}>
          {/* Y axis grid + labels */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={chartLeft} x2={chartRight} y1={y(tick)} y2={y(tick)} stroke="rgba(228,245,235,0.08)" strokeWidth={0.7} />
              <text x={chartLeft - 4} y={y(tick) + 2.5} textAnchor="end" fontSize={6.5} fill="var(--text-3)" fontFamily="var(--font-display)">
                {fmt(tick)}
              </text>
            </g>
          ))}
          {/* Y axis line */}
          <line x1={chartLeft} x2={chartLeft} y1={chartTop} y2={chartBottom} stroke="rgba(228,245,235,0.18)" strokeWidth={0.7} />
          {/* X axis line */}
          <line x1={chartLeft} x2={chartRight} y1={chartBottom} y2={chartBottom} stroke="rgba(228,245,235,0.18)" strokeWidth={0.7} />
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
          {isThisSeason &&
            valid.map((p, i) => (
              <text
                key={`lbl-${p.key}`}
                x={x(i)}
                y={chartHeight + 10}
                textAnchor="middle"
                fontSize={7}
                fill="var(--text-3)"
                fontFamily="var(--font-display)"
              >
                {String(i + 1)}
              </text>
            ))}
        </svg>
        <span className="player-trend-current">{fmt(sideDisplay)}</span>
      </div>
    </div>
  );
}
