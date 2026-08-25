import { useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Toast } from "primereact/toast";
import { authClient } from "../lib/auth-client";
import { strings } from "../strings";

export function Login() {
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  // Invite links (/login?invite=<token>): stash the token so the friendship is
  // created right after the Google sign-in lands (see App.tsx).
  const inviteToken = new URLSearchParams(location.search).get("invite");
  const toast = useRef<Toast>(null);

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

  return (
    <div className="auth-wrap">
      <Toast ref={toast} position="bottom-right" />
      <div className="auth-card">
        <div className="hero">
          <img src="/footmania-logo.svg" alt="Footmania" className="logo-img hero-logo" />
          <h1>{strings.app.name}</h1>
          <div className="kicker" style={{ justifyContent: "center" }}>{strings.app.tagline}</div>
        </div>

        {inviteToken && (
          <div style={{ marginTop: 16, padding: "8px 12px", border: "1px solid var(--grass-2)", borderRadius: 8, color: "var(--grass-2)", fontSize: "0.88rem" }}>
            You are signing in through a friend's invite link — you'll become friends automatically.
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <button className="btn" style={{ width: "100%" }} onClick={() => void startGoogle()} disabled={busy}>
            {busy ? strings.common.loading : "Continue with Google"}
          </button>
        </div>

        <p className="footer-note" style={{ marginTop: 14, fontSize: "0.85rem", color: "var(--text-3)" }}>
          You'll be asked to sign in with your Google account. Your verified email is your Footmania account.
        </p>
      </div>
    </div>
  );
}
