#!/usr/bin/env node
/**
 * One-off import: copies all 221×2 Brasfoot name pools into
 * backend/assets/namepools.json and emits backend/src/game/countries.ts
 * (code, English name, strength, featured).
 * Run from the repo root: node backend/scripts/import-countries.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcNames = join(root, "Brasfoot", "res", "arquivos", "names");
const srcSurnames = join(root, "Brasfoot", "res", "arquivos", "surnames");
const dstPools = join(root, "backend", "assets", "namepools.json");
const dstCountries = join(root, "backend", "src", "game", "countries.ts");
const acJava = join(root, "Brasfoot", "src", "best", "ac.java");
const langXml = join(root, "Brasfoot", "res", "arquivos", "default_lang.xml");

// ---------------------------------------------------------------------------
// 1. Read name pools (skip ok_bra.txt and any non names/surnames files).
// ---------------------------------------------------------------------------
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

for (const dir of [srcNames, srcSurnames]) {
  if (!existsSync(dir)) throw new Error(`Missing source dir: ${dir}`);
}
const names = readPool(srcNames);
const surnames = readPool(srcSurnames);

// ---------------------------------------------------------------------------
// 2. Parse ac.java: code -> { id, nivel }  (lines like hG(m_0.getString("P0"), "AFG", 0, 3, 14, ...))
// ---------------------------------------------------------------------------
const acSource = readFileSync(acJava, "utf8");
const ac = new Map();
const enumRe = /getString\("(P\d+)"\)\s*,\s*"([A-Z]{3})"\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,/g;
let m;
while ((m = enumRe.exec(acSource)) !== null) {
  const [, ptKey, code, , , nivel] = m;
  ac.set(code, { nivel: Number(nivel), ptKey });
}
console.log(`Parsed ${ac.size} countries from ac.java`);

// ---------------------------------------------------------------------------
// 3. Parse default_lang.xml: P-index -> Portuguese name
// ---------------------------------------------------------------------------
const xml = readFileSync(langXml, "utf8");
const ptNames = new Map();
const entryRe = /<entry key="P(\d+)">([^<]+)<\/entry>/g;
while ((m = entryRe.exec(xml)) !== null) {
  ptNames.set(m[1], m[2].trim());
}

// ---------------------------------------------------------------------------
// 4. English display names, keyed by code (fallback: Portuguese name).
// ---------------------------------------------------------------------------
const EN_NAMES = {
  AFG: "Afghanistan", AFS: "South Africa", AGO: "Angola", AIA: "Anguilla", ALB: "Albania",
  ALE: "Germany", ALG: "Algeria", AND: "Andorra", ARG: "Argentina", ARM: "Armenia",
  ARS: "Saudi Arabia", ARU: "Aruba", ATG: "Antigua and Barbuda", AUS: "Australia", AUT: "Austria",
  AZE: "Azerbaijan", BAH: "Bahamas", BAN: "Bangladesh", BAR: "Barbados", BEL: "Belgium",
  BEN: "Benin", BER: "Bermuda", BHR: "Bahrain", BIE: "Belarus", BKF: "Burkina Faso",
  BLZ: "Belize", BOL: "Bolivia", BOS: "Bosnia and Herzegovina", BOT: "Botswana", BRA: "Brazil",
  BRU: "Brunei", BUL: "Bulgaria", BUR: "Burundi", BUT: "Bhutan", CAM: "Cameroon",
  CAN: "Canada", CAT: "Catalonia", CAV: "Cape Verde", CAZ: "Kazakhstan", CHA: "Chad",
  CHI: "Chile", CHN: "China", CMJ: "Cambodia", CNG: "Congo", COL: "Colombia",
  COM: "Ivory Coast", CPR: "Cyprus", CRN: "North Korea", CRO: "Croatia", CRS: "South Korea",
  CSR: "Costa Rica", CUB: "Cuba", CUR: "Curaçao", DIN: "Denmark", DJI: "Djibouti",
  DOM: "Dominica", EGI: "Egypt", ELQ: "Slovakia", ELS: "El Salvador", EMI: "United Arab Emirates",
  EQU: "Ecuador", ERI: "Eritrea", ESC: "Scotland", ESP: "Spain", EST: "Estonia",
  ESV: "Slovenia", ETI: "Ethiopia", EUA: "United States", FIJ: "Fiji", FIL: "Philippines",
  FIN: "Finland", FRA: "France", GAB: "Gabon", GAM: "Gambia", GAN: "Ghana",
  GDA: "Guadeloupe", GEO: "Georgia", GFR: "French Guiana", GIB: "Gibraltar", GMA: "Guam",
  GNB: "Guinea-Bissau", GNE: "Equatorial Guinea", GRA: "Grenada", GRE: "Greece", GUA: "Guatemala",
  GUI: "Guinea", GUN: "Guyana", HAI: "Haiti", HKG: "Hong Kong", HOL: "Netherlands",
  HON: "Honduras", HUN: "Hungary", ICA: "Cayman Islands", ICM: "Comoros", ICO: "Cook Islands",
  IDO: "Indonesia", IEM: "Yemen", IFA: "Faroe Islands", IMA: "Marshall Islands", IMR: "Mauritius",
  IND: "India", ING: "England", IRA: "Iran", IRL: "Ireland", IRN: "Northern Ireland",
  IRQ: "Iraq", ISA: "Solomon Islands", ISL: "Iceland", ISR: "Israel", ITA: "Italy",
  ITC: "Turks and Caicos Islands", IVA: "U.S. Virgin Islands", IVB: "British Virgin Islands",
  JAM: "Jamaica", JAP: "Japan", JOR: "Jordan", KIR: "Kiribati", KOS: "Kosovo",
  KUW: "Kuwait", LAO: "Laos", LBN: "Lebanon", LES: "Lesotho", LET: "Latvia",
  LIB: "Libya", LIE: "Liechtenstein", LIT: "Lithuania", LRI: "Liberia", LUX: "Luxembourg",
  MAC: "Macau", MAD: "Madagascar", MAL: "Malaysia", MAR: "Morocco", MAU: "Mauritania",
  MCD: "North Macedonia", MEX: "Mexico", MGL: "Mongolia", MIA: "Myanmar", MIC: "Micronesia",
  MLD: "Maldives", MLI: "Mali", MNC: "Monaco", MOC: "Mozambique", MOL: "Moldova",
  MON: "Montenegro", MST: "Montserrat", MTA: "Malta", MTI: "Martinique", MWI: "Malawi",
  NAM: "Namibia", NAU: "Nauru", NCA: "New Caledonia", NEP: "Nepal", NIC: "Nicaragua",
  NIG: "Niger", NIR: "Nigeria", NOR: "Norway", NOZ: "New Zealand", OMA: "Oman",
  PAL: "Palestine", PAN: "Panama", PAQ: "Pakistan", PAR: "Paraguay", PER: "Peru",
  PGA: "Wales", PLU: "Palau", PNG: "Papua New Guinea", POL: "Poland", POR: "Portugal",
  PRI: "Puerto Rico", QUE: "Kenya", QUI: "Kyrgyzstan", RCA: "Central African Republic",
  RDG: "DR Congo", RDO: "Dominican Republic", ROM: "Romania", RTC: "Czech Republic", RUA: "Rwanda",
  RUS: "Russia", SAM: "Samoa", SAN: "San Marino", SCN: "Saint Kitts and Nevis", SEN: "Senegal",
  SER: "Serbia", SEY: "Seychelles", SIN: "Singapore", SIR: "Syria", SLE: "Sierra Leone",
  SME: "American Samoa", SOM: "Somalia", SRI: "Sri Lanka", STL: "Saint Lucia",
  STP: "São Tomé and Príncipe", SUA: "Eswatini", SUD: "Sudan", SUE: "Sweden", SUI: "Switzerland",
  SUR: "Suriname", SUS: "South Sudan", SVG: "Saint Vincent and the Grenadines", TAD: "Tajikistan",
  TAI: "Thailand", TAN: "Tanzania", TAW: "Chinese Taipei", TCM: "Turkmenistan", TGO: "Togo",
  TML: "Timor-Leste", TON: "Tonga", TRT: "Trinidad and Tobago", TTI: "Tahiti", TUN: "Tunisia",
  TUR: "Turkey", TUV: "Tuvalu", UCR: "Ukraine", UGA: "Uganda", URU: "Uruguay",
  UZB: "Uzbekistan", VAN: "Vanuatu", VEN: "Venezuela", VIE: "Vietnam", ZAM: "Zambia",
  ZIM: "Zimbabwe",
};

const FEATURED = new Set([
  "BRA", "ARG", "URU", "COL", "CHI", "PER", "PAR", "MEX", "EUA", "CAN",
  "POR", "ESP", "FRA", "ITA", "ALE", "ING", "HOL", "BEL", "SUI", "AUT",
  "RUS", "UCR", "POL", "CRO", "SER", "TUR", "GRE", "DIN", "NOR", "SUE",
  "FIN", "IRL", "RTC", "JAP", "CHN", "AUS", "NOZ", "ARS", "MAR", "EGI",
  "NIG", "SEN", "COM", "IND",
]);

// ---------------------------------------------------------------------------
// 5. Build the country table from the copied name pools (221 codes).
// ---------------------------------------------------------------------------
const codes = Object.keys(names).sort();

const countries = [];
for (const code of codes) {
  const hasSurname = Array.isArray(surnames[code]);
  if (!hasSurname) {
    console.warn(`Skipping ${code}: no surname pool`);
    continue;
  }
  const meta = ac.get(code);
  const ptName = meta ? ptNames.get(meta.ptKey) ?? "" : "";
  const english = EN_NAMES[code] ?? ptName;
  if (!EN_NAMES[code]) console.warn(`No English name for ${code}, using "${ptName}"`);
  countries.push({
    code,
    name: english,
    strength: meta?.nivel ?? 12,
    featured: FEATURED.has(code),
  });
}
countries.sort((a, b) => a.name.localeCompare(b.name));

console.log(`Built ${countries.length} countries (${countries.filter((c) => c.featured).length} featured)`);

// ---------------------------------------------------------------------------
// 6. Emit the name-pool artifact (backend/assets/namepools.json).
// ---------------------------------------------------------------------------
const pools = {};
for (const code of codes) {
  if (!Array.isArray(surnames[code])) continue;
  pools[code] = { names: names[code], surnames: surnames[code] };
}
const artifact = {
  generatedBy: "backend/scripts/import-countries.mjs",
  countries: pools,
};
writeFileSync(dstPools, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${dstPools}: ${Object.keys(pools).length} countries, ` +
    `${Object.values(pools).reduce((acc, c) => acc + c.names.length + c.surnames.length, 0)} entries`,
);

// ---------------------------------------------------------------------------
// 7. Emit countries.ts
// ---------------------------------------------------------------------------
const lines = [];
lines.push("// Auto-generated by backend/scripts/import-countries.mjs — do not edit by hand.");
lines.push("");
lines.push("export interface CountryDef {");
lines.push("  code: string;");
lines.push("  name: string;");
lines.push("  strength: number;");
lines.push("  featured: boolean;");
lines.push("}");
lines.push("");
lines.push("export const COUNTRIES: CountryDef[] = [");
for (const c of countries) {
  lines.push(`  { code: ${JSON.stringify(c.code)}, name: ${JSON.stringify(c.name)}, strength: ${c.strength}, featured: ${c.featured} },`);
}
lines.push("];");
lines.push("");
lines.push("export const FEATURED_COUNTRIES: CountryDef[] = COUNTRIES.filter((c) => c.featured);");
lines.push("");
lines.push("export const COUNTRY_BY_CODE: Record<string, CountryDef> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));");
lines.push("");
writeFileSync(dstCountries, lines.join("\n"), "utf8");
console.log(`Wrote ${dstCountries}`);
