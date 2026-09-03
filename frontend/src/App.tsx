import { Suspense, lazy, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api/client";
import { useGame } from "./store/game";
import { useSettings } from "./store/settings";
import { Layout } from "./components/Layout";
import { PageLoading } from "./components/PageLoading";
import { i18n } from "./i18n";
import { isLang } from "./i18n/languages";
import { useLang } from "./i18n/store";

// Route-level code-splitting: each screen is lazily loaded so only the
// critical auth gate + layout ship as the initial bundle.
function lazyNamed(load: () => Promise<Record<string, unknown>>, name: string) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

const Login = lazyNamed(() => import("./screens/Login"), "Login");
const Join = lazyNamed(() => import("./screens/Join"), "Join");
const Dashboard = lazyNamed(() => import("./screens/Dashboard"), "Dashboard");
const Squad = lazyNamed(() => import("./screens/Squad"), "Squad");
const Tactics = lazyNamed(() => import("./screens/Tactics"), "Tactics");
const Competitions = lazyNamed(() => import("./screens/Competitions"), "Competitions");
const LiveMatch = lazyNamed(() => import("./screens/LiveMatch"), "LiveMatch");
const PreGame = lazyNamed(() => import("./screens/PreGame"), "PreGame");
const Transfers = lazyNamed(() => import("./screens/Transfers"), "Transfers");
const Finances = lazyNamed(() => import("./screens/Finances"), "Finances");
const SeasonEnd = lazyNamed(() => import("./screens/SeasonEnd"), "SeasonEnd");
const SettingsScreen = lazyNamed(() => import("./screens/Settings"), "SettingsScreen");
const FriendsScreen = lazyNamed(() => import("./screens/Friends"), "FriendsScreen");
const MyClub = lazyNamed(() => import("./screens/MyClub"), "MyClub");
const TeamScreen = lazyNamed(() => import("./screens/TeamScreen"), "TeamScreen");
const TeamOverview = lazyNamed(() => import("./screens/TeamScreen"), "TeamOverview");
const TeamHistory = lazyNamed(() => import("./screens/History"), "TeamHistory");
const Admin = lazyNamed(() => import("./screens/Admin"), "Admin");
const Privacy = lazyNamed(() => import("./screens/Privacy"), "Privacy");
const Terms = lazyNamed(() => import("./screens/Terms"), "Terms");

function Gate({ children }: { children: React.ReactNode }) {
  const { user, setUser, status, snapshot, loadStatus, loadClub } = useGame();
  const loadSettings = useSettings((s) => s.load);
  const navigate = useNavigate();
  const location = useLocation();
  const [clubDataReady, setClubDataReady] = useState(false);
  const [localeReady, setLocaleReady] = useState(false);

  useEffect(() => {
    if (user) return;
    setLocaleReady(false);
    api
      .me()
      .then(async (res) => {
        const detected = useLang.getState();
        if (detected.source === "local") {
          // An explicit choice on this device wins over a stale account row.
          if (res.user.locale !== detected.lang) await api.updateLocale(detected.lang).catch(() => undefined);
        } else if (isLang(res.user.locale)) {
          // Browser detection is not an opinion: adopt the account preference
          // and persist it so subsequent boots do not need reconciliation.
          await detected.setLanguage(res.user.locale);
        }
        setUser(res.user);
        setLocaleReady(true);
        // Complete a pending friend invitation stashed before the Google
        // redirect; best-effort (an invalid/used token is ignored silently).
        const pending = sessionStorage.getItem("fm_pending_invite");
        if (pending) {
          sessionStorage.removeItem("fm_pending_invite");
          void api.acceptInvite(pending).catch(() => undefined);
        }
      })
      .catch(() => {
        setLocaleReady(true);
        navigate("/login");
      });
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

  if (!user) return <PageLoading message={i18n.t("common.signingIn")} />;
  if (!localeReady) return <PageLoading message={i18n.t("common.signingIn")} />;
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

/** Bare /history and the old /history/:clubId URLs resolve to the team
 *  profile's History tab (/team/:clubId/history). */
function TeamHistoryRedirect() {
  const { clubId } = useParams();
  const status = useGame((s) => s.status);
  const snapshot = useGame((s) => s.snapshot);
  const ownClubId = snapshot?.club?.id ?? status?.club?.id ?? status?.userClubId ?? null;
  const target = clubId !== undefined ? clubId : ownClubId !== null ? String(ownClubId) : null;
  if (target !== null && /^[1-9]\d*$/.test(target)) return <Navigate to={`/team/${target}/history`} replace />;
  // Malformed ids (and the no-club edge) surface the same unknown-team
  // empty state the team screen shows, instead of a silent dashboard bounce.
  return <div className="empty-state" style={{ paddingTop: 80 }}>{i18n.t("team.unknown")}</div>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/join" element={<Join />} />
      <Route path="/my-club" element={<ClubGuard><MyClub /></ClubGuard>} />
      <Route path="/team/:clubId" element={<ClubGuard><TeamScreen /></ClubGuard>}>
        <Route index element={<TeamOverview />} />
        <Route path="history" element={<TeamHistory />} />
      </Route>
      <Route path="/dashboard" element={<ClubGuard><Dashboard /></ClubGuard>} />
      <Route path="/squad" element={<ClubGuard><Squad /></ClubGuard>} />
      <Route path="/tactics" element={<ClubGuard><Tactics /></ClubGuard>} />
      <Route path="/competitions" element={<ClubGuard><Competitions /></ClubGuard>} />
      {/* Matches screen removed: fixtures live inside Tables. Old links redirect. */}
      <Route path="/matchday" element={<Navigate to="/competitions" replace />} />
      <Route path="/live-match" element={<ClubGuard><LiveMatch /></ClubGuard>} />
      <Route path="/live-match/:matchId" element={<ClubGuard><LiveMatch /></ClubGuard>} />
      <Route path="/pregame" element={<ClubGuard><PreGame /></ClubGuard>} />
      <Route path="/transfers" element={<ClubGuard><Transfers /></ClubGuard>} />
      <Route path="/finances" element={<ClubGuard><Finances /></ClubGuard>} />
      <Route path="/season-end" element={<ClubGuard><SeasonEnd /></ClubGuard>} />
      <Route path="/records" element={<Navigate to="/history" replace />} />
      <Route path="/history" element={<ClubGuard><TeamHistoryRedirect /></ClubGuard>} />
      <Route path="/history/:clubId" element={<ClubGuard><TeamHistoryRedirect /></ClubGuard>} />
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
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
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
