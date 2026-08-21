/** A single jersey design: shell/detail colors, trim and pattern. */
export interface KitDesign {
  primary: string;
  secondary: string;
  accent: string;
  numberColor: string;
  pattern: string;
}

/** Preview-only squad numbers per slot; never persisted with the design. */
export const PREVIEW_NUMBERS: Record<KitSlot, number> = {
  home: 9,
  away: 9,
  gk: 1,
};

/** The three kits a club owns. */
export interface ClubKits {
  home: KitDesign;
  away: KitDesign;
  gk: KitDesign;
}

export type KitSlot = keyof ClubKits;

export const KIT_SLOTS: KitSlot[] = ["home", "away", "gk"];

export const SLOT_LABELS: Record<KitSlot, string> = {
  home: "Home",
  away: "Away",
  gk: "Goalkeeper",
};
