import type { CSSProperties, ReactNode } from "react";

export type ChipTone = "neutral" | "info" | "running" | "done" | "failed" | "cancelled" | "gold";

const TONE_STYLES: Record<ChipTone, CSSProperties> = {
  neutral: { borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" },
  info: { borderColor: "rgba(110,150,210,0.45)", color: "#8fb3e8" },
  running: { borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" },
  done: { borderColor: "rgba(61,220,132,0.45)", color: "var(--grass-2)" },
  failed: { borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b" },
  cancelled: { borderColor: "rgba(120,140,130,0.35)", color: "var(--text-3)", textDecoration: "line-through" },
  gold: { borderColor: "rgba(240,180,41,0.65)", color: "var(--gold-2)", background: "rgba(240,180,41,0.12)" },
};

/** Small colored pill used for statuses, phases and categories across the admin panel. */
export function StatusChip({ label, tone = "neutral", title, pulse }: { label: ReactNode; tone?: ChipTone; title?: string; pulse?: boolean }) {
  const style = TONE_STYLES[tone];
  return (
    <span className="chip" title={title} style={{ ...style, gap: 6 }}>
      {pulse && <span className="dot" style={{ background: "currentColor", animation: "pulse 1.4s ease-in-out infinite" }} />}
      {label}
    </span>
  );
}

export function phaseTone(phase: string | null): ChipTone {
  if (phase === "BEGIN_OF_DAY") return "info";
  if (phase === "END_OF_DAY") return "running";
  return "neutral";
}
