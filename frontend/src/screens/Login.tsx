import { useEffect, useRef, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Toast } from "primereact/toast";
import { Languages } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { RotatingJersey } from "../components/RotatingJersey";
import { api, type PublicSeasonStatus } from "../api/client";
import { LanguagePicker } from "../components/LanguagePicker";

const DUST = [
  { left: "12%", delay: "0s", duration: "15s", drift: "26px" },
  { left: "27%", delay: "3.2s", duration: "18s", drift: "-18px" },
  { left: "44%", delay: "1.4s", duration: "16s", drift: "22px" },
  { left: "61%", delay: "5s", duration: "20s", drift: "-26px" },
  { left: "74%", delay: "2.1s", duration: "17s", drift: "14px" },
  { left: "88%", delay: "6.3s", duration: "19s", drift: "-16px" },
];

const STATIC_TAG = (): { label: string; live: boolean } => ({ label: i18n.t("login.staticTag"), live: false });

/** Map the public world-clock snapshot to a scoreboard "live status" tag. */
function seasonTag(status: PublicSeasonStatus | null): { label: string; live: boolean } {
  if (!status?.ready) return STATIC_TAG();

  const { paused, season } = status;
  // Admin freeze: the match is stopped mid-flight. Frame it as a stoppage in
  // the game, never as "closed" — the season picks back up.
  if (paused) {
    return { label: i18n.t("login.pausedTag"), live: false };
  }

  // After the final round the calendar moves through the post-match buffer and
  // the pre-season window. New managers are still placed for the next season.
  if (season.phase === "INTERSEASON") {
    return { label: i18n.t("login.preSeasonTag"), live: false };
  }
  if (season.phase === "POST_MATCH") {
    return { label: i18n.t("login.wrappingTag"), live: false };
  }

  // Active season, past the join cutoff: a new club would have to wait for the
  // next season — but they can still build while they wait. Say so warmly.
  if (season.joinState === "LOCKED") {
    return { label: i18n.t("login.lockedTag"), live: true };
  }

  // Active season and still open: the most inviting state.
  return { label: i18n.t("login.joiningTag", { n: season.seasonNumber }), live: true };
}

export function Login() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicSeasonStatus | null>(null);
  const [langOpen, setLangOpen] = useState(false);
  const location = useLocation();
  // Invite links (/login?invite=<token>): stash the token so the friendship is
  // created right after the Google sign-in lands (see App.tsx).
  const inviteToken = new URLSearchParams(location.search).get("invite");
  const toast = useRef<Toast>(null);

  // Public world-clock snapshot for the scoreboard tag. Best-effort: if the
  // endpoint is unreachable we fall back to the generic tagline.
  useEffect(() => {
    let alive = true;
    api
      .publicSeasonStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const startGoogle = async () => {
    if (busy) return;
    if (inviteToken) sessionStorage.setItem("fm_pending_invite", inviteToken);
    setBusy(true);
    const res = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
    if (res.error) {
      setBusy(false);
      toast.current?.show({ severity: "error", summary: t("auth.error"), detail: res.error.message ?? t("auth.googleFailed") });
    }
    // On success the browser redirects to Google; nothing else to do here.
  };

  const tag = seasonTag(status);

  // Close the language popout on any click or Escape outside of it.
  useEffect(() => {
    if (!langOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const wrap = document.querySelector(".landing-lang-wrap");
      if (wrap && !wrap.contains(event.target as Node)) setLangOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLangOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [langOpen]);

  return (
    <div className="landing">
      <Toast ref={toast} position="bottom-right" />

      {/* Stadium atmosphere */}
      <div className="landing-stripes" aria-hidden />
      <div className="landing-crowd" aria-hidden />
      <div className="landing-dust" aria-hidden>
        {DUST.map((d, i) => (
          <span key={i} style={{ left: d.left, animationDelay: d.delay, animationDuration: d.duration, ["--drift" as never]: d.drift }} />
        ))}
      </div>

      <div className="landing-inner">
        {/* Scoreboard masthead */}
        <header className="landing-masthead">
          <div className="landing-masthead-lockup">
            <img src="/footmania-logo.svg" alt="Footmania" className="logo-img" />
            <div className="landing-masthead-name">
              <b>Footmania<sup className="logo-alpha">ALPHA</sup></b>
              <span>{t("app.tagline")}</span>
            </div>
          </div>
          <div className="landing-masthead-right">
            <div className={`landing-masthead-tag${tag.live ? " live" : ""}`}>
              {tag.live && <span className="pulse-dot" />}
              {tag.label}
            </div>
            <div className="top-pop-wrap landing-lang-wrap">
              <button
                type="button"
                className="icon-btn"
                onClick={() => setLangOpen((v) => !v)}
                title={t("settings.language")}
                aria-label={t("settings.language")}
                aria-expanded={langOpen}
              >
                <Languages size={16} />
              </button>
              {langOpen && (
                <div className="popout landing-lang-popout">
                  <LanguagePicker compact />
                </div>
              )}
            </div>
          </div>
        </header>

        <main>
          {/* Opening story */}
          <section className="landing-story">
            <h1 className="landing-headline">{t("login.headline")}</h1>
            <p className="landing-lede">
              {t("login.lede")}
            </p>
            <div className="landing-eyebrow">{t("login.pickColors")}</div>
            <RotatingJersey />
            <div className="landing-cta-row">
              <button className="btn google" onClick={() => void startGoogle()} disabled={busy}>
                <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.1 3.56-5.18 3.56-8.81Z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.27v3.1A11.99 11.99 0 0 0 12 24Z" />
                  <path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.62H1.27a12.02 12.02 0 0 0 0 10.76l4.02-3.1Z" />
                  <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.97 11.97 0 0 0 12 0 11.99 11.99 0 0 0 1.27 6.62l4.02 3.1C6.23 6.88 8.88 4.77 12 4.77Z" />
                </svg>
                {busy ? t("common.loading") : t("auth.continueGoogle")}
              </button>
            </div>
          </section>
        </main>

        <footer className="landing-footer">
          <div>© {new Date().getFullYear()} {t("app.name")}. {t("login.rights")}</div>
          <div className="landing-footer-links">
            <Link to="/privacy" className="landing-privacy">{t("login.privacy")}</Link>
            <Link to="/terms" className="landing-privacy">{t("login.terms")}</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
