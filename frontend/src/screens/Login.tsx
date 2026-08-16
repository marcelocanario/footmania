import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { InputText } from "primereact/inputtext";
import { Password } from "primereact/password";
import { Toast } from "primereact/toast";
import { Trophy } from "lucide-react";
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
  const setUser = useGame((s) => s.setUser);
  const toast = useRef<Toast>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const res = mode === "login" ? await api.login(username, password) : await api.register(username, password);
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
      <Toast ref={toast} />
      <div className="auth-card">
        <div className="hero">
          <div className="crest">
            <Trophy size={32} />
          </div>
          <div className="kicker" style={{ justifyContent: "center" }}>{strings.app.tagline}</div>
          <h1>{strings.app.name}</h1>
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
