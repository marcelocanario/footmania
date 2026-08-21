import type { KitDesign, ClubKits } from "./types";
import { darkenColor, getLuma, lightenColor } from "./colors";

/**
 * Smart kit defaults derived from a club's two identity colors. Used by the
 * creation wizard (pre-fill Away/GK so users can click through untouched) and
 * by the backend fallback when no explicit kit data exists.
 */

// --- Minimal HSL conversions (self-contained; no external deps) ------------

function hexToHsl(hex: string): [number, number, number] {
  const body = hex.replace(/^#/, "").padEnd(6, "0").slice(0, 6);
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const hue = (v: number) => {
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    return v;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tv = hue(t);
    if (tv < 1 / 6) return p + (q - p) * 6 * tv;
    if (tv < 1 / 2) return q;
    if (tv < 2 / 3) return p + (q - p) * (2 / 3 - tv) * 6;
    return p;
  };
  const byte = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${byte(channel(h + 1 / 3))}${byte(channel(h))}${byte(channel(h - 1 / 3))}`;
}

/** Contrast pick: near-black on light surfaces, near-white on dark ones. */
export function contrastInk(surface: string): string {
  return getLuma(surface) > 140 ? "#111111" : "#ffffff";
}

/** Complementary hue with sane saturation/lightness for goalkeeper kits. */
function contrastingShade(hex: string): string {
  const [h, , l] = hexToHsl(hex);
  return hslToHex((h + 0.5) % 1, 0.75, Math.min(0.82, Math.max(0.22, 1 - l)));
}

/** Derive a full three-kit set from just the club's two identity colors. */
export function deriveKitDefaults(primary: string, secondary: string): ClubKits {
  // Away takes the same two colors shifted toward whichever extreme the home
  // shell is NOT in (light home -> dark away, dark home -> light away).
  const lightHome = getLuma(primary) >= 128;
  const awayPrimary = lightHome ? darkenColor(primary, 0.45) : lightenColor(primary, 0.55);

  const home: KitDesign = {
    primary,
    secondary,
    accent: contrastInk(secondary),
    numberColor: contrastInk(primary),
    pattern: "stripes",
  };
  const away: KitDesign = {
    primary: awayPrimary,
    secondary,
    accent: contrastInk(awayPrimary),
    numberColor: contrastInk(awayPrimary),
    pattern: "solid",
  };
  const gk: KitDesign = {
    primary: contrastingShade(primary),
    secondary: contrastInk(contrastingShade(primary)),
    accent: contrastInk(secondary),
    numberColor: "#111111",
    pattern: "hoops",
  };
  return { home, away, gk };
}

/**
 * Re-seed all three kits from the club's two identity colors while keeping
 * the user's chosen patterns. Home wears primary/secondary with the secondary
 * as trim; away reverses the order; GK takes a fresh contrasting shade.
 * Used by the creation wizard as an initial preset — every kit stays freely
 * editable afterwards.
 */
export function applyTeamColorPreset(current: ClubKits, primary: string, secondary: string): ClubKits {
  return {
    home: {
      primary,
      secondary,
      accent: secondary,
      numberColor: contrastInk(primary),
      pattern: current.home.pattern,
    },
    away: {
      primary: secondary,
      secondary: primary,
      accent: primary,
      numberColor: contrastInk(secondary),
      pattern: current.away.pattern,
    },
    gk: deriveKitDefaults(primary, secondary).gk,
  };
}
