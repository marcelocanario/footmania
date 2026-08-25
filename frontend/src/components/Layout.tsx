import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Home, ShieldCheck, Radio, History as HistoryIcon, Shirt, Bell, Settings as SettingsIcon, UserPlus, Hourglass } from "lucide-react";
import { strings } from "../strings";
import { useGame } from "../store/game";
import { api } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLiveMatchWatcher } from "../hooks/useLiveMatchWatcher";
import { FootballKit } from "./kit/FootballKit";
import { deriveKitDefaults } from "./kit/defaults";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  admin?: boolean;
}

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Home", icon: <Home size={15} /> },
  { to: "/squad", label: "Squad", icon: <Users size={15} /> },
  { to: "/competitions", label: "Tables", icon: <Table2 size={15} /> },
  { to: "/transfers", label: "Transfers", icon: <ArrowLeftRight size={15} /> },
  { to: "/finances", label: "Finances", icon: <Wallet size={15} /> },
  { to: "/my-club", label: "My Club", icon: <Shirt size={15} /> },
  { to: "/history", label: "History", icon: <HistoryIcon size={15} /> },
  { to: "/friends", label: "Friends", icon: <UserPlus size={15} /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon size={15} /> },
];

interface SeasonDayEntry {
  day: number;
  phase: "ACTIVE" | "POST_MATCH" | "INTERSEASON";
  label: string;
}

interface MyMatch {
  fixtureId: number;
  dayIndex: number;
  round: number;
  opponent: string;
  opponentClubId: number;
  isHome: boolean;
  played: boolean;
  goalsFor: number | null;
  goalsAgainst: number | null;
}

type NotificationItem = { id: string; type: string; payload: unknown; createdAt: string; readAt: string | null };

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Human-readable copy for a stored notification. Falls back gracefully for
 * legacy payloads that predate embedded club names. */
function describeNotification(n: NotificationItem, matchByFixture: Map<number, MyMatch>): { title: string; detail: string } {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof p[key] === "string" && p[key] ? p[key] as string : null);
  const num = (key: string): number | null => (typeof p[key] === "number" ? p[key] as number : null);

  let home = str("homeName");
  let away = str("awayName");
  // Legacy payloads carry only IDs: resolve through this season's fixture list.
  if ((!home || !away) && typeof p.fixtureId === "number") {
    const m = matchByFixture.get(p.fixtureId);
    if (m && !home && !away) {
      home = m.isHome ? "You" : m.opponent;
      away = m.isHome ? m.opponent : "You";
    }
  }

  switch (n.type) {
    case "MATCH_STARTED": {
      const teams = home && away ? `${home} vs ${away}` : "Your match has kicked off";
      const comp = str("competitionName");
      return { title: "Kick-off", detail: comp ? `${teams} · ${comp}` : teams };
    }
    case "MATCH_FINISHED": {
      const hs = num("homeScore");
      const as = num("awayScore");
      const clubId = num("clubId");
      if (hs !== null && as !== null && home && away && clubId !== null) {
        const userIsHome = clubId === num("homeClubId");
        const gf = userIsHome ? hs : as;
        const ga = userIsHome ? as : hs;
        return { title: gf > ga ? "Full time — you won" : gf === ga ? "Full time — draw" : "Full time — you lost", detail: `${home} ${hs}-${as} ${away}` };
      }
      if (hs !== null && as !== null && home && away) return { title: "Full time", detail: `${home} ${hs}-${as} ${away}` };
      return { title: "Full time", detail: home && away ? `${home} vs ${away}` : "Your match has finished" };
    }
    case "MATCH_GOAL": {
      const minute = num("minute");
      const scores = Array.isArray(p.scores) && p.scores.length >= 2 && typeof p.scores[0] === "number" ? `${p.scores[0]}-${p.scores[1]}` : null;
      const scorer = str("scoringName");
      const parts = [minute !== null ? `${minute}'` : null, scorer, scores].filter(Boolean);
      return { title: "Goal!", detail: parts.join(" · ") || "A goal has been scored in your match" };
    }
    case "LEAGUE_RESULTS":
      return { title: "League results", detail: "The latest results from your division are in" };
    default:
      return { title: n.type.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" "), detail: "" };
  }
}

function matchTitle(day: SeasonDayEntry, match: MyMatch | undefined): string {
  let title = `Day ${day.day} · ${day.label}`;
  if (match) title += ` · ${match.isHome ? "vs" : "@"} ${match.opponent}`;
  if (match?.played) title += ` (${match.goalsFor}-${match.goalsAgainst})`;
  return title;
}

function SeasonCalendar({ days, today, matches }: { days: SeasonDayEntry[]; today: number; matches: MyMatch[] }) {
  const navigate = useNavigate();
  const matchByDay = new Map(matches.map((m) => [m.dayIndex, m]));
  return (
    <>
      <div className="cal-grid">
        {days.map((d) => {
          const dayIndex = d.day - 1;
          const match = matchByDay.get(dayIndex);
          const cls = [
            "cal-cell",
            d.phase === "POST_MATCH" ? "post" : d.phase === "INTERSEASON" ? "pre" : "",
            dayIndex === today ? "today" : "",
          ].filter(Boolean).join(" ");
          return (
            // A fixture day cell opens the opponent's team screen.
            <div
              key={d.day}
              className={cls}
              title={matchTitle(d, match)}
              role={match ? "button" : undefined}
              style={match ? { cursor: "pointer" } : undefined}
              onClick={match && match.opponentClubId ? () => navigate(`/team/${match.opponentClubId}`) : undefined}
            >
              <span>{d.day}</span>
              {match ? (match.played
                ? <span className="cal-score">{match.goalsFor}-{match.goalsAgainst}</span>
                : <span className="cal-dot" />)
                : null}
            </div>
          );
        })}
      </div>
      <div className="cal-legend">
        <span><i className="lg-swatch" /> League</span>
        <span><i className="lg-swatch post" /> Post-match</span>
        <span><i className="lg-swatch pre" /> Pre-season</span>
        <span><i className="lg-dot" /> Your fixtures · score when played</span>
      </div>
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const snapshot = useGame((s) => s.snapshot);
  const clear = useGame((s) => s.clear);
  const setUser = useGame((s) => s.setUser);
  const status = useGame((s) => s.status);
  const liveMatchId = useGame((s) => s.liveMatchId);
  const checkLiveMatch = useGame((s) => s.checkLiveMatch);
  const user = useGame((s) => s.user);
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  useLiveMatchWatcher();
  const club = snapshot?.club;
  const teamCreationRequired = status !== null && !status.club;
  // Admins always reach the admin page, even before creating a team. Every
  // other destination stays locked until a club exists.
  const navLockedFor = (to: string) => teamCreationRequired && to !== "/admin";
  const provisional = club?.competitionState === "PROVISIONAL" || status?.club?.competitionState === "PROVISIONAL";
  const dormant = club?.competitionState === "DORMANT" || status?.club?.competitionState === "DORMANT";
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showSeasonCal, setShowSeasonCal] = useState(false);
  const [warnings, setWarnings] = useState<{ id: number; reason: string; createdAt: string }[]>([]);
  const notifPopRef = useRef<HTMLDivElement>(null);
  const seasonPopRef = useRef<HTMLDivElement>(null);
  // Fixture-id lookup used to render friendly copy for legacy notification
  // payloads that only carry club/fixture IDs.
  const matchByFixture = new Map((status?.myMatches ?? []).map((m) => [m.fixtureId, m]));

  const adminNav: NavItem[] = user?.isAdmin
    ? [...NAV, { to: "/admin", label: "Admin", icon: <ShieldCheck size={15} />, admin: true }]
    : NAV;

  // Close anchored topbar popouts on any click or Escape outside of them.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (notifPopRef.current && !notifPopRef.current.contains(event.target as Node)) setShowNotifs(false);
      if (seasonPopRef.current && !seasonPopRef.current.contains(event.target as Node)) setShowSeasonCal(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowNotifs(false);
        setShowSeasonCal(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    void api.myWarnings().then((res) => setWarnings(res.warnings.filter((w) => !w.acknowledgedAt) as never)).catch(() => {});
    let disposed = false;
    let requestVersion = 0;
    const loadNotifications = async () => {
      const version = ++requestVersion;
      try {
        const res = await api.listNotifications(20);
        // Several match events can invalidate the inbox in quick succession.
        // Do not let a slower response from an older request overwrite the
        // newer, correctly ordered feed.
        if (!disposed && version === requestVersion) setNotifications(res.notifications as never);
      } catch {}
    };
    void loadNotifications();
    const unsubscribe = api.cache.subscribe((scope) => {
      if (scope === "notifications") void loadNotifications();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [user]);

  const logout = async () => {
    await api.logout();
    setUser(null);
    clear();
    navigate("/login");
  };

  const inMatch = location.pathname === "/live-match" || location.pathname === "/season-end";
  const showMatchShortcut = isMobile && snapshot && !inMatch && location.pathname !== "/dashboard" && liveMatchId;

  const goToMatch = () => {
    void checkLiveMatch().then((id) => {
      if (id) navigate("/live-match");
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
          <NavLink
            to="/dashboard"
            className="logo"
            style={{ textDecoration: "none" }}
            onClick={(event) => {
              if (teamCreationRequired) event.preventDefault();
            }}
            aria-disabled={teamCreationRequired}
          >
          <img src="/footmania-logo.svg" alt="" className="logo-img" />
          {strings.app.name}
        </NavLink>

        {!isMobile && (
          <nav className="top-nav">
            {adminNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => (isActive ? "active" : "") + (item.admin ? " admin" : "")}
                onClick={(event) => {
                  if (navLockedFor(item.to)) event.preventDefault();
                }}
                aria-disabled={navLockedFor(item.to)}
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="top-right">
          {status?.season && (
            <div className="top-pop-wrap" ref={seasonPopRef}>
              <button
                type="button"
                className="day-chip as-button"
                onClick={() => setShowSeasonCal((v) => !v)}
                title={`Season ${status.season.seasonNumber} · round ${status.season.completedRounds}`}
                aria-expanded={showSeasonCal}
              >
                <CalendarDays size={13} />
                <b>Season {status.season.seasonNumber}</b>
                {status.season.joinState === "OPEN" ? " · open" : " · locked"}
              </button>
              {showSeasonCal && (
                <div className="popout season-popout">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 14 }}>
                    <h3 style={{ margin: 0 }}>Season {status.season.seasonNumber}</h3>
                    <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
                      Day {status.season.seasonDay} / {status.season.seasonDays} · round {status.season.completedRounds}
                    </span>
                  </div>
                  <SeasonCalendar days={status.calendar.days} today={status.calendar.today} matches={status.myMatches} />
                </div>
              )}
            </div>
          )}
          {user && (
            <span className="chip" title={user.name} style={user.isPro ? { borderColor: "var(--gold-2)", color: "var(--gold-2)" } : undefined}>
              {user.isPro ? "PRO" : "REG"} {user.isAdmin && "· ADMIN"} · {user.name}
            </span>
          )}
          <div className="top-pop-wrap" ref={notifPopRef}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowNotifs((v) => !v)}
              title="Notifications"
              aria-label="Notifications"
              aria-expanded={showNotifs}
              style={{ position: "relative" }}
            >
              <Bell size={15} />
              {notifications.filter((n) => !n.readAt).length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 8, height: 8, borderRadius: 999, background: "var(--red-2)", border: "1px solid white" }} />}
            </button>
            {showNotifs && (
              <div className="popout notif-popout">
                <div className="notif-head">
                  <h3>
                    Notifications
                    {notifications.some((n) => !n.readAt) && <span className="chip">{notifications.filter((n) => !n.readAt).length} new</span>}
                  </h3>
                  <button
                    className="btn ghost btn-xs"
                    disabled={!notifications.some((n) => !n.readAt)}
                    onClick={() => void api.markAllNotificationsRead().then(() => setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))))}
                  >
                    Mark all read
                  </button>
                </div>
                {notifications.length === 0 ? (
                  <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No notifications. Match kick-offs and results appear here; <b>Pro</b> also gets goal pings and league digests.</div>
                ) : (
                  <div className="notif-list">
                    {notifications.slice(0, 20).map((n) => {
                      const { title, detail } = describeNotification(n, matchByFixture);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          className={"notif-row" + (n.readAt ? "" : " unread")}
                          disabled={Boolean(n.readAt)}
                          title={n.readAt ? undefined : "Mark as read"}
                          onClick={() => void api.markNotificationRead(n.id).then(() => setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)))}
                        >
                          <span className="notif-dot" aria-hidden />
                          <span className="notif-body">
                            <span className="notif-title">{title}</span>
                            {detail && <span className="notif-detail">{detail}</span>}
                          </span>
                          <span className="notif-time" title={new Date(n.createdAt).toLocaleString()}>{relativeTime(n.createdAt)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div style={{ marginTop: 10, color: "var(--text-3)", fontSize: "0.75rem" }}>Push notifications: enable browser notifications in Settings to receive pushes when the tab is closed (Pro goal pings require Pro).</div>
              </div>
            )}
          </div>
          {club && (
            <span className="club-chip" onClick={() => navigate(`/team/${club.id}`)} title={`${club.name} — team profile`}>
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

      {status?.paused && (
        <div className="card" style={{ margin: "12px auto", maxWidth: 960, borderColor: "rgba(240,180,41,0.55)", background: "rgba(240,180,41,0.08)", display: "flex", alignItems: "center", gap: 10 }}>
          <Hourglass size={16} style={{ color: "var(--gold-2)", flexShrink: 0 }} />
          <div>
            <b>Season paused</b>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>
              An administrator has frozen the world clock. Matches, transfers, loans and contracts are on hold; tactics and squad management stay available.
            </div>
          </div>
        </div>
      )}
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
      <main className="content animate-in">
        {children}
      </main>

      {isMobile && (
        <nav className="bottom-bar" aria-label="Primary">
          {adminNav.filter((n) => n.to !== "/competitions").map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
              onClick={(event) => {
                if (navLockedFor(item.to)) event.preventDefault();
              }}
              aria-disabled={navLockedFor(item.to)}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}

      {showMatchShortcut && (
        <button
          className="fab"
          onClick={goToMatch}
          title={strings.dashboard.goToMatch}
          aria-label={strings.dashboard.goToMatch}
        >
          <Radio size={22} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
