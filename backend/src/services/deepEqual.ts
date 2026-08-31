/**
 * Structural equality for plain JSON-shaped data (numbers, strings, booleans,
 * null, arrays, plain objects — never Map/Set/Date/class instances). Every
 * field of `World` and its nested types is exactly this shape, since the
 * whole tree round-trips through `JSON.stringify`/`structuredClone` and JSON
 * database columns elsewhere in the codebase.
 *
 * This exists to replace `JSON.stringify(a) !== JSON.stringify(b)` change
 * checks, which pay to fully serialize both sides — allocating a string for
 * every field of every record — before a single byte is compared. This
 * short-circuits at the first difference instead, and a reference-equal
 * input (common once a caller has structurally shared an untouched
 * collection between two `World` snapshots) costs nothing at all.
 *
 * Two deliberate, harmless differences from stringify-then-compare:
 *  - Object key ORDER never affects the result (stringify's would, since it
 *    serializes keys in insertion order). This codebase only ever
 *    reconstructs a "same" object with a different key order in a way that
 *    preserves every field's VALUE, so this can only make two equal-valued
 *    objects compare as equal when stringify would have called them
 *    different — never the reverse. A skipped table sync in that narrow case
 *    is a no-op: the row that would have been written already matches the
 *    database, because the row is built by reading named fields, never by
 *    walking key order.
 *  - `NaN` compares equal only to `NaN`, and unequal to `null`, whereas
 *    `JSON.stringify` collapses BOTH `NaN` and `null` to the text "null" and
 *    so (buggily) treats them as equal. No field in this data model is
 *    expected to hold `NaN`.
 *  - An explicit `undefined` property is distinguished from an absent one
 *    (`JSON.stringify` drops `undefined`-valued keys entirely, so `{ x:
 *    undefined }` and `{}` stringify identically). Treating them as different
 *    is strictly MORE conservative than stringify's behavior — the only way
 *    this can diverge from stringify-equality is by reporting a difference
 *    stringify would have missed, never the other way around.
 *
 * In short: wherever this returns `true`, `JSON.stringify` would also have
 * called the two equal for every value this data model can actually hold.
 * Wherever the two disagree, this function is the more conservative one, so
 * swapping it in can only add a harmless redundant table sync — never skip a
 * real, meaningful change.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  if (aKeys.length !== Object.keys(bRec).length) return false;
  for (const key of aKeys) {
    if (!(key in bRec) || !deepEqual(aRec[key], bRec[key])) return false;
  }
  return true;
}
