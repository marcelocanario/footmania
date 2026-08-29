import { useId } from "react";
import type { SkillSet } from "../api/client";

export const SKILL_LABELS: [keyof SkillSet, string][] = [
  ["gol", "Goalkeeping"],
  ["pace", "Pace"],
  ["tec", "Technique"],
  ["pas", "Passing"],
  ["des", "Defending"],
  ["playmaking", "Playmaking"],
  ["fin", "Finishing"],
];

const CENTER = { x: 150, y: 128 };
const RADIUS = 86;
const LABEL_RADIUS = 108;
const RINGS = [0.25, 0.5, 0.75, 1];

function pointAt(index: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / SKILL_LABELS.length;
  return {
    x: CENTER.x + Math.cos(angle) * radius,
    y: CENTER.y + Math.sin(angle) * radius,
  };
}

function pointsFor(skills: SkillSet, radius: number): string {
  return SKILL_LABELS.map(([key], index) => {
    const raw = (skills as unknown as Record<string, number | undefined>)[key];
    // Fallback for legacy saves that still have vel/arm
    const fallbackKey = key === "pace" ? "vel" : key === "playmaking" ? "arm" : undefined;
    const val = raw ?? (fallbackKey ? (skills as unknown as Record<string, number | undefined>)[fallbackKey] : undefined) ?? 0;
    const point = pointAt(index, radius * Math.max(0, Math.min(100, val)) / 100);
    return `${point.x},${point.y}`;
  }).join(" ");
}

function formatLabel(label: string): string[] {
  if (label === "Goalkeeping") return ["Goal", "keeping"];
  if (label === "Technique") return ["Techni", "que"];
  if (label === "Playmaking") return ["Play", "making"];
  return [label];
}

export function PlayerSkillsRadar({ skills, compact = false }: { skills: SkillSet; compact?: boolean }) {
  const gradientId = `skillRadarFill${useId().replace(/:/g, "")}`;

  return (
    <div className={`skills-radar${compact ? " skills-radar-compact" : ""}`}>
      <svg viewBox="0 0 300 256" role="img" aria-label="Player skills radar chart">
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

        {SKILL_LABELS.map(([, label], index) => {
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
        {SKILL_LABELS.map(([key, label]) => {
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
