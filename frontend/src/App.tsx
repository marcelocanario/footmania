import { Suspense, lazy, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api/client";
import { useGame } from "./store/game";
import { useSettings } from "./store/settings";
import { Layout } from "./components/Layout";
import { PageLoading } from "./components/PageLoading";

// Route-level code-splitting: each screen is lazily loaded so only the
// critical auth gate + layout ship as the initial bundle.
function lazyNamed(load: () => Promise<Record<string, unknown>>, name: string) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

const Login = lazyNamed(() => import("./screens/Login"), "Login");
const Join = lazyNamed(() => import("./screens/Join"), "Join");
const Dashboard = lazyNamed(() => import("./screens/Dashboard"), "Dashboard");
const Squad = lazyNamed(() => import("./screens/Squad"), "Squad");
const Competitions = lazyNamed(() => import("./screens/Competitions"), "Competitions");
const LiveMatch = lazyNamed(() => import("./screens/LiveMatch"), "LiveMatch");
const Transfers = lazyNamed(() => import("./screens/Transfers"), "Transfers");
const Finances = lazyNamed(() => import("./screens/Finances"), "Finances");
const SeasonEnd = lazyNamed(() => import("./screens/SeasonEnd"), "SeasonEnd");
const Records = lazyNamed(() => import("./screens/Records"), "Records");
const History = lazyNamed(() => import("./screens/History"), "History");
const SettingsScreen = lazyNamed(() => import("./screens/Settings"), "SettingsScreen");
const FriendsScreen = lazyNamed(() => import("./screens/Friends"), "FriendsScreen");
const MyClub = lazyNamed(() => import("./screens/MyClub"), "MyClub");
const Admin = lazyNamed(() => import("./screens/Admin"), "Admin");

function Gate({ children }: { children: React.ReactNode }) {
  const { user, setUser, status, snapshot, loadStatus, loadClub } = useGame();
  const loadSettings = useSettings((s) => s.load);
  const navigate = useNavigate();
  const location = useLocation();
  const [clubDataReady, setClubDataReady] = useState(false);

  useEffect(() => {
    if (user) return;
    api
      .me()
       .then((res) => setUser(res.user))
      .catch(() => navigate("/login"));
  }, [user, setUser, navigate]);

  useEffect(() => {
    if (!user) return;
    let lastCheckedAt = 0;
    let refreshing = false;
    const refreshUser = () => {
      const now = Date.now();
      if (refreshing || now - lastCheckedAt < 30_000) return;
      lastCheckedAt = now;
      refreshing = true;
      void api
        .me()
        .then((res) => setUser(res.user))
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshUser();
    };
    window.addEventListener("focus", refreshUser);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshUser);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [user?.id, setUser]);

  useEffect(() => {
    if (user) void loadSettings();
  }, [user, loadSettings]);

  useEffect(() => {
    if (!user || location.pathname === "/join" || location.pathname === "/admin") {
      setClubDataReady(true);
      return;
    }
    if (status?.club && snapshot) {
      setClubDataReady(true);
      return;
    }
    let alive = true;
    void (async () => {
      const currentStatus = status ?? await loadStatus();
      if (!alive) return;
      if (currentStatus?.club && !snapshot) await loadClub();
      if (alive) setClubDataReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [user, location.pathname, status, snapshot, loadStatus, loadClub]);

  if (!user) return <PageLoading message="Signing you in" />;
  if (!clubDataReady && location.pathname !== "/join" && location.pathname !== "/admin") return <PageLoading />;
  return <>{children}</>;
}

function ClubGuard({ children }: { children: React.ReactNode }) {
  const { loadStatus, snapshot, loadClub, status } = useGame();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(() => status !== null && (!status.club || snapshot !== null));
  const [hasClub, setHasClub] = useState(() => !!status?.club);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Only hit the network for mp status if we don't already have it.
      // The GET cache also dedupes concurrent calls during fast navigation.
      const st = status ?? await loadStatus();
      if (!alive) return;
      const owns = !!st?.club;
      setHasClub(owns);
      if (owns && !snapshot) {
        const ok = await loadClub();
        if (!alive) return;
        if (!ok) {
          navigate("/join");
          return;
        }
      }
      setChecked(true);
    })();
    return () => {
      alive = false;
    };
  }, [loadStatus, loadClub, status, snapshot, navigate]);

  if (!checked) return <PageLoading />;
  if (!hasClub) {
    return <Navigate to="/join" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/join" element={<Join />} />
      <Route path="/my-club" element={<ClubGuard><MyClub /></ClubGuard>} />
      <Route path="/dashboard" element={<ClubGuard><Dashboard /></ClubGuard>} />
      <Route path="/squad" element={<ClubGuard><Squad /></ClubGuard>} />
      <Route path="/competitions" element={<ClubGuard><Competitions /></ClubGuard>} />
      {/* Matches screen removed: fixtures live inside Tables. Old links redirect. */}
      <Route path="/matchday" element={<Navigate to="/competitions" replace />} />
      <Route path="/live-match" element={<ClubGuard><LiveMatch /></ClubGuard>} />
      <Route path="/live-match/:matchId" element={<ClubGuard><LiveMatch /></ClubGuard>} />
      <Route path="/transfers" element={<ClubGuard><Transfers /></ClubGuard>} />
      <Route path="/finances" element={<ClubGuard><Finances /></ClubGuard>} />
      <Route path="/season-end" element={<ClubGuard><SeasonEnd /></ClubGuard>} />
      <Route path="/records" element={<ClubGuard><Records /></ClubGuard>} />
      <Route path="/history" element={<ClubGuard><History /></ClubGuard>} />
      <Route path="/settings" element={<ClubGuard><SettingsScreen /></ClubGuard>} />
      <Route path="/friends" element={<ClubGuard><FriendsScreen /></ClubGuard>} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoading message="Loading..." />}>
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
      </Suspense>
    </BrowserRouter>
  );
}
