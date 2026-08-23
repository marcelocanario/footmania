import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { InputText } from "primereact/inputtext";
import { Password } from "primereact/password";
import { Toast } from "primereact/toast";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { Segmented } from "../components/Segmented";

export function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  // Invite links (/login?invite=<token>): registering through the link
  // auto-creates the friendship with the inviter (backend/src/routes/auth.ts).
  const inviteToken = new URLSearchParams(location.search).get("invite") ?? undefined;
  const setUser = useGame((s) => s.setUser);
  const toast = useRef<Toast>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const res = mode === "login" ? await api.login(username, password) : await api.register(username, password, inviteToken);
      setUser(res.user);
      navigate("/");
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
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

        <div style={{ display: "flex", justifyContent: "center" }}>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v)}
            items={[
              { value: "login", label: strings.auth.login },
              { value: "register", label: strings.auth.register },
            ]}
          />
        </div>

        {inviteToken && mode === "register" && (
          <div style={{ marginTop: 16, padding: "8px 12px", border: "1px solid var(--grass-2)", borderRadius: 8, color: "var(--grass-2)", fontSize: "0.88rem" }}>
            You are registering through a friend's invite link — you'll become friends automatically.
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <div className="form-group">
            <label htmlFor="auth-user">{strings.auth.username}</label>
            <InputText
              id="auth-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{ width: "100%" }}
              placeholder="manager01"
              autoComplete="username"
            />
          </div>
          <div className="form-group">
            <label htmlFor="auth-pass">{strings.auth.password}</label>
            <Password
              id="auth-pass"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              feedback={false}
              toggleMask
              style={{ width: "100%" }}
              inputStyle={{ width: "100%" }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          <button className="btn" style={{ width: "100%", marginTop: 6 }} onClick={submit} disabled={busy || !username || !password}>
            {busy ? strings.common.loading : mode === "login" ? strings.auth.login : strings.auth.register}
          </button>
        </div>

        <p className="footer-note">
          {mode === "login" ? strings.auth.noAccount : strings.auth.hasAccount}{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? strings.auth.register : strings.auth.login}
          </a>
        </p>
      </div>
    </div>
  );
}
