/**
 * Shared tactic option lists for dropdowns. Labels mirror
 * backend/src/game/constants.ts (FORMATION_NAMES / STYLE_NAMES /
 * PRESSING_NAMES / DIRECTION_NAMES); keep them in sync when tactics change.
 */
export interface TacticOption {
  label: string;
  value: number;
  /** Short one-line explanation shown under the label in dropdown menus. */
  desc?: string;
}

export const FORMATIONS: TacticOption[] = [
  { label: "5-4-1", value: 0 },
  { label: "5-4-1 · Wide", value: 1 },
  { label: "5-3-2", value: 2 },
  { label: "4-5-1", value: 3 },
  { label: "4-4-2", value: 4 },
  { label: "4-4-2 · Diamond", value: 5 },
  { label: "4-4-2 · Attacking", value: 6 },
  { label: "4-3-3", value: 7 },
  { label: "4-3-3 · Holding", value: 8 },
  { label: "3-5-2", value: 9 },
  { label: "3-4-3", value: 10 },
  { label: "4-2-3-1", value: 11 },
  { label: "4-2-3-1 · Wide", value: 12 },
];

export const STYLES: TacticOption[] = [
  { label: "Balanced", value: 0, desc: "No strong lean either way: safe, lower-risk actions with balanced execution." },
  { label: "Offensive", value: 1, desc: "Press and attack aggressively — more pressure on the opponent, at the cost of more risk." },
  { label: "Counter-attack", value: 2, desc: "Sit back and strike quickly when transitioning from defense to attack." },
];

export const PRESSING: TacticOption[] = [
  { label: "Light", value: 0, desc: "Minimal pressing. Conserves energy and reduces foul risk." },
  { label: "Balanced", value: 1, desc: "Moderate pressing: a middle ground between pressure and fatigue." },
  { label: "Heavy", value: 2, desc: "Maximum press intensity. Forces more mistakes, but tires players faster and risks more fouls." },
];

export const DIRECTIONS: TacticOption[] = [
  { label: "Through the middle", value: 0, desc: "Focus attacks through the center of the pitch." },
  { label: "Down the wings", value: 1, desc: "Focus attacks down the flanks, stretching the opponent's shape." },
];

export function formationLabel(value: number): string {
  return FORMATIONS.find((f) => f.value === value)?.label ?? `Formation ${value}`;
}

/** Option meaning "leave this tactic aspect unchanged" in automation rules. */
const UNCHANGED = { label: "(unchanged)", value: null } as const;

export type UnchangedOption = typeof UNCHANGED;

/** Prepends the "(unchanged)" option used by automation tactic dropdowns; selecting it omits the field from the rule. */
export function withUnchanged(options: TacticOption[]): [UnchangedOption, ...TacticOption[]] {
  return [UNCHANGED, ...options];
}
