import type { en } from "./en";

/** Widen English literals while preserving the exact nested key structure. */
type Widen<T> = { -readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

// Keep the resource shape identical across locales. CLDR has a `many` plural
// form for French and Portuguese, but game counts never reach its 10^6 range;
// using the English one/other key set keeps all three bundles interchangeable.
export type LocaleShape = Widen<typeof en>;
