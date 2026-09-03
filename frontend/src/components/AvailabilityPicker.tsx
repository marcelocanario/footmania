import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { userTimeZone } from "../utils/time";
import { useIsMobile } from "../hooks/useIsMobile";

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

const PRESET_SLOTS = {
  allDay: () => range(0, SLOTS_PER_DAY),
  daytime: () => range(16, 40),
  evenings: () => PRESET_EVENINGS,
  nights: () => [...range(40, SLOTS_PER_DAY), ...range(0, 8)],
} as const;

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
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // A 24-column row puts each of the 48 slots at ~9px on a 375px phone — far
  // below any touch target. On mobile the day splits into two stacked 12-hour
  // bands (00:00-12:00 / 12:00-24:00); slots 0-23 land in the top band, 24-47
  // in the bottom, each band keeping its own :00/:30 gutter and legend row.
  const cols = isMobile ? 12 : 24;
  const bands = cols === 24 ? 1 : 2;
  const cell = isMobile ? 32 : 26;
  const gap = isMobile ? 2 : 3;
  const bandSlots = cols === 24 ? SLOTS_PER_DAY : SLOTS_PER_DAY / 2; // 48 or 24
  const presets: { label: string; slots: number[] }[] = [
    { label: t("availability.allDay"), slots: PRESET_SLOTS.allDay() },
    { label: t("availability.daytime"), slots: PRESET_SLOTS.daytime() },
    { label: t("availability.evenings"), slots: PRESET_SLOTS.evenings() },
    { label: t("availability.nights"), slots: PRESET_SLOTS.nights() },
  ];
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
        {presets.map((p) => (
          <button key={p.label} type="button" className="btn sm" disabled={disabled} onClick={() => onChange(p.slots)}>{p.label}</button>
        ))}
        <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onChange([])}>{t("availability.clear")}</button>
      </div>
      {/* Each column is one hour: full hour (:00) stacked above its half-hour (:30),
          with minute indicators on the left edge. On mobile the 24 hours render as
          two stacked 12-hour bands (see `bands` above); each band repeats the
          gutter + grid + legend trio so the row of hour labels stays truthful. */}
      {Array.from({ length: bands }, (_, b) => (
        <div key={b} style={{ marginTop: b > 0 ? 8 : 0 }}>
          {/* Outer gutter-to-grid gap stays 6 on both tiers (desktop-identical);
              only the cell and gutter-row gaps tighten to 2 on mobile. */}
          <div style={{ display: "flex", gap: 6 }}>
            <div
              aria-hidden
              style={{
                display: "grid",
                gridTemplateRows: `${cell}px ${cell}px`,
                gap,
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
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap, userSelect: "none", touchAction: "none" }}>
              {Array.from({ length: bandSlots }, (_, i) => {
                const slot = b * bandSlots + i;
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
                      // Touch gives the pointerdown target implicit pointer
                      // capture, so the enter events that drive drag-paint
                      // never fire on neighboring cells; releasing the capture
                      // here lets pointerenter resume hit-testing normally.
                      if (e.pointerType !== "mouse" && e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
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
                      height: cell,
                      borderRadius: 5,
                      cursor: "pointer",
                      border: isSel ? "1px solid var(--grass-2)" : "1px solid var(--line)",
                      background: isSel ? "var(--grass-2)" : "transparent",
                      padding: 0,
                      opacity: disabled ? 0.5 : 1,
                      // Hour-within-band: floor(slot/2) is the hour of the day;
                      // mod `cols` (24 desktop, 12 mobile) folds it into the
                      // band's 1..cols column. Row is the :00/:30 half.
                      gridColumn: (Math.floor(slot / 2) % cols) + 1,
                      gridRow: (slot % 2) + 1,
                    }}
                  />
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text-3)", marginTop: 4 }}>
            {cols === 24 ? (
              <>
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </>
            ) : (
              <>
                <span>{String(b * 12).padStart(2, "0")}:00</span>
                <span>{String(b * 12 + 6).padStart(2, "0")}:00</span>
                <span>{String(b * 12 + 12).padStart(2, "0")}:00</span>
              </>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 8, fontSize: "0.88rem", color: enough ? "var(--text-2)" : "var(--gold-2)" }}>
        {t("availability.hoursSelected", { hours: hours.toFixed(1) })}{!enough && ` ${t("availability.pickAtLeast", { hours: MIN_SLOTS / 2 })}`}
      </div>
      <div style={{ marginTop: 4, fontSize: "0.78rem", color: "var(--text-3)" }}>
        {/* No shift-click on touch: the mobile copy promises tap/drag instead. */}
        {t(isMobile ? "availability.hintTouch" : "availability.hint", { zone: userTimeZone() })}
      </div>
    </div>
  );
}
