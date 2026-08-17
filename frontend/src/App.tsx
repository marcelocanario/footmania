import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { useGame } from "./store/game";
import { useSettings } from "./store/settings";
import { strings } from "./strings";
import { Layout } from "./components/Layout";
import { Login } from "./screens/Login";
import { Saves } from "./screens/Saves";
import { Dashboard } from "./screens/Dashboard";
import { Squad } from "./screens/Squad";
import { Competitions } from "./screens/Competitions";
import { Matchday } from "./screens/Matchday";
import { LiveMatch } from "./screens/LiveMatch";
import { Transfers } from "./screens/Transfers";
import { Finances } from "./screens/Finances";
import { SeasonEnd } from "./screens/SeasonEnd";
import { Records } from "./screens/Records";
import { SettingsScreen } from "./screens/Settings";

function Gate({ children }: { children: React.ReactNode }) {
  const { user, setUser } = useGame();
  const loadSettings = useSettings((s) => s.load);
  const navigate = useNavigate();

  useEffect(() => {
    if (user) return;
    api
      .me()
      .then((res) => setUser(res))
      .catch(() => navigate("/login"));
  }, [user, setUser, navigate]);

  useEffect(() => {
    if (user) void loadSettings();
  }, [user, loadSettings]);

  if (!user) return null;
  return <>{children}</>;
}

function Guard({ children }: { children: React.ReactNode }) {
  const { saveId, snapshot, loadSave } = useGame();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!saveId) {
      navigate("/saves");
      return;
    }
    if (!snapshot) {
      loadSave(saveId).then((ok) => {
        if (!ok) {
          setFailed(true);
          navigate("/saves");
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, snapshot]);

  if (!saveId || failed) return null;
  if (!snapshot) return <div className="empty-state" style={{ paddingTop: 80 }}>{strings.common.loading}</div>;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/saves" replace />} />
      <Route path="/saves" element={<Saves />} />
      <Route path="/dashboard" element={<Guard><Dashboard /></Guard>} />
      <Route path="/squad" element={<Guard><Squad /></Guard>} />
      <Route path="/competitions" element={<Guard><Competitions /></Guard>} />
      <Route path="/matchday" element={<Guard><Matchday /></Guard>} />
      <Route path="/live-match" element={<Guard><LiveMatch /></Guard>} />
      <Route path="/transfers" element={<Guard><Transfers /></Guard>} />
      <Route path="/finances" element={<Guard><Finances /></Guard>} />
      <Route path="/season-end" element={<Guard><SeasonEnd /></Guard>} />
      <Route path="/records" element={<Guard><Records /></Guard>} />
      <Route path="/settings" element={<Guard><SettingsScreen /></Guard>} />
      <Route path="*" element={<Navigate to="/saves" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <Gate>
              <Layout>
                <AppRoutes />
              </Layout>
            </Gate>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
