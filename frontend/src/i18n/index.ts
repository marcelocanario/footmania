import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
// The "server" namespace is the single copy of the backend's news/message
// catalog: flat dotted keys, looked up with keySeparator:false (see news.tsx)
// so there is no second hand-maintained translation of the same strings.
import serverEn from "@server-i18n/locales/server.en.json";
import { applyPrimeLocale } from "./primereact";
import { loadLocaleBundle, setBootLanguage, useLang } from "./store";

let bootPromise: Promise<void> | null = null;

/** Initialize before createRoot so auto-detected users never see an English frame. */
export function bootI18n(): Promise<void> {
  bootPromise ??= (async () => {
    if (!i18n.isInitialized) {
      await i18n
        .use(initReactI18next)
        .init({
          resources: { en: { translation: en, server: serverEn } },
          ns: ["translation", "server"],
          defaultNS: "translation",
          lng: useLang.getState().lang,
          fallbackLng: "en",
          supportedLngs: ["en", "fr", "pt-BR"],
          load: "currentOnly",
          cleanCode: false,
          returnNull: false,
          partialBundledLanguages: true,
          interpolation: { escapeValue: false, skipOnVariables: true },
          react: { useSuspense: false },
        });
    }
    const { lang, source } = useLang.getState();
    await loadLocaleBundle(lang);
    await i18n.changeLanguage(lang);
    setBootLanguage(lang, source);
    applyPrimeLocale(lang);
  })();
  return bootPromise;
}

// initReactI18next registers the default instance; no I18nextProvider is
// needed, preserving the app's zero-Context structure.
export { i18n };
