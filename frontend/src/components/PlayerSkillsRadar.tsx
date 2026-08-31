import { useId } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import type { SkillSet } from "../api/client";

function skillLabels(): [keyof SkillSet, string][] {
  const t = i18n.t as unknown as (k: string) => string;
  return [
    ["gol", t("market.skills.gol")],
    ["pace", t("market.skills.pace")],
    ["tec", t("market.skills.tec")],
    ["pas", t("market.skills.pas")],
    ["des", t("market.skills.des")],
    ["playmaking", t("market.skills.playmaking")],
    ["fin", t("market.skills.fin")],
  ];
}

const CENTER = { x: 150, y: 128 };
const RADIUS = 86;
const LABEL_RADIUS = 108;
const RINGS = [0.25, 0.5, 0.75, 1];

function pointAt(index: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / skillLabels().length;
  return {
    x: CENTER.x + Math.cos(angle) * radius,
    y: CENTER.y + Math.sin(angle) * radius,
  };
}

function pointsFor(skills: SkillSet, radius: number): string {
  return skillLabels().map(([key], index) => {
    const raw = (skills as unknown as Record<string, number | undefined>)[key];
    // Fallback for legacy saves that still have vel/arm
    const fallbackKey = key === "pace" ? "vel" : key === "playmaking" ? "arm" : undefined;
    const val = raw ?? (fallbackKey ? (skills as unknown as Record<string, number | undefined>)[fallbackKey] : undefined) ?? 0;
    const point = pointAt(index, radius * Math.max(0, Math.min(100, val)) / 100);
    return `${point.x},${point.y}`;
  }).join(" ");
}

/** Wrap long labels onto two lines near the middle so the SVG stays tidy. */
function formatLabel(label: string): string[] {
  if (label.length <= 9) return [label];
  const mid = Math.ceil(label.length / 2);
  return [label.slice(0, mid), label.slice(mid)];
}

export function PlayerSkillsRadar({ skills, compact = false }: { skills: SkillSet; compact?: boolean }) {
  const { t } = useTranslation();
  const labels = skillLabels();
  const gradientId = `skillRadarFill${useId().replace(/:/g, "")}`;

  return (
    <div className={`skills-radar${compact ? " skills-radar-compact" : ""}`}>
      <svg viewBox="0 0 300 256" role="img" aria-label={t("skillsRadar.aria")}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--grass-2)" stopOpacity="0.46" />
            <stop offset="100%" stopColor="var(--grass)" stopOpacity="0.14" />
          </linearGradient>
        </defs>

        {RINGS.map((scale) => (
          <polygon
            key={scale}
            points={pointsFor({ gol: 100, pace: 100, tec: 100, pas: 100, des: 100, playmaking: 100, fin: 100 }, RADIUS * scale)}
            className={scale === 1 ? "skills-radar-ring outer" : "skills-radar-ring"}
          />
        ))}

        {labels.map(([, label], index) => {
          const point = pointAt(index, RADIUS);
          const labelPoint = pointAt(index, LABEL_RADIUS);
          const anchor = labelPoint.x < CENTER.x - 10 ? "end" : labelPoint.x > CENTER.x + 10 ? "start" : "middle";
          const lines = formatLabel(label);
          return (
            <g key={label}>
              <line x1={CENTER.x} y1={CENTER.y} x2={point.x} y2={point.y} className="skills-radar-axis" />
              <text x={labelPoint.x} y={labelPoint.y - (lines.length > 1 ? 4 : 0)} textAnchor={anchor} className="skills-radar-label">
                {lines.map((line, lineIndex) => <tspan key={line} x={labelPoint.x} dy={lineIndex === 0 ? 0 : 11}>{line}</tspan>)}
              </text>
            </g>
          );
        })}

        <polygon points={pointsFor(skills, RADIUS)} className="skills-radar-shape" fill={`url(#${gradientId})`} />
        <circle cx={CENTER.x} cy={CENTER.y} r="3.5" className="skills-radar-center" />
      </svg>

      <div className="skills-radar-legend">
        {labels.map(([key, label]) => {
          const raw = (skills as unknown as Record<string, number | undefined>)[key];
          const fallbackKey = key === "pace" ? "vel" : key === "playmaking" ? "arm" : undefined;
          const val = raw ?? (fallbackKey ? (skills as unknown as Record<string, number | undefined>)[fallbackKey] : undefined) ?? 0;
          return (
            <div className="skills-radar-stat" key={key}>
              <span>{label}</span>
              <strong>{val}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
