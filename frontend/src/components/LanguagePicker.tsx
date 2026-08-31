import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n/languages";
import { useLang } from "../i18n/store";
import { FootballKit } from "./kit/FootballKit";
import { useGame } from "../store/game";
import { api } from "../api/client";

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const lang = useLang((state) => state.lang);
  const setLanguage = useLang((state) => state.setLanguage);
  const user = useGame((state) => state.user);
  const setUser = useGame((state) => state.setUser);

  const choose = async (code: typeof lang) => {
    await setLanguage(code);
    // An explicit choice is the most recent globally; push it to the account
    // when signed in so other devices pick it up on their next reconciliation.
    if (user) {
      try {
        await api.updateLocale(code);
        setUser({ ...user, locale: code });
      } catch {
        /* Best-effort: the local preference still applies this session. */
      }
    }
  };

  return (
    <div className={`language-picker${compact ? " compact" : ""}`}>
      {!compact && <div className="language-picker-description">{t("settings.languageDescription")}</div>}
      <div className="language-picker-options" role="radiogroup" aria-label={t("settings.language")}>
        {LANGUAGES.map((option) => (
          <button
            key={option.code}
            type="button"
            className={`language-option${option.code === lang ? " selected" : ""}`}
            role="radio"
            aria-checked={option.code === lang}
            onClick={() => void choose(option.code)}
          >
            <FootballKit {...option.kit} size={56} flat />
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
