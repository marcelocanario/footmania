import type { RngState } from "./rng";
import { nextInt } from "./rng";

/**
 * Name-pool catalog for player/coach name generation.
 *
 * The pools are global reference data persisted in the `NamePoolEntry` table
 * (seeded from backend/assets/namepools.json) and loaded once into memory at
 * startup by `loadNamePoolsFromDb` (services/namePoolService.ts). The loader
 * mutates this module's catalog directly so the synchronous engine code keeps
 * working without plumbing a context through every generator.
 *
 * Countries with no rows fall back to a small generic pool so any country can
 * still generate names.
 */

const nameCache: Record<string, string[]> = {};
const poolSource: Record<string, "db" | "fallback"> = {};

const FALLBACK_NAMES = ["Alex", "João", "Marco", "Luca", "James", "Ken", "Ivan", "Diego", "Omar", "Yuki"];
const FALLBACK_SURNAMES = ["Silva", "Rossi", "Smith", "Khan", "Sato", "Nakamura", "Ferreira", "Muller", "Garcia", "Kim"];

function pool(kind: "names" | "surnames", country: string): string[] {
  const key = `${kind}:${country}`;
  if (nameCache[key]) return nameCache[key];
  const fallback = kind === "names" ? [...FALLBACK_NAMES] : [...FALLBACK_SURNAMES];
  nameCache[key] = fallback;
  poolSource[key] = "fallback";
  return nameCache[key];
}

/** Register a country+kind pool (file order preserved, duplicates kept). Empty pools keep the generic fallback. */
export function registerNamePool(kind: "names" | "surnames", country: string, values: string[]): void {
  const key = `${kind}:${country}`;
  if (values.length > 0) {
    nameCache[key] = values;
    poolSource[key] = "db";
  } else {
    delete nameCache[key];
    poolSource[key] = "fallback";
  }
}

/** True when the country has a non-fallback first-name pool. */
export function hasNamePool(country: string): boolean {
  const key = `names:${country}`;
  return Boolean(nameCache[key]) && poolSource[key] === "db";
}

export function generateName(rng: RngState, country: string): string {
  const names = pool("names", country);
  const surnames = pool("surnames", country);
  let idx = nextInt(rng, names.length);
  if (idx === 0) idx = 1;
  let name = names[idx];
  const words = name.split(/\s+/).length;
  let addSurname = false;
  if (words === 1) {
    addSurname = true;
  } else if (words === 2) {
    addSurname = nextInt(rng, 2) === 0;
  }
  if (addSurname && surnames.length > 2) {
    let sIdx = nextInt(rng, surnames.length);
    if (sIdx === 0) sIdx = 1;
    const surname = surnames[sIdx];
    if (name.length <= 12 && surname.length <= 6 && surname !== name) {
      name = `${name} ${surname}`;
    }
  }
  return name;
}
