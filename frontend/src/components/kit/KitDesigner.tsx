import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";
import { FootballKit } from "./FootballKit";
import { KIT_PATTERNS } from "./patterns";
import { lumaDistance } from "./colors";
import { KIT_SLOTS, PREVIEW_NUMBERS, type ClubKits, type KitDesign, type KitSlot } from "./types";

/**
 * Reusable kit editor: slot tabs + pattern grid + palette rows. Fully
 * controlled (`value`/`onChange`) and persistence-free so it can be embedded
 * in the creation wizard and the My Club page alike; the host owns saving.
 * Squad numbers are preview-only (9 outfield / 1 goalkeeper) and never saved.
 */

/** Preset swatch labels are i18n keys resolved by ColorRow at render time. */
const PRESET_SWATCHES: { label: string; hex: string }[] = [
  { label: "kit.colors.white", hex: "#ffffff" },
  { label: "kit.colors.black", hex: "#111111" },
  { label: "kit.colors.red", hex: "#d40000" },
  { label: "kit.colors.blue", hex: "#003399" },
  { label: "kit.colors.yellow", hex: "#ffdd00" },
  { label: "kit.colors.green", hex: "#008000" },
  { label: "kit.colors.sky", hex: "#87ceeb" },
  { label: "kit.colors.maroon", hex: "#800000" },
  { label: "kit.colors.navy", hex: "#000080" },
  { label: "kit.colors.orange", hex: "#ff8c00" },
  { label: "kit.colors.purple", hex: "#660099" },
  { label: "kit.colors.pink", hex: "#ff69b4" },
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
  const { t } = useTranslation();
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
            title={(t as unknown as (k: string) => string)(s.label)}
            aria-label={t("kit.swatchAria", { label, color: (t as unknown as (k: string) => string)(s.label) })}
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
  const { t } = useTranslation();
  const tt = t as unknown as (k: string) => string;
  const slotKey = (s: KitSlot) => s.charAt(0).toUpperCase() + s.slice(1);
  const [slot, setSlot] = useState<KitSlot>("home");
  const kit = value[slot];

  const patchSlot = (patch: Partial<KitDesign>) => {
    onChange({ ...value, [slot]: { ...kit, ...patch } });
  };

  const patternLabel = (id: string) => tt(`kit.patterns.${id}`);

  const clash =
    slot !== "gk" &&
    lumaDistance(value.home.primary, value.away.primary) < CLASH_LUMA_THRESHOLD;

  return (
    <div className="kd-root">
      {/* Slot tabs */}
      <div className="kd-slots" role="tablist" aria-label={t("kit.kitSlotAria")}>
        {KIT_SLOTS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={slot === s}
            className={`kd-slot${slot === s ? " active" : ""}`}
            onClick={() => setSlot(s)}
          >
            {tt(`kit.slot${slotKey(s)}`)}
          </button>
        ))}
      </div>

      <div className="kd-body">
        {/* Live preview of the active slot (number is preview-only) */}
        <div className="kd-preview">
          <FootballKit {...kit} number={PREVIEW_NUMBERS[slot]} size="100%" />
          <div className="kd-preview-caption">{t("kit.kitCaption", { slot: tt(`kit.slot${slotKey(slot)}`) })}</div>
        </div>

        <div className="kd-controls">
          {/* Pattern grid */}
          <div className="kd-field">
            <label className="jm-label">{t("kit.pattern")}</label>
            <div className="kd-pattern-grid">
              {KIT_PATTERNS.map((p) => {
                const active = kit.pattern === p.id;
                const label = patternLabel(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`kd-pattern${active ? " active" : ""}`}
                    title={label}
                    aria-pressed={active}
                    aria-label={t("kit.patternAria", { label })}
                    onClick={() => patchSlot({ pattern: p.id })}
                  >
                    <FootballKit {...kit} pattern={p.id} flat size="100%" />
                    <span className="kd-pattern-name">{active ? label : ""}</span>
                  </button>
                );
              })}
            </div>
            <div className="kd-active-pattern">{patternLabel(kit.pattern)}</div>
          </div>

          {/* Palette */}
          <ColorRow label={t("kit.primaryShell")} value={kit.primary} onChange={(hex) => patchSlot({ primary: hex })} />
          <ColorRow label={t("kit.secondaryDetail")} value={kit.secondary} onChange={(hex) => patchSlot({ secondary: hex })} />
          <ColorRow label={t("kit.accentTrim")} value={kit.accent} onChange={(hex) => patchSlot({ accent: hex })} />
          <ColorRow label={t("kit.numberColor")} value={kit.numberColor} onChange={(hex) => patchSlot({ numberColor: hex })} />

          {clash && (
            <div className="jm-warn kd-clash">
              <AlertTriangle size={13} /> {t("kit.clash")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
