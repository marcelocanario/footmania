/**
 * Shared tactic option lists for dropdowns. Style/pressing/direction labels
 * mirror backend/src/game/constants.ts; keep them in sync when tactics change.
 *
 * Formations are NOT listed here: the backend catalog owns formation ids,
 * names and geometry (§15.3/§16.1). Consume `snapshot.formationOptions`,
 * `LineupView.slots` or the live view's formation slots.
 */
export interface TacticOption {
  label: string;
  value: number;
  /** Short one-line explanation shown under the label in dropdown menus. */
  desc?: string;
}

/**
 * §16.1: the backend formation catalog is the ONLY formation authority. The
 * snapshot supplies `formationOptions`; before it loads there is nothing to
 * show, and an empty list is the honest answer — a local fallback table would
 * silently disagree with the server's geometry.
 */
export function formationsFromSnapshot(options?: Array<{ id: number; name: string }>): TacticOption[] {
  return (options ?? []).map((o) => ({ label: o.name, value: o.id }));
}

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

/** Formation label from the snapshot catalog; the id itself is the fallback. */
export function formationLabelFromOptions(value: number, options?: Array<{ id: number; name: string }>): string {
  return options?.find((o) => o.id === value)?.name ?? `Formation ${value}`;
}

/** Option meaning "leave this tactic aspect unchanged" in automation rules. */
const UNCHANGED = { label: "(unchanged)", value: null } as const;

export type UnchangedOption = typeof UNCHANGED;

/** Prepends the "(unchanged)" option used by automation tactic dropdowns; selecting it omits the field from the rule. */
export function withUnchanged(options: TacticOption[]): [UnchangedOption, ...TacticOption[]] {
  return [UNCHANGED, ...options];
}
