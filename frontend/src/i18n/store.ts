import { create } from "zustand";
import i18n from "i18next";
import { applyPrimeLocale } from "./primereact";
import { isLang, readStoredLocale, resolveInitialLocale, writeStoredLocale, type Lang, type LocaleSource } from "./languages";

interface LanguageState {
  lang: Lang;
  source: LocaleSource;
  ready: boolean;
  setLanguage: (lang: Lang) => Promise<void>;
}

const initial = resolveInitialLocale();

export async function loadLocaleBundle(lang: Lang): Promise<void> {
  if (lang === "en") return;
  if (i18n.hasResourceBundle(lang, "translation")) return;
  const [resource, serverResource] = await (lang === "fr"
    ? Promise.all([import("./locales/fr").then((m) => m.fr), import("@server-i18n/locales/server.fr.json").then((m) => m.default)])
    : Promise.all([import("./locales/pt-BR").then((m) => m.ptBR), import("@server-i18n/locales/server.pt-BR.json").then((m) => m.default)]));
  i18n.addResourceBundle(lang, "translation", resource, true, true);
  i18n.addResourceBundle(lang, "server", serverResource, true, true);
}

function setDocumentLanguage(lang: Lang): void {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export const useLang = create<LanguageState>((set) => ({
  lang: initial.lang,
  source: initial.source,
  ready: false,
  setLanguage: async (lang) => {
    if (!isLang(lang)) return;
    await loadLocaleBundle(lang);
    await i18n.changeLanguage(lang);
    writeStoredLocale(lang);
    setDocumentLanguage(lang);
    applyPrimeLocale(lang);
    set({ lang, source: "local", ready: true });
  },
}));

export function currentLang(): Lang {
  return useLang.getState().lang;
}

/** Used by boot/reconciliation when persistence must not trigger a PUT. */
export function setBootLanguage(lang: Lang, source: LocaleSource): void {
  useLang.setState({ lang, source, ready: true });
  setDocumentLanguage(lang);
  applyPrimeLocale(lang);
}

export { readStoredLocale, resolveInitialLocale, writeStoredLocale };
