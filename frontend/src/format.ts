import { useLang } from "./i18n/store";

// Intl formatters are cached per language: squad tables call money() dozens of
// times a frame and constructing a NumberFormat each call is not cheap.
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(lang: string): Intl.NumberFormat {
  let f = currencyFormatters.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(lang, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    });
    currencyFormatters.set(lang, f);
  }
  return f;
}

function numberFormatter(lang: string): Intl.NumberFormat {
  let f = numberFormatters.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(lang);
    numberFormatters.set(lang, f);
  }
  return f;
}

export function money(v: number): string {
  const lang = useLang.getState().lang;
  return currencyFormatter(lang).format(v);
}

export function num(v: number): string {
  const lang = useLang.getState().lang;
  return numberFormatter(lang).format(v);
}