import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { FootballKit } from "./FootballKit";
import { KIT_PATTERNS } from "./patterns";
import { lumaDistance } from "./colors";
import { KIT_SLOTS, PREVIEW_NUMBERS, SLOT_LABELS, type ClubKits, type KitDesign, type KitSlot } from "./types";

/**
 * Reusable kit editor: slot tabs + pattern grid + palette rows. Fully
 * controlled (`value`/`onChange`) and persistence-free so it can be embedded
 * in the creation wizard and the My Club page alike; the host owns saving.
 * Squad numbers are preview-only (9 outfield / 1 goalkeeper) and never saved.
 */

const PRESET_SWATCHES: { label: string; hex: string }[] = [
  { label: "White", hex: "#ffffff" },
  { label: "Black", hex: "#111111" },
  { label: "Red", hex: "#d40000" },
  { label: "Blue", hex: "#003399" },
  { label: "Yellow", hex: "#ffdd00" },
  { label: "Green", hex: "#008000" },
  { label: "Sky", hex: "#87ceeb" },
  { label: "Maroon", hex: "#800000" },
  { label: "Navy", hex: "#000080" },
  { label: "Orange", hex: "#ff8c00" },
  { label: "Purple", hex: "#660099" },
  { label: "Pink", hex: "#ff69b4" },
];

/** Advisory-only clash threshold on shell luminance distance. */
export const CLASH_LUMA_THRESHOLD = 40;

export function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff";
  return (
    <div className="kd-color-row">
      <span className="kd-color-label">{label}</span>
      <input
        type="color"
        className="kd-color-input"
        value={safe}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <code className="kd-color-hex">{value}</code>
      <div className="kd-swatches">
        {PRESET_SWATCHES.map((s) => (
          <button
            key={s.hex}
            type="button"
            className={`kd-swatch${value.toLowerCase() === s.hex ? " active" : ""}`}
            style={{ background: s.hex }}
            title={s.label}
            aria-label={`${label}: ${s.label}`}
            onClick={() => onChange(s.hex)}
          >
            {value.toLowerCase() === s.hex && <Check size={11} color={getContrast(s.hex)} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function getContrast(hex: string): string {
  const body = hex.replace("#", "");
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "#111111" : "#ffffff";
}

export interface KitDesignerProps {
  value: ClubKits;
  onChange: (next: ClubKits) => void;
}

export function KitDesigner({ value, onChange }: KitDesignerProps) {
  const [slot, setSlot] = useState<KitSlot>("home");
  const kit = value[slot];

  const patchSlot = (patch: Partial<KitDesign>) => {
    onChange({ ...value, [slot]: { ...kit, ...patch } });
  };

  const clash =
    slot !== "gk" &&
    lumaDistance(value.home.primary, value.away.primary) < CLASH_LUMA_THRESHOLD;

  return (
    <div className="kd-root">
      {/* Slot tabs */}
      <div className="kd-slots" role="tablist" aria-label="Kit slot">
        {KIT_SLOTS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={slot === s}
            className={`kd-slot${slot === s ? " active" : ""}`}
            onClick={() => setSlot(s)}
          >
            {SLOT_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="kd-body">
        {/* Live preview of the active slot (number is preview-only) */}
        <div className="kd-preview">
          <FootballKit {...kit} number={PREVIEW_NUMBERS[slot]} size="100%" />
          <div className="kd-preview-caption">{SLOT_LABELS[slot]} kit</div>
        </div>

        <div className="kd-controls">
          {/* Pattern grid */}
          <div className="kd-field">
            <label className="jm-label">Pattern</label>
            <div className="kd-pattern-grid">
              {KIT_PATTERNS.map((p) => {
                const active = kit.pattern === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`kd-pattern${active ? " active" : ""}`}
                    title={p.label}
                    aria-pressed={active}
                    aria-label={`Pattern ${p.label}`}
                    onClick={() => patchSlot({ pattern: p.id })}
                  >
                    <FootballKit {...kit} pattern={p.id} flat size="100%" />
                    <span className="kd-pattern-name">{active ? p.label : ""}</span>
                  </button>
                );
              })}
            </div>
            <div className="kd-active-pattern">{KIT_PATTERNS.find((p) => p.id === kit.pattern)?.label ?? "Solid"}</div>
          </div>

          {/* Palette */}
          <ColorRow label="Primary shell" value={kit.primary} onChange={(hex) => patchSlot({ primary: hex })} />
          <ColorRow label="Secondary detail" value={kit.secondary} onChange={(hex) => patchSlot({ secondary: hex })} />
          <ColorRow label="Accent / trim" value={kit.accent} onChange={(hex) => patchSlot({ accent: hex })} />
          <ColorRow label="Number color" value={kit.numberColor} onChange={(hex) => patchSlot({ numberColor: hex })} />

          {clash && (
            <div className="jm-warn kd-clash">
              <AlertTriangle size={13} /> Home and away shells look very similar — consider a lighter/darker away kit.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
