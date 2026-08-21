import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Home, Medal, Settings as SettingsIcon, Radio, History as HistoryIcon, Shirt, Zap, Bell, Crown } from "lucide-react";
import { strings } from "../strings";
import { useGame } from "../store/game";
import { api } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLiveMatchWatcher } from "../hooks/useLiveMatchWatcher";
import { FootballKit } from "./kit/FootballKit";
import { deriveKitDefaults } from "./kit/defaults";

const NAV = [
  { to: "/dashboard", label: "Home", icon: <Home size={15} /> },
  { to: "/squad", label: "Squad", icon: <Users size={15} /> },
  { to: "/competitions", label: "Tables", icon: <Table2 size={15} /> },
  { to: "/matchday", label: "Matches", icon: <CalendarDays size={15} /> },
  { to: "/transfers", label: "Transfers", icon: <ArrowLeftRight size={15} /> },
  { to: "/finances", label: "Finances", icon: <Wallet size={15} /> },
  { to: "/my-club", label: "My Club", icon: <Shirt size={15} /> },
  { to: "/automation", label: "Automation", icon: <Zap size={15} /> },
  { to: "/history", label: "History", icon: <HistoryIcon size={15} /> },
  { to: "/records", label: "Records", icon: <Medal size={15} /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon size={15} /> },
];

export function Layout({ children }: { children: ReactNode }) {
  const { snapshot, clear, setUser, status, liveMatchId, checkLiveMatch, user } = useGame();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  useLiveMatchWatcher();
  const club = snapshot?.club;
  const provisional = club?.competitionState === "PROVISIONAL" || status?.club?.competitionState === "PROVISIONAL";
  const dormant = club?.competitionState === "DORMANT" || status?.club?.competitionState === "DORMANT";
  const [notifications, setNotifications] = useState<{ id: string; type: string; payload: unknown; createdAt: string; readAt: string | null }[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [warnings, setWarnings] = useState<{ id: number; reason: string; createdAt: string }[]>([]);

  const adminNav = user?.isAdmin
    ? [...NAV, { to: "/admin", label: "Admin", icon: <SettingsIcon size={15} /> }]
    : NAV;

  useEffect(() => {
    if (!user) return;
    void api.myWarnings().then((res) => setWarnings(res.warnings.filter((w) => !w.acknowledgedAt) as never)).catch(() => {});
    const poll = async () => { try { const res = await api.listNotifications(20); setNotifications(res.notifications as never); } catch {} };
    void poll();
    const iv = setInterval(poll, 30000);
    return () => clearInterval(iv);
  }, [user]);

  const logout = async () => {
    await api.logout();
    setUser(null);
    clear();
    navigate("/login");
  };

  const inMatch = location.pathname === "/live-match" || location.pathname === "/season-end";
  const showResume = isMobile && snapshot && !inMatch && liveMatchId;

  const resume = () => {
    void checkLiveMatch().then((id) => {
      if (id) navigate("/live-match");
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/dashboard" className="logo" style={{ textDecoration: "none" }}>
          <img src="/footmania-logo.svg" alt="" className="logo-img" />
          {strings.app.name}
        </NavLink>

        {!isMobile && (
          <nav className="top-nav">
            {adminNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="top-right">
          {status?.season && (
            <span className="day-chip" title={`Season ${status.season.key} · round ${status.season.completedRounds}`}>
              <CalendarDays size={13} />
              <b>{status.season.key}</b>
              {status.season.joinState === "OPEN" ? " · open" : " · locked"}
            </span>
          )}
          {user && (
            <span className="chip" title={user.isPro ? "Pro" : "Regular"} style={user.isPro ? { borderColor: "var(--gold-2)", color: "var(--gold-2)" } : undefined}>
              <Crown size={12} /> {user.isPro ? "PRO" : "REG"} {user.isAdmin && "· ADMIN"}
            </span>
          )}
          <button className="icon-btn" onClick={() => setShowNotifs((v) => !v)} title="Notifications" aria-label="Notifications" style={{ position: "relative" }}>
            <Bell size={15} />
            {notifications.filter((n) => !n.readAt).length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 8, height: 8, borderRadius: 999, background: "var(--red-2)", border: "1px solid white" }} />}
          </button>
          {club && (
            <span className="club-chip" onClick={() => navigate("/dashboard")} title={club.name}>
              <FootballKit
                {...(club.kits?.home ?? deriveKitDefaults(club.primaryColor, club.secondaryColor).home)}
                size={26}
                flat
              />
              {club.shortName}
              {provisional && <span className="chip" style={{ borderColor: "rgba(240,180,41,0.4)", color: "var(--gold-2)" }}>PROV</span>}
              {dormant && <span className="chip" style={{ borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" }}>DORMANT</span>}
              {status?.club?.inactivity?.eligible && <span className="chip" style={{ borderColor: "rgba(220,120,60,0.5)", color: "var(--red-2)" }}>INACTIVE</span>}
            </span>
          )}
          <button className="icon-btn" onClick={logout} title={strings.auth.logout} aria-label={strings.auth.logout}>
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {warnings.length > 0 && (
        <div className="card" style={{ margin: "12px auto", maxWidth: 960, borderColor: "var(--red-2)", background: "rgba(220,60,60,0.08)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Moderation notice</div>
          {warnings.map((w) => (
            <div key={w.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: "0.88rem" }}>{w.reason}</span>
              <button className="btn ghost" onClick={() => void api.ackWarning(w.id).then(() => setWarnings((prev) => prev.filter((x) => x.id !== w.id)))}>Acknowledge</button>
            </div>
          ))}
        </div>
      )}
      {showNotifs && (
        <div className="card" style={{ margin: "12px auto", maxWidth: 480, position: "relative", zIndex: 5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Notifications</h3>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn ghost" onClick={() => void api.markAllNotificationsRead().then(() => setNotifications((prev) => prev.map((n) => ({ ...n, readAt: new Date().toISOString() }))))}>Mark all read</button>
              <button className="btn ghost" onClick={() => setShowNotifs(false)}>Close</button>
            </div>
          </div>
          {notifications.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No notifications. Match started/finished pushes appear here; <b>Pro</b> also gets goal pings and league digests.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{notifications.slice(0, 20).map((n) => <div key={n.id} className="news-item" style={{ opacity: n.readAt ? 0.6 : 1, display: "flex", justifyContent: "space-between", gap: 10 }}><span><b>{n.type}</b> · {new Date(n.createdAt).toLocaleString()}</span><button className="btn ghost" style={{ padding: "2px 8px", fontSize: "0.75rem" }} disabled={Boolean(n.readAt)} onClick={() => void api.markNotificationRead(n.id).then(() => setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)))}>{n.readAt ? "Read" : "Mark read"}</button></div>)}</div>}
          <div style={{ marginTop: 10, color: "var(--text-3)", fontSize: "0.75rem" }}>Push notifications: enable browser notifications in Settings to receive pushes when the tab is closed (Pro goal pings require Pro).</div>
        </div>
      )}
      <main className="content animate-in" key={location.pathname}>
        {children}
      </main>

      {isMobile && (
        <nav className="bottom-bar" aria-label="Primary">
          {adminNav.filter((n) => n.to !== "/competitions").map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}

      {showResume && (
        <button
          className="fab"
          onClick={resume}
          title={strings.dashboard.resume}
          aria-label={strings.dashboard.resume}
        >
          <Radio size={22} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
