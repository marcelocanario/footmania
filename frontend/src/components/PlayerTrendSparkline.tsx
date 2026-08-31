import { money } from "../format";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const points = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const labelValue = (v: number) => (unit === "money" ? money(v) : t("playerScores.ovrValue", { value: v }));

  if (points.length === 0) {
    return (
      <div className="player-trend player-trend-empty">
        <span className="player-trend-label">{label}</span>
        <span className="player-trend-note">{t("playerScores.noData")}</span>
      </div>
    );
  }

  const width = 220;
  const height = 44;
  const yAxisWidth = unit === "money" ? 36 : 26;
  const padRight = 4;
  const padTop = 4;
  const padBottom = 4;
  const chartLeft = yAxisWidth;
  const chartRight = width - padRight;
  const chartTop = padTop;
  const chartBottom = height - padBottom;
  const chartWidth = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = points.length > 1 ? chartWidth / (points.length - 1) : 0;
  const x = (i: number) => chartLeft + (points.length > 1 ? i * step : chartWidth / 2);
  const y = (v: number) => chartTop + chartH * (1 - (v - min) / range);
  const polyline = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1]);
  const color = unit === "money" ? "var(--gold-2)" : "var(--grass-2)";
  const fmtY = (v: number) => (unit === "money" ? money(v) : String(Math.round(v)));
  const mid = (max + min) / 2;
  const yTicks = range < 1 ? [max, min] : [max, mid, min].filter((v, idx, arr) => arr.findIndex((a) => Math.abs(a - v) < (unit === "money" ? 50000 : 0.5)) === idx);

  return (
    <div className="player-trend">
      <span className="player-trend-label">{label}</span>
      <div className="player-trend-chart">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${points.map(labelValue).join(", ")}`} style={{ width: "100%", height: 44 }}>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={chartLeft} x2={chartRight} y1={y(tick)} y2={y(tick)} stroke="rgba(228,245,235,0.08)" strokeWidth={0.7} />
              <text x={chartLeft - 4} y={y(tick) + 2.5} textAnchor="end" fontSize={6.5} fill="var(--text-3)" fontFamily="var(--font-display)">
                {fmtY(tick)}
              </text>
            </g>
          ))}
          <line x1={chartLeft} x2={chartLeft} y1={chartTop} y2={chartBottom} stroke="rgba(228,245,235,0.18)" strokeWidth={0.7} />
          <line x1={chartLeft} x2={chartRight} y1={chartBottom} y2={chartBottom} stroke="rgba(228,245,235,0.18)" strokeWidth={0.7} />
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
