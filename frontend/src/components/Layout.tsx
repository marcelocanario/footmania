import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Trophy, Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Home, Medal, Settings as SettingsIcon, Radio, History as HistoryIcon } from "lucide-react";
import { strings } from "../strings";
import { useGame } from "../store/game";
import { api } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLiveMatchWatcher } from "../hooks/useLiveMatchWatcher";

const NAV = [
  { to: "/dashboard", label: "Home", icon: <Home size={15} /> },
  { to: "/squad", label: "Squad", icon: <Users size={15} /> },
  { to: "/competitions", label: "Tables", icon: <Table2 size={15} /> },
  { to: "/matchday", label: "Matches", icon: <CalendarDays size={15} /> },
  { to: "/transfers", label: "Transfers", icon: <ArrowLeftRight size={15} /> },
  { to: "/finances", label: "Finances", icon: <Wallet size={15} /> },
  { to: "/history", label: "History", icon: <HistoryIcon size={15} /> },
  { to: "/records", label: "Records", icon: <Medal size={15} /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon size={15} /> },
];

function confidenceDot(v: number): string {
  return v >= 65 ? "good" : v >= 40 ? "mid" : "bad";
}

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
          <span className="crest-mini">
            <Trophy size={14} />
          </span>
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
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  display: "inline-grid",
                  placeItems: "center",
                  background: `linear-gradient(135deg, ${club.primaryColor}, ${club.secondaryColor})`,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.5)",
                }}
              >
                {club.shortName.slice(0, 3).toUpperCase()}
              </span>
              {club.shortName}
              {provisional && <span className="chip" style={{ borderColor: "rgba(240,180,41,0.4)", color: "var(--gold-2)" }}>PROV</span>}
              {dormant && <span className="chip" style={{ borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" }}>DORMANT</span>}
              {status?.club?.inactivity?.eligible && <span className="chip" style={{ borderColor: "rgba(220,120,60,0.5)", color: "var(--red-2)" }}>INACTIVE</span>}
              {club.boardConfidence !== undefined && (
                <span className={`dot ${confidenceDot(club.boardConfidence)}`} title={`Board confidence ${club.boardConfidence}%`} />
              )}
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
