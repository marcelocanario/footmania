import { z } from "zod";
import { KIT_CONFIG } from "../config";
import { chance, createRng, nextInt, pick } from "./rng";

/**
 * Kit-design domain (Kit Lab clone). Clubs own three jersey designs
 * (home/away/GK). Designs are stored on the club as a parsed `kits` object;
 * persistence serializes it to the Club.kitJson column. When no explicit
 * designs exist (legacy humans, AI clubs), kits are derived deterministically
 * from the club's two identity colors — AI from a seeded palette draw per
 * plan: "two main colors, then light and dark variants randomly assigned to
 * home/away" — so a restart never rerolls a club's look.
 */

export interface KitDesign {
  primary: string;
  secondary: string;
  accent: string;
  numberColor: string;
  pattern: string;
}

export interface ClubKits {
  home: KitDesign;
  away: KitDesign;
  gk: KitDesign;
}

const PATTERN_ID_SET = new Set<string>(KIT_CONFIG.patternIds);

// --- Validation -------------------------------------------------------------

export const hexColorSchema = z.string().regex(KIT_CONFIG.hexPattern);

// `.strict()` rejects unknown keys outright — squad numbers and other
// render-time-only fields can never leak into stored designs.
export const kitDesignSchema = z
  .object({
    primary: hexColorSchema,
    secondary: hexColorSchema,
    accent: hexColorSchema,
    numberColor: hexColorSchema,
    pattern: z.string().refine((id) => PATTERN_ID_SET.has(id), "Unknown pattern"),
  })
  .strict();

export const clubKitsSchema = z.object({
  home: kitDesignSchema,
  away: kitDesignSchema,
  gk: kitDesignSchema,
});

/** Validate an untrusted kits payload; returns null when invalid. */
export function parseClubKits(value: unknown): ClubKits | null {
  const parsed = clubKitsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// --- Persistence helpers ----------------------------------------------------

export function serializeClubKits(kits: ClubKits | null | undefined): string | null {
  return kits ? JSON.stringify(kits) : null;
}

/** Parse the stored JSON column; corrupt or legacy-null data yields null. */
export function deserializeClubKits(json: string | null | undefined): ClubKits | null {
  if (!json) return null;
  try {
    return parseClubKits(JSON.parse(json));
  } catch {
    return null;
  }
}

// --- Color math (duplicated intentionally: backend has no access to the
// frontend kit module; keep in sync with frontend components/kit) ------------

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function darkenHex(hex: string, factor: number): string {
  const body = hex.replace(/^#/, "");
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  const pair = (v: number) => clampByte(v).toString(16).padStart(2, "0");
  return `#${pair(r * (1 - factor))}${pair(g * (1 - factor))}${pair(b * (1 - factor))}`;
}

function lightenHex(hex: string, factor: number): string {
  const body = hex.replace(/^#/, "");
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  const pair = (v: number) => clampByte(v + (255 - v) * factor).toString(16).padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/** Repeatedly lighten until the perceptual luma target is met (bounded). */
function lightenUntil(hex: string): string {
  let color = hex;
  for (let step = 0; step < KIT_CONFIG.aiShadeMaxSteps && getLuma(color) < KIT_CONFIG.aiLightLumaTarget; step++) {
    color = lightenHex(color, KIT_CONFIG.lightenFactor);
  }
  return color;
}

/** Repeatedly darken until the perceptual luma target is met (bounded). */
function darkenUntil(hex: string): string {
  let color = hex;
  for (let step = 0; step < KIT_CONFIG.aiShadeMaxSteps && getLuma(color) > KIT_CONFIG.aiDarkLumaTarget; step++) {
    color = darkenHex(color, KIT_CONFIG.darkenFactor);
  }
  return color;
}

function getLuma(hex: string): number {
  const body = hex.replace(/^#/, "");
  if (body.length !== 6) return 128;
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 128;
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function contrastInk(surface: string): string {
  return getLuma(surface) > 140 ? "#111111" : "#ffffff";
}

function contrastingShade(hex: string): string {
  const body = hex.replace(/^#/, "");
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const nl = Math.min(KIT_CONFIG.gkLightnessMax, Math.max(KIT_CONFIG.gkLightnessMin, 1 - l));
  const s = KIT_CONFIG.gkSaturation;
  const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s;
  const p = 2 * nl - q;
  const channel = (t: number) => {
    let tv = t;
    if (tv < 0) tv += 1;
    if (tv > 1) tv -= 1;
    if (tv < 1 / 6) return p + (q - p) * 6 * tv;
    if (tv < 1 / 2) return q;
    if (tv < 2 / 3) return p + (q - p) * (2 / 3 - tv) * 6;
    return p;
  };
  const byte = (v: number) => clampByte(v * 255).toString(16).padStart(2, "0");
  return `#${byte(channel(h + 1 / 3))}${byte(channel(h))}${byte(channel(h - 1 / 3))}`;
}

// --- Derivation --------------------------------------------------------------

/**
 * Deterministic three-kit set for a given seed (club id). Two base colors are
 * drawn from the palette; one becomes a light kit, the other a dark kit; a
 * seeded coin assigns home vs away; GK takes a complementary shade.
 */
export function deriveAiKits(clubId: number): ClubKits {
  const rng = createRng((0x9e3779b9 ^ Math.imul(clubId + 1, 0x85ebca6b)) >>> 0);
  const first = nextInt(rng, KIT_CONFIG.aiPalette.length);
  let second = nextInt(rng, KIT_CONFIG.aiPalette.length - 1);
  if (second >= first) second += 1;
  const colorA = KIT_CONFIG.aiPalette[first];
  const colorB = KIT_CONFIG.aiPalette[second];

  const pattern = pick(rng, [...KIT_CONFIG.aiPatterns]);
  const lightIsHome = chance(rng, 50);

  const lightKit: KitDesign = {
    primary: lightenUntil(colorA),
    secondary: colorB,
    accent: contrastInk(colorB),
    numberColor: "#111111",
    pattern,
  };
  const darkKit: KitDesign = {
    primary: darkenUntil(colorB),
    secondary: colorA,
    accent: contrastInk(colorA),
    numberColor: "#ffffff",
    pattern,
  };
  const home = lightIsHome ? lightKit : darkKit;
  const away = lightIsHome ? darkKit : lightKit;

  const gkPrimary = contrastingShade(home.primary);
  const gk: KitDesign = {
    primary: gkPrimary,
    secondary: contrastInk(gkPrimary),
    accent: contrastInk(home.secondary),
    numberColor: contrastInk(gkPrimary),
    pattern: "hoops",
  };

  return { home, away, gk };
}

/**
 * Legacy fallback: build a full kit set from just the two identity colors.
 * Used for human clubs created before kits existed and as the read-time
 * default whenever `club.kits` is unset.
 */
export function deriveFallbackKits(primaryColor: string, secondaryColor: string): ClubKits {
  const lightHome = getLuma(primaryColor) >= 128;
  const awayPrimary = lightHome ? darkenHex(primaryColor, 0.45) : lightenHex(primaryColor, 0.55);

  const home: KitDesign = {
    primary: primaryColor,
    secondary: secondaryColor,
    accent: contrastInk(secondaryColor),
    numberColor: contrastInk(primaryColor),
    pattern: "stripes",
  };
  const away: KitDesign = {
    primary: awayPrimary,
    secondary: secondaryColor,
    accent: contrastInk(awayPrimary),
    numberColor: contrastInk(awayPrimary),
    pattern: "solid",
  };
  const gkPrimary = contrastingShade(primaryColor);
  const gk: KitDesign = {
    primary: gkPrimary,
    secondary: contrastInk(gkPrimary),
    accent: contrastInk(secondaryColor),
    numberColor: contrastInk(gkPrimary),
    pattern: "hoops",
  };
  return { home, away, gk };
}

/** Authoritative read path: stored designs win, otherwise derive. */
export function resolveClubKits(club: { kits?: ClubKits | null; primaryColor: string; secondaryColor: string }): ClubKits {
  return club.kits ?? deriveFallbackKits(club.primaryColor, club.secondaryColor);
}

/**
 * Automatic match-day uniform selection. Priority:
 *  1. Home team wears its home design; the away side wears whichever of its
 *     two designs contrasts best against the home shell.
 *  2. When no away-side design reaches the minimum luma distance, the home
 *     side switches to its away design and both away designs are retried.
 *  3. Still nothing? Fall back to the classic home-home / away-away pairing.
 *
 * Contrast is measured on shell (primary) luma distance; qualifying pairings
 * are compared by distance first, then light-vs-dark polarity (shells
 * straddling the split) as a tie-break, then stable candidate order — so the
 * result is a pure deterministic function of the two clubs' designs.
 */
export function selectMatchKits(home: ClubKits, away: ClubKits): { homeKit: KitDesign; awayKit: KitDesign } {
  const split = KIT_CONFIG.matchKitLightLumaSplit;
  const distance = (a: KitDesign, b: KitDesign) => Math.abs(getLuma(a.primary) - getLuma(b.primary));
  const scores = (homeShell: KitDesign, candidates: KitDesign[]) =>
    candidates.map((awayShell) => {
      const d = distance(homeShell, awayShell);
      const lumaHome = getLuma(homeShell.primary);
      const lumaAway = getLuma(awayShell.primary);
      return {
        awayKit: awayShell,
        distance: d,
        // Light-vs-dark: exactly one shell on each side of the split.
        oppositePolarity: (lumaHome >= split) !== (lumaAway >= split),
      };
    });
  const best = (homeShell: KitDesign, candidates: KitDesign[]) =>
    scores(homeShell, candidates)
      .filter((s) => s.distance >= KIT_CONFIG.matchKitMinLumaDistance)
      .sort((a, b) => b.distance - a.distance || Number(b.oppositePolarity) - Number(a.oppositePolarity))[0];

  const homeFirst = best(home.home, [away.away, away.home]);
  if (homeFirst) return { homeKit: home.home, awayKit: homeFirst.awayKit };

  const homeSwapped = best(home.away, [away.away, away.home]);
  if (homeSwapped) return { homeKit: home.away, awayKit: homeSwapped.awayKit };

  return { homeKit: home.home, awayKit: away.away };
}
