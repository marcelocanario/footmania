/**
 * Color helpers for the kit renderer, ported from the studied Kit Lab
 * generator (league-builder.app/kit-lab). Pure functions over hex strings.
 */

/** Normalize any hex-ish input to a 6-digit lowercase hex body (no "#"). */
function normalizeHex(color: string | undefined | null): string {
  if (!color || typeof color !== "string") return "ffffff";
  let hex = color.replace(/^#/, "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return hex.toLowerCase();
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function toHexPair(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/** Darken a hex color by `factor` (0..1). Returns a "#rrggbb" string. */
export function darkenColor(color: string, factor: number): string {
  if (!color || color.startsWith("var(") || color.startsWith("rgba(") || color === "transparent") return color;
  const hex = normalizeHex(color);
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return color;
  return `#${toHexPair(clampByte(r * (1 - factor)))}${toHexPair(clampByte(g * (1 - factor)))}${toHexPair(clampByte(b * (1 - factor)))}`;
}

/** Lighten a hex color toward white by `factor` (0..1). */
export function lightenColor(color: string, factor: number): string {
  if (!color || color.startsWith("var(") || color.startsWith("rgba(") || color === "transparent") return color;
  const hex = normalizeHex(color);
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return color;
  return `#${toHexPair(clampByte(r + (255 - r) * factor))}${toHexPair(clampByte(g + (255 - g) * factor))}${toHexPair(clampByte(b + (255 - b) * factor))}`;
}

/** Perceptual luminance 0..255 (Rec. 601 luma coefficients). */
export function getLuma(color: string): number {
  if (!color || typeof color !== "string") return 128;
  const hex = normalizeHex(color);
  if (hex.length !== 6) return 128;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 128;
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** Accept bare hex bodies and prefix "#" where needed; otherwise pass through. */
export function formatColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color === "transparent" || color.startsWith("var(") || color.startsWith("rgba(") || color.startsWith("rgb(") || color.startsWith("hsl(") || color.startsWith("#")) {
    return color;
  }
  return `#${color}`;
}

/** Absolute luminance distance between two colors (0..255). */
export function lumaDistance(a: string, b: string): number {
  return Math.abs(getLuma(a) - getLuma(b));
}
