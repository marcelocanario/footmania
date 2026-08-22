// The game uses Brasfoot/FIFA-style codes, so they cannot be passed directly
// to a generic ISO country-code flag helper.
const ISO_ALPHA2_BY_GAME_CODE: Readonly<Record<string, string>> = {
  AFG: "AF", ALB: "AL", ALG: "DZ", SME: "AS", AND: "AD", AGO: "AO", AIA: "AI", ATG: "AG",
  ARG: "AR", ARM: "AM", ARU: "AW", AUS: "AU", AUT: "AT", AZE: "AZ", BAH: "BS", BHR: "BH",
  BAN: "BD", BAR: "BB", BIE: "BY", BEL: "BE", BLZ: "BZ", BEN: "BJ", BER: "BM", BUT: "BT",
  BOL: "BO", BOS: "BA", BOT: "BW", BRA: "BR", IVB: "VG", BRU: "BN", BUL: "BG", BKF: "BF",
  BUR: "BI", CMJ: "KH", CAM: "CM", CAN: "CA", CAV: "CV", ICA: "KY", RCA: "CF", CHA: "TD",
  CHI: "CL", CHN: "CN", TAW: "TW", COL: "CO", ICM: "KM", CNG: "CG", ICO: "CK", CSR: "CR",
  CRO: "HR", CUB: "CU", CUR: "CW", CPR: "CY", RTC: "CZ", DIN: "DK", DJI: "DJ", DOM: "DM",
  RDO: "DO", RDG: "CD", EQU: "EC", EGI: "EG", ELS: "SV", GNE: "GQ", ERI: "ER", EST: "EE",
  SUA: "SZ", ETI: "ET", IFA: "FO", FIJ: "FJ", FIN: "FI", FRA: "FR", GFR: "GF", GAB: "GA",
  GAM: "GM", GEO: "GE", ALE: "DE", GAN: "GH", GIB: "GI", GRE: "GR", GRA: "GD", GDA: "GP",
  GMA: "GU", GUA: "GT", GUI: "GN", GNB: "GW", GUN: "GY", HAI: "HT", HON: "HN", HKG: "HK",
  HUN: "HU", ISL: "IS", IND: "IN", IDO: "ID", IRA: "IR", IRQ: "IQ", IRL: "IE", ISR: "IL",
  ITA: "IT", COM: "CI", JAM: "JM", JAP: "JP", JOR: "JO", CAZ: "KZ", QUE: "KE", KIR: "KI",
  KOS: "XK", KUW: "KW", QUI: "KG", LAO: "LA", LET: "LV", LBN: "LB", LES: "LS", LRI: "LR",
  LIB: "LY", LIE: "LI", LIT: "LT", LUX: "LU", MAC: "MO", MAD: "MG", MWI: "MW", MAL: "MY",
  MLD: "MV", MLI: "ML", MTA: "MT", IMA: "MH", MTI: "MQ", MAU: "MR", IMR: "MU", MEX: "MX",
  MIC: "FM", MOL: "MD", MNC: "MC", MGL: "MN", MON: "ME", MST: "MS", MAR: "MA", MOC: "MZ",
  MIA: "MM", NAM: "NA", NAU: "NR", NEP: "NP", HOL: "NL", NCA: "NC", NOZ: "NZ", NIC: "NI",
  NIG: "NE", NIR: "NG", CRN: "KP", MCD: "MK", IRN: "GB", NOR: "NO", OMA: "OM", PAQ: "PK", PLU: "PW",
  PAL: "PS", PAN: "PA", PNG: "PG", PAR: "PY", PER: "PE", FIL: "PH", POL: "PL", POR: "PT",
  PRI: "PR", ROM: "RO", RUS: "RU", RUA: "RW", SCN: "KN", STL: "LC", SVG: "VC", SAM: "WS",
  SAN: "SM", STP: "ST", ARS: "SA", SEN: "SN", SER: "RS", SEY: "SC", SLE: "SL", SIN: "SG",
  ELQ: "SK", ESV: "SI", ISA: "SB", SOM: "SO", AFS: "ZA", CRS: "KR", SUS: "SS", ESP: "ES",
  SRI: "LK", SUD: "SD", SUR: "SR", SUE: "SE", SUI: "CH", SIR: "SY", TTI: "PF", TAD: "TJ",
  TAN: "TZ", TAI: "TH", TML: "TL", TGO: "TG", TON: "TO", TRT: "TT", TUN: "TN", TUR: "TR",
  TCM: "TM", ITC: "TC", TUV: "TV", IVA: "VI", UGA: "UG", UCR: "UA", EMI: "AE", EUA: "US",
  URU: "UY", UZB: "UZ", VAN: "VU", VEN: "VE", VIE: "VN", IEM: "YE", ZAM: "ZM", ZIM: "ZW",
};

function subdivisionFlag(code: string): string {
  return String.fromCodePoint(
    0x1f3f4,
    ...[...code].map((letter) => 0xe0000 + letter.charCodeAt(0)),
    0xe007f,
  );
}

const SPECIAL_FLAGS: Readonly<Record<string, string>> = {
  ING: subdivisionFlag("gbeng"),
  ESC: subdivisionFlag("gbsct"),
  PGA: subdivisionFlag("gbwls"),
};

function regionalIndicatorFlag(alpha2: string): string {
  return String.fromCodePoint(...[...alpha2].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/** Returns the best available flag emoji for a game country code. */
export function countryFlag(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return SPECIAL_FLAGS[normalized] ?? (ISO_ALPHA2_BY_GAME_CODE[normalized] ? regionalIndicatorFlag(ISO_ALPHA2_BY_GAME_CODE[normalized]) : null);
}
