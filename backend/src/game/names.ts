import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RngState } from "./rng";
import { nextInt } from "./rng";

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, "..", "..", "assets");

const nameCache: Record<string, string[]> = {};

function loadPool(kind: "names" | "surnames", country: string): string[] {
  const key = `${kind}:${country}`;
  if (nameCache[key]) return nameCache[key];
  try {
    const file = join(ASSETS, "namepools", kind, `${country}.txt`);
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes(".") && !/\d/.test(l));
    nameCache[key] = lines;
  } catch {
    nameCache[key] = [];
  }
  return nameCache[key];
}

export function hasNamePool(country: string): boolean {
  return loadPool("names", country).length > 0;
}

export function generateName(rng: RngState, country: string): string {
  const names = loadPool("names", country);
  const surnames = loadPool("surnames", country);
  if (names.length === 0) return "Player " + nextInt(rng, 999);
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
