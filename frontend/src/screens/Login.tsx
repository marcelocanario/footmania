import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Toast } from "primereact/toast";
import { authClient } from "../lib/auth-client";
import { strings } from "../strings";
import { RotatingJersey } from "../components/RotatingJersey";
import { api, type PublicSeasonStatus } from "../api/client";

const DUST = [
  { left: "12%", delay: "0s", duration: "15s", drift: "26px" },
  { left: "27%", delay: "3.2s", duration: "18s", drift: "-18px" },
  { left: "44%", delay: "1.4s", duration: "16s", drift: "22px" },
  { left: "61%", delay: "5s", duration: "20s", drift: "-26px" },
  { left: "74%", delay: "2.1s", duration: "17s", drift: "14px" },
  { left: "88%", delay: "6.3s", duration: "19s", drift: "-16px" },
];

const STATIC_TAG = { label: "One world. One season.", live: false };

/** Map the public world-clock snapshot to a scoreboard "live status" tag. */
function seasonTag(status: PublicSeasonStatus | null): { label: string; live: boolean } {
  if (!status?.ready) return STATIC_TAG;

  const { paused, season } = status;
  // Admin freeze: the match is stopped mid-flight. Frame it as a stoppage in
  // the game, never as "closed" — the season picks back up.
  if (paused) {
    return { label: "Season paused · resumes shortly", live: false };
  }

  // After the final round the calendar moves through the post-match buffer and
  // the pre-season window. New managers are still placed for the next season.
  if (season.phase === "INTERSEASON") {
    return { label: "Pre-season · next season forming", live: false };
  }
  if (season.phase === "POST_MATCH") {
    return { label: "Season wrapping up · next campaign forming", live: false };
  }

  // Active season, past the join cutoff: a new club would have to wait for the
  // next season — but they can still build while they wait. Say so warmly.
  if (season.joinState === "LOCKED") {
    return { label: "Season in full swing · new clubs can prep now", live: true };
  }

  // Active season and still open: the most inviting state.
  return { label: `Season ${season.seasonNumber} · joining open`, live: true };
}

export function Login() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicSeasonStatus | null>(null);
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
      toast.current?.show({ severity: "error", summary: "Error", detail: res.error.message ?? "Google sign-in failed" });
    }
    // On success the browser redirects to Google; nothing else to do here.
  };

  const tag = seasonTag(status);

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
              <span>{strings.app.tagline}</span>
            </div>
          </div>
          <div className={`landing-masthead-tag${tag.live ? " live" : ""}`}>
            {tag.live && <span className="pulse-dot" />}
            {tag.label}
          </div>
        </header>

        <main>
          {/* Opening story */}
          <section className="landing-story">
            <h1 className="landing-headline">
              One club. One <span className="hl-grass">world</span>.
              <br />
              Write your <span className="hl-gold">legend</span>.
            </h1>
            <p className="landing-lede">
              Footmania is a single, living universe. Hundreds of managers own a club and compete in one
              shared pyramid — every match matters, every signing shifts the balance, and every season becomes part of a 
              <b> shared history</b>.
            </p>
            <div className="landing-eyebrow">Pick your colors, your own club starts here</div>
            <RotatingJersey />
            <div className="landing-cta-row">
              <button className="btn google" onClick={() => void startGoogle()} disabled={busy}>
                <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.1 3.56-5.18 3.56-8.81Z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.27v3.1A11.99 11.99 0 0 0 12 24Z" />
                  <path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.62H1.27a12.02 12.02 0 0 0 0 10.76l4.02-3.1Z" />
                  <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.97 11.97 0 0 0 12 0 11.99 11.99 0 0 0 1.27 6.62l4.02 3.1C6.23 6.88 8.88 4.77 12 4.77Z" />
                </svg>
                {busy ? strings.common.loading : "Continue with Google"}
              </button>
            </div>
          </section>
        </main>

        <footer className="landing-footer">
          © {new Date().getFullYear()} {strings.app.name}. All rights reserved.
        </footer>
      </div>
    </div>
  );
}
