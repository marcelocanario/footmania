import i18n from "i18next";

const CONDITION_KEYS = new Set(["injured", "needsRest", "tired", "heavyLoad", "fresh", "normal"]);

/** Localize a condition key (from the server's `conditionLabel`) to display
 *  text; unknown/legacy values pass through untranslated. */
export function conditionLabel(key: string | null | undefined): string {
  const k = key ?? "normal";
  return CONDITION_KEYS.has(k) ? (i18n.t as (k: string) => string)(`condition.${k}`) : (key ?? "");
}