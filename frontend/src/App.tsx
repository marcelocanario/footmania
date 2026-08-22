import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { useGame } from "./store/game";
import { useSettings } from "./store/settings";
import { Layout } from "./components/Layout";
import { Login } from "./screens/Login";
import { Join } from "./screens/Join";
import { Dashboard } from "./screens/Dashboard";
import { Squad } from "./screens/Squad";
import { Competitions } from "./screens/Competitions";
import { Matchday } from "./screens/Matchday";
import { LiveMatch } from "./screens/LiveMatch";
import { Transfers } from "./screens/Transfers";
import { Finances } from "./screens/Finances";
import { SeasonEnd } from "./screens/SeasonEnd";
import { Records } from "./screens/Records";
import { History } from "./screens/History";
import { SettingsScreen } from "./screens/Settings";
import { MyClub } from "./screens/MyClub";
import { Automation } from "./screens/Automation";
import { Admin } from "./screens/Admin";
import { PageLoading } from "./components/PageLoading";

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

  if (!user) return <PageLoading message="Signing you in" />;
  return <>{children}</>;
}

function ClubGuard({ children }: { children: React.ReactNode }) {
  const { loadStatus, snapshot, loadClub } = useGame();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [hasClub, setHasClub] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = await loadStatus();
      if (!alive) return;
      const owns = !!st?.club;
      setHasClub(owns);
      if (owns && !snapshot) {
        const ok = await loadClub();
        if (!alive) return;
        if (!ok) {
          navigate("/saves");
          return;
        }
      }
      setChecked(true);
    })();
    return () => {
      alive = false;
    };
  }, [loadStatus, loadClub, snapshot, navigate]);

  if (!checked) return <PageLoading />;
  if (!hasClub) {
    return <Navigate to="/saves" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/saves" element={<Join />} />
      <Route path="/my-club" element={<ClubGuard><MyClub /></ClubGuard>} />
      <Route path="/automation" element={<ClubGuard><Automation /></ClubGuard>} />
      <Route path="/dashboard" element={<ClubGuard><Dashboard /></ClubGuard>} />
      <Route path="/squad" element={<ClubGuard><Squad /></ClubGuard>} />
      <Route path="/competitions" element={<ClubGuard><Competitions /></ClubGuard>} />
      <Route path="/matchday" element={<ClubGuard><Matchday /></ClubGuard>} />
      <Route path="/live-match" element={<ClubGuard><LiveMatch /></ClubGuard>} />
      <Route path="/transfers" element={<ClubGuard><Transfers /></ClubGuard>} />
      <Route path="/finances" element={<ClubGuard><Finances /></ClubGuard>} />
      <Route path="/season-end" element={<ClubGuard><SeasonEnd /></ClubGuard>} />
      <Route path="/records" element={<ClubGuard><Records /></ClubGuard>} />
      <Route path="/history" element={<ClubGuard><History /></ClubGuard>} />
      <Route path="/settings" element={<ClubGuard><SettingsScreen /></ClubGuard>} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
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
