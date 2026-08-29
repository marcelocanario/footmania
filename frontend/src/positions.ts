/**
 * Frontend presentation for the nine natural positions (§16.1).
 *
 * This module owns CSS classes and display order ONLY. Full names come from
 * each API view's `positionName`; semantic role/group data comes from the API.
 * There is no numeric position anywhere in the API any more, so there is no
 * numeric fallback here either — an unexpected value is surfaced, not guessed.
 */
export const NATURAL_POSITIONS = ["GK", "LB", "RB", "CB", "DM", "AM", "LW", "RW", "ST"] as const;
export type NaturalPosition = (typeof NATURAL_POSITIONS)[number];

/** Display order (§16.1), and the sort key derived from it. */
export const DISPLAY_ORDER: readonly NaturalPosition[] = NATURAL_POSITIONS;

export const POSITION_ORDER: Record<NaturalPosition, number> = Object.fromEntries(
  DISPLAY_ORDER.map((pos, index) => [pos, index]),
) as Record<NaturalPosition, number>;

/**
 * One distinct class per position (§16.1). Mirrored pairs share a colour but
 * not a class, so LB and RB can be styled apart later without touching every
 * call site.
 */
export const POSITION_CLASS: Record<NaturalPosition, string> = {
  GK: "pos-GK",
  LB: "pos-LB",
  RB: "pos-RB",
  CB: "pos-CB",
  DM: "pos-DM",
  AM: "pos-AM",
  LW: "pos-LW",
  RW: "pos-RW",
  ST: "pos-ST",
};

export const POSITION_LETTER: Record<NaturalPosition, string> = Object.fromEntries(
  NATURAL_POSITIONS.map((pos) => [pos, pos]),
) as Record<NaturalPosition, string>;

function isNaturalPosition(value: unknown): value is NaturalPosition {
  return typeof value === "string" && value in POSITION_CLASS;
}

export function positionClass(pos: NaturalPosition | string | undefined): string {
  if (isNaturalPosition(pos)) return POSITION_CLASS[pos];
  // Unknown position (corrupt data / future code): surface it rather than
  // silently masquerading as another role; CSS falls back to default styling.
  if (pos !== undefined) console.warn(`[positions] unknown position value for class: ${String(pos)}`);
  return "pos-unknown";
}

export function positionLetter(pos: NaturalPosition | string | undefined): string {
  if (isNaturalPosition(pos)) return POSITION_LETTER[pos];
  if (pos !== undefined) console.warn(`[positions] unknown position value for letter: ${String(pos)}`);
  return "?";
}
