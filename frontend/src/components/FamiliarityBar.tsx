import type { CSSProperties } from "react";

/**
 * Tactical familiarity meter (plans/6 §17). Renders the drilled familiarity of
 * a tactic setup and, optionally, the projected value after a switch (hollow
 * marker + delta text). Colors follow the shared health/energy gradient:
 * red below 30, gold to 69, green from 70.
 */
export function FamiliarityBar({ value, projected, style, customTooltips = false }: { value: number; projected?: number | null; style?: CSSProperties; customTooltips?: boolean }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped < 30 ? "var(--red)" : clamped < 70 ? "var(--gold-2)" : "var(--grass-2)";
  const showProjection = typeof projected === "number" && Math.round(projected) !== Math.round(clamped);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...style }}>
      <div
        aria-label={`Tactical familiarity ${Math.round(clamped)}%`}
        style={{
          flex: 1,
          height: 10,
          borderRadius: 5,
          background: "rgba(255,255,255,0.12)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: "100%",
            borderRadius: 5,
            background: color,
            transition: "width 200ms ease",
          }}
        />
        {showProjection && (
          <div
            className={customTooltips ? "squad-tooltip-trigger" : undefined}
            {...(customTooltips ? { "data-pr-tooltip": "Familiarity if you adopt this setup" } : { title: "Familiarity if you adopt this setup" })}
            style={{
              position: "absolute",
              top: -1,
              bottom: -1,
              left: `calc(${Math.max(0, Math.min(100, projected ?? 0))}% - 1px)`,
              width: 3,
              borderRadius: 2,
              background: "#f5f7fa",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
            }}
          />
        )}
      </div>
      <span style={{ minWidth: 74, textAlign: "right", fontSize: "0.82rem", fontWeight: 700, color: color }}>
        {Math.round(clamped)}%{showProjection ? ` → ${Math.round(Math.max(0, Math.min(100, projected ?? 0)))}%` : ""}
      </span>
    </div>
  );
}
