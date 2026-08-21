import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Home, Medal, Settings as SettingsIcon, Radio, History as HistoryIcon, Shirt } from "lucide-react";
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

  const adminNav = user?.isAdmin
    ? [...NAV, { to: "/admin", label: "Admin", icon: <SettingsIcon size={15} /> }]
    : NAV;

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
