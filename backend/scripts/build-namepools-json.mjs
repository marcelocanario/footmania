#!/usr/bin/env node
/**
 * Bundles the per-country name pools into a single committed JSON artifact.
 *
 * Reads backend/assets/namepools/{names,surnames}/*.txt (the parsed Brasfoot
 * pools, in file order) and writes backend/assets/namepools.json with shape:
 *
 *   {
 *     "generatedBy": "backend/scripts/build-namepools-json.mjs",
 *     "countries": {
 *       "BRA": {
 *         "names":     ["...", "..."],   // file order preserved
 *         "surnames":  ["...", "..."]    // duplicates preserved
 *       }
 *     }
 *   }
 *
 * The txt files are the migration input for this artifact and may be deleted
 * afterwards (they are copied from the ignored Brasfoot/ source tree).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcNames = join(root, "backend", "assets", "namepools", "names");
const srcSurnames = join(root, "backend", "assets", "namepools", "surnames");
const dst = join(root, "backend", "assets", "namepools.json");

function readPool(dir) {
  const entries = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
    const code = file.slice(0, -4);
    const lines = readFileSync(join(dir, file), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes(".") && !/\d/.test(l));
    entries[code] = lines;
  }
  return entries;
}

if (!existsSync(srcNames) || !existsSync(srcSurnames)) {
  console.error("Missing namepool source dirs; run from the repo root.");
  process.exit(1);
}

const names = readPool(srcNames);
const surnames = readPool(srcSurnames);

const countries = {};
for (const code of Object.keys(names)) {
  const n = names[code];
  const s = surnames[code];
  if (!Array.isArray(s)) {
    console.warn(`Skipping ${code}: no surname pool`);
    continue;
  }
  countries[code] = { names: n, surnames: s };
}

const payload = {
  generatedBy: "backend/scripts/build-namepools-json.mjs",
  countries,
};

writeFileSync(dst, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${dst}: ${Object.keys(countries).length} countries, ` +
    `${Object.values(countries).reduce((acc, c) => acc + c.names.length + c.surnames.length, 0)} entries`,
);
