import { useEffect, useRef } from "react";
import { userTimeZone } from "../utils/time";

/**
 * Preferred match-time picker: a 24-hour timeline of 48 half-hour slots the
 * player paints (click or drag). Selections may be non-contiguous and wrap
 * midnight; at least 8 hours (16 slots) must be selected before saving.
 *
 * Slots are labeled in the browser's auto-detected timezone; callers convert
 * to/from the server's UTC grid via utils/time.ts when loading and saving.
 */
export const SLOTS_PER_DAY = 48;
export const MIN_SLOTS = 16;

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

export const PRESET_EVENINGS = [...range(34, SLOTS_PER_DAY), ...range(0, 2)]; // 17:00–01:00

const PRESETS: { label: string; slots: number[] }[] = [
  { label: "All day", slots: range(0, SLOTS_PER_DAY) },
  { label: "Daytime", slots: range(16, 40) }, // 08:00–20:00
  { label: "Evenings", slots: PRESET_EVENINGS },
  { label: "Nights", slots: [...range(40, SLOTS_PER_DAY), ...range(0, 8)] }, // 20:00–04:00
];

function slotLabel(slot: number): string {
  const h = Math.floor(slot / 2);
  const m = slot % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
}

interface Props {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}

export function AvailabilityPicker({ value, onChange, disabled }: Props) {
  const selected = new Set(value);
  const painting = useRef<{ active: boolean; mode: boolean }>({ active: false, mode: true });
  // Anchor slot for shift+click range fills (last slot clicked without Shift).
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    const stop = () => { painting.current.active = false; };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const apply = (slot: number, mode: boolean) => {
    if (selected.has(slot) === mode) return;
    const next = mode ? [...value, slot] : value.filter((s) => s !== slot);
    onChange(next);
  };

  // Shift+click fills the whole range between the anchor and this slot in one
  // action, using the anchor's pre-click state as the paint mode.
  const applyRange = (from: number, to: number, mode: boolean) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const next = new Set(value);
    for (let s = lo; s <= hi; s++) {
      if (mode) next.add(s);
      else next.delete(s);
    }
    onChange([...next].sort((a, b) => a - b));
  };

  const hours = value.length / 2;
  const enough = value.length >= MIN_SLOTS;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="btn sm" disabled={disabled} onClick={() => onChange(p.slots)}>{p.label}</button>
        ))}
        <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onChange([])}>Clear</button>
      </div>
      {/* Each column is one hour: full hour (:00) stacked above its half-hour (:30),
          with minute indicators on the left edge. */}
      <div style={{ display: "flex", gap: 6 }}>
        <div
          aria-hidden
          style={{
            display: "grid",
            gridTemplateRows: "26px 26px",
            gap: 3,
            fontSize: "0.68rem",
            color: "var(--text-3)",
            alignItems: "center",
            textAlign: "right",
            minWidth: 16,
            userSelect: "none",
          }}
        >
          <span>:00</span>
          <span>:30</span>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 3, userSelect: "none", touchAction: "none" }}>
          {Array.from({ length: SLOTS_PER_DAY }, (_, slot) => {
            const isSel = selected.has(slot);
            return (
              <button
                key={slot}
                type="button"
                title={slotLabel(slot)}
                aria-label={slotLabel(slot)}
                aria-pressed={isSel}
                disabled={disabled}
                onPointerDown={(e) => {
                  if (e.shiftKey && anchor.current !== null && !disabled) {
                    const mode = !selected.has(anchor.current);
                    painting.current = { active: true, mode };
                    applyRange(anchor.current, slot, mode);
                    return;
                  }
                  const mode = !isSel;
                  anchor.current = slot;
                  painting.current = { active: true, mode };
                  apply(slot, mode);
                }}
                onPointerEnter={(e) => {
                  if (painting.current.active && e.buttons > 0) apply(slot, painting.current.mode);
                }}
                style={{
                  height: 26,
                  borderRadius: 5,
                  cursor: "pointer",
                  border: isSel ? "1px solid var(--grass-2)" : "1px solid var(--line)",
                  background: isSel ? "var(--grass-2)" : "transparent",
                  padding: 0,
                  opacity: disabled ? 0.5 : 1,
                  gridColumn: Math.floor(slot / 2) + 1,
                  gridRow: (slot % 2) + 1,
                }}
              />
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text-3)", marginTop: 4 }}>
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
      <div style={{ marginTop: 8, fontSize: "0.88rem", color: enough ? "var(--text-2)" : "var(--gold-2)" }}>
        {hours.toFixed(1)} h selected{!enough && ` — pick at least ${MIN_SLOTS / 2} hours`}
      </div>
      <div style={{ marginTop: 4, fontSize: "0.78rem", color: "var(--text-3)" }}>
        Shift-click to fill a range of slots at once. Times shown in your timezone ({userTimeZone()}).
      </div>
    </div>
  );
}
