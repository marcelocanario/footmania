import type { KitDesign } from "../components/kit/types";

export const LANG_CODES = ["en", "fr", "pt-BR"] as const;
export type Lang = (typeof LANG_CODES)[number];

export interface LanguageOption {
  code: Lang;
  label: string;
  kit: KitDesign;
}

// One entry per supported language; the jersey makes the choice scannable.
export const LANGUAGES = [
  {
    code: "en",
    label: "English",
    kit: { primary: "#ffffff", secondary: "#ce1124", accent: "#001a57", numberColor: "#001a57", pattern: "cross" },
  },
  {
    code: "fr",
    label: "Français",
    kit: { primary: "#001e5a", secondary: "#ffffff", accent: "#ed2939", numberColor: "#ffffff", pattern: "solid" },
  },
  {
    code: "pt-BR",
    label: "Português",
    kit: { primary: "#ffdf00", secondary: "#009739", accent: "#009739", numberColor: "#002776", pattern: "shoulders" },
  },
] as const satisfies readonly LanguageOption[];

const LANGUAGE_SET = new Set<string>(LANG_CODES);

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && LANGUAGE_SET.has(value);
}

/** Normalize browser language tags to the languages Footmania actually ships. */
export function languageFromTag(value: string | undefined): Lang | null {
  if (!value) return null;
  if (isLang(value)) return value;
  const base = value.toLowerCase().split("-")[0];
  if (base === "en") return "en";
  if (base === "fr") return "fr";
  // Brazilian Portuguese is the only Portuguese bundle available.
  if (base === "pt") return "pt-BR";
  return null;
}

export type LocaleSource = "local" | "auto";

export interface InitialLocale {
  lang: Lang;
  source: LocaleSource;
}

const STORAGE_KEY = "footmania:locale";

export function readStoredLocale(): Lang | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(lang: Lang): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* Ignore unavailable storage (private browsing and embedded views). */
  }
}

/** Resolve once, synchronously, before React paints anything. */
export function resolveInitialLocale(): InitialLocale {
  const stored = readStoredLocale();
  if (stored) return { lang: stored, source: "local" };

  if (typeof navigator !== "undefined") {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const lang = languageFromTag(tag);
      if (lang) return { lang, source: "auto" };
    }
  }
  return { lang: "en", source: "auto" };
}

export { STORAGE_KEY as LOCALE_STORAGE_KEY };
