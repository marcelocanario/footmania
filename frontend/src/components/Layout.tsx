import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Trophy, Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Play, Home, Medal, Settings as SettingsIcon } from "lucide-react";
import { strings } from "../strings";
import { useGame } from "../store/game";
import { api } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAdvanceDay } from "../hooks/useAdvanceDay";

const NAV = [
  { to: "/dashboard", label: "Home", icon: <Home size={15} /> },
  { to: "/squad", label: "Squad", icon: <Users size={15} /> },
  { to: "/competitions", label: "Tables", icon: <Table2 size={15} /> },
  { to: "/matchday", label: "Matches", icon: <CalendarDays size={15} /> },
  { to: "/transfers", label: "Transfers", icon: <ArrowLeftRight size={15} /> },
  { to: "/finances", label: "Finances", icon: <Wallet size={15} /> },
  { to: "/records", label: "Records", icon: <Medal size={15} /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon size={15} /> },
];

const BOTTOM = NAV.filter((n) => n.to !== "/competitions");

function confidenceDot(v: number): string {
  return v >= 65 ? "good" : v >= 40 ? "mid" : "bad";
}

export function Layout({ children }: { children: ReactNode }) {
  const { snapshot, clear, setUser } = useGame();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { busy: playBusy, run: playDay } = useAdvanceDay();
  const club = snapshot?.club;

  const logout = async () => {
    await api.logout();
    setUser(null);
    clear();
    navigate("/login");
  };

  const inMatch = location.pathname === "/live-match" || location.pathname === "/season-end";
  const showFab = isMobile && snapshot && !inMatch;

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
            {NAV.map((item) => (
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
          {snapshot && (
            <span className="day-chip" title={`Day ${snapshot.save.dayIndex} of Year ${snapshot.save.year}`}>
              <CalendarDays size={13} />
              <b>{snapshot.save.dayIndex}</b> · {snapshot.save.year}
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
          {BOTTOM.map((item) => (
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

      {showFab && (
        <button
          className="fab"
          onClick={() => playDay()}
          disabled={playBusy}
          title={strings.dashboard.continue}
          aria-label={strings.dashboard.continue}
        >
          <Play size={22} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
