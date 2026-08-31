/**
 * Shared tactic option lists for dropdowns. Style/pressing/direction labels
 * mirror backend/src/game/constants.ts; keep them in sync when tactics change.
 *
 * Formations are NOT listed here: the backend catalog owns formation ids,
 * names and geometry (§15.3/§16.1). Consume `snapshot.formationOptions`,
 * `LineupView.slots` or the live view's formation slots.
 */
import i18n from "i18next";

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

export function styleOptions(): TacticOption[] {
  return [
    { label: i18n.t("tactics.styles.balanced"), value: 0, desc: i18n.t("tactics.styles.balancedDesc") },
    { label: i18n.t("tactics.styles.offensive"), value: 1, desc: i18n.t("tactics.styles.offensiveDesc") },
    { label: i18n.t("tactics.styles.counter"), value: 2, desc: i18n.t("tactics.styles.counterDesc") },
  ];
}

export function pressingOptions(): TacticOption[] {
  return [
    { label: i18n.t("tactics.pressing.light"), value: 0, desc: i18n.t("tactics.pressing.lightDesc") },
    { label: i18n.t("tactics.pressing.balanced"), value: 1, desc: i18n.t("tactics.pressing.balancedDesc") },
    { label: i18n.t("tactics.pressing.heavy"), value: 2, desc: i18n.t("tactics.pressing.heavyDesc") },
  ];
}

export function directionOptions(): TacticOption[] {
  return [
    { label: i18n.t("tactics.directions.middle"), value: 0, desc: i18n.t("tactics.directions.middleDesc") },
    { label: i18n.t("tactics.directions.wings"), value: 1, desc: i18n.t("tactics.directions.wingsDesc") },
  ];
}

/** Formation label from the snapshot catalog; the id itself is the fallback. */
export function formationLabelFromOptions(value: number, options?: Array<{ id: number; name: string }>): string {
  return options?.find((o) => o.id === value)?.name ?? i18n.t("tactics.formationFallback", { id: value });
}

/** Option meaning "leave this tactic aspect unchanged" in automation rules. */
export type UnchangedOption = { label: string; value: null };

/** Prepends the "(unchanged)" option used by automation tactic dropdowns; selecting it omits the field from the rule. */
export function withUnchanged(options: TacticOption[]): [UnchangedOption, ...TacticOption[]] {
  return [{ label: i18n.t("tactics.unchanged"), value: null }, ...options];
}
