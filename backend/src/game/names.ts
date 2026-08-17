import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RngState } from "./rng";
import { nextInt } from "./rng";

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(here, "..", "..", "assets");

const nameCache: Record<string, string[]> = {};
const poolSource: Record<string, "file" | "fallback"> = {};

const FALLBACK_NAMES = ["Alex", "João", "Marco", "Luca", "James", "Ken", "Ivan", "Diego", "Omar", "Yuki"];
const FALLBACK_SURNAMES = ["Silva", "Rossi", "Smith", "Khan", "Sato", "Nakamura", "Ferreira", "Muller", "Garcia", "Kim"];

function loadPool(kind: "names" | "surnames", country: string): string[] {
  const key = `${kind}:${country}`;
  if (nameCache[key]) return nameCache[key];
  let lines: string[] = [];
  try {
    const file = join(ASSETS, "namepools", kind, `${country}.txt`);
    lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes(".") && !/\d/.test(l));
  } catch {
    lines = [];
  }
  // Sparse/empty pools fall back to a small generic pool so every country can
  // still generate names.
  if (lines.length === 0) {
    lines = kind === "names" ? [...FALLBACK_NAMES] : [...FALLBACK_SURNAMES];
    poolSource[key] = "fallback";
  } else {
    poolSource[key] = "file";
  }
  nameCache[key] = lines;
  return nameCache[key];
}

export function hasNamePool(country: string): boolean {
  loadPool("names", country);
  return poolSource[`names:${country}`] === "file";
}

export function generateName(rng: RngState, country: string): string {
  const names = loadPool("names", country);
  const surnames = loadPool("surnames", country);
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
