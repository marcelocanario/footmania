import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Users, Table2, ArrowLeftRight, Wallet, CalendarDays, LogOut, Home, ShieldCheck, Radio, History as HistoryIcon, Shirt, Bell, Languages, Settings as SettingsIcon, UserPlus, Hourglass, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGame } from "../store/game";
import { useLang } from "../i18n/store";
import { relativeTime } from "../utils/time";
import { api } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLiveMatchWatcher } from "../hooks/useLiveMatchWatcher";
import { FootballKit } from "./kit/FootballKit";
import { deriveKitDefaults } from "./kit/defaults";
import { LanguagePicker } from "./LanguagePicker";

interface NavItem {
  to: string;
  key: "nav.home" | "nav.squad" | "nav.tables" | "nav.transfers" | "nav.finances" | "nav.myClub" | "nav.history" | "nav.friends" | "nav.settings" | "nav.admin";
  icon: ReactNode;
  admin?: boolean;
}

const NAV: NavItem[] = [
  { to: "/dashboard", key: "nav.home", icon: <Home size={15} /> },
  { to: "/squad", key: "nav.squad", icon: <Users size={15} /> },
  { to: "/competitions", key: "nav.tables", icon: <Table2 size={15} /> },
  { to: "/transfers", key: "nav.transfers", icon: <ArrowLeftRight size={15} /> },
  { to: "/finances", key: "nav.finances", icon: <Wallet size={15} /> },
  { to: "/my-club", key: "nav.myClub", icon: <Shirt size={15} /> },
  { to: "/history", key: "nav.history", icon: <HistoryIcon size={15} /> },
  { to: "/friends", key: "nav.friends", icon: <UserPlus size={15} /> },
  { to: "/settings", key: "nav.settings", icon: <SettingsIcon size={15} /> },
];

// The mobile bottom bar has room for only four persistent destinations plus
// a "More" trigger; every other NAV entry (including Admin, when present)
// moves into the sheet the trigger opens. Keep this list in sync with NAV
// above — it exists only to pick the four out of the full set, not to
// duplicate their icons/routes.
const PRIMARY_TO = ["/dashboard", "/squad", "/competitions", "/transfers"];

// Full nav labels ("Transfers", and its longer fr/pt-BR equivalents) do not
// fit a ~70px bottom-bar slot at any legible size; the primary four use the
// dedicated navShort.* catalog entries instead. A switch (rather than a
// runtime "nav." -> "navShort." string rewrite) keeps every call type-checked
// against the real i18next resource keys.
function primaryShortKey(to: string): "navShort.home" | "navShort.squad" | "navShort.tables" | "navShort.transfers" {
  switch (to) {
    case "/squad": return "navShort.squad";
    case "/competitions": return "navShort.tables";
    case "/transfers": return "navShort.transfers";
    default: return "navShort.home";
  }
}

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

/** Human-readable copy for a stored notification. Falls back gracefully for
 * legacy payloads that predate embedded club names. */
function describeNotification(t: (k: string, o?: Record<string, unknown>) => string, n: NotificationItem, matchByFixture: Map<number, MyMatch>): { title: string; detail: string } {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof p[key] === "string" && p[key] ? p[key] as string : null);
  const num = (key: string): number | null => (typeof p[key] === "number" ? p[key] as number : null);

  let home = str("homeName");
  let away = str("awayName");
  // Legacy payloads carry only IDs: resolve through this season's fixture list.
  if ((!home || !away) && typeof p.fixtureId === "number") {
    const m = matchByFixture.get(p.fixtureId);
    if (m && !home && !away) {
      home = m.isHome ? t("layout.you") : m.opponent;
      away = m.isHome ? m.opponent : t("layout.you");
    }
  }

  switch (n.type) {
    case "MATCH_STARTED": {
      const teams = home && away ? t("notification.kickoff.teams", { home, away }) : t("notification.kickoff.matchStarted");
      const comp = str("competitionName");
      return { title: t("notification.kickoff.title"), detail: comp ? t("notification.kickoff.withComp", { teams, comp }) : teams };
    }
    case "MATCH_FINISHED": {
      const hs = num("homeScore");
      const as = num("awayScore");
      const clubId = num("clubId");
      if (hs !== null && as !== null && home && away && clubId !== null) {
        const userIsHome = clubId === num("homeClubId");
        const gf = userIsHome ? hs : as;
        const ga = userIsHome ? as : hs;
        const outcome = gf > ga ? "notification.fulltime.won" : gf === ga ? "notification.fulltime.draw" : "notification.fulltime.lost";
        return { title: t(outcome), detail: t("notification.fulltime.score", { home, homeScore: hs, awayScore: as, away }) };
      }
      if (hs !== null && as !== null && home && away) return { title: t("notification.fulltime.title"), detail: t("notification.fulltime.score", { home, homeScore: hs, awayScore: as, away }) };
      return { title: t("notification.fulltime.title"), detail: home && away ? t("notification.fulltime.teams", { home, away }) : t("notification.fulltime.matchFinished") };
    }
    case "MATCH_GOAL": {
      const minute = num("minute");
      const scores = Array.isArray(p.scores) && p.scores.length >= 2 && typeof p.scores[0] === "number" ? `${p.scores[0]}-${p.scores[1]}` : null;
      const scorer = str("scoringName");
      const parts = [minute !== null ? `${minute}'` : null, scorer, scores].filter(Boolean);
      return { title: t("notification.goal.title"), detail: parts.join(" · ") || t("notification.goal.detail") };
    }
    case "LEAGUE_RESULTS":
      return { title: t("notification.league.title"), detail: t("notification.league.detail") };
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
  const { t } = useTranslation();
  const lang = useLang((s) => s.lang);
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
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [warnings, setWarnings] = useState<{ id: number; reason: string; createdAt: string }[]>([]);
  const notifPopRef = useRef<HTMLDivElement>(null);
  const seasonPopRef = useRef<HTMLDivElement>(null);
  const langPopRef = useRef<HTMLDivElement>(null);
  const morePopRef = useRef<HTMLDivElement>(null);
  // Fixture-id lookup used to render friendly copy for legacy notification
  // payloads that only carry club/fixture IDs.
  const matchByFixture = new Map((status?.myMatches ?? []).map((m) => [m.fixtureId, m]));

  const adminNav: NavItem[] = user?.isAdmin
    ? [...NAV, { to: "/admin", key: "nav.admin", icon: <ShieldCheck size={15} />, admin: true }]
    : NAV;
  // Everything the bottom bar's "More" sheet lists: every adminNav entry that
  // is not one of the four persistent slots, in the same order as NAV.
  const moreNav = adminNav.filter((n) => !PRIMARY_TO.includes(n.to));
  // Highlight the "More" trigger itself when the current route lives inside
  // the sheet — otherwise(finances, my-club, …) the bar would show no active
  // slot at all. Prefix match covers nested routes (e.g. /team/:id is not in
  // the sheet, so it correctly leaves the trigger dim).
  const moreActive = moreNav.some((n) => location.pathname === n.to || location.pathname.startsWith(`${n.to}/`));

  // Close anchored topbar popouts (and the bottom-bar "More" sheet) on any
  // click or Escape outside of them.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (notifPopRef.current && !notifPopRef.current.contains(event.target as Node)) setShowNotifs(false);
      if (seasonPopRef.current && !seasonPopRef.current.contains(event.target as Node)) setShowSeasonCal(false);
      if (langPopRef.current && !langPopRef.current.contains(event.target as Node)) setShowLangPicker(false);
      if (morePopRef.current && !morePopRef.current.contains(event.target as Node)) setShowMore(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowNotifs(false);
        setShowSeasonCal(false);
        setShowLangPicker(false);
        setShowMore(false);
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
          {t("app.name")}
          <sup className="logo-alpha">ALPHA</sup>
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
                {t(item.key)}
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
                title={`${t("common.season")} ${status.season.seasonNumber} · ${t("common.round")} ${status.season.completedRounds}`}
                aria-expanded={showSeasonCal}
              >
                <CalendarDays size={13} />
                <b>{t("common.season")} {status.season.seasonNumber}</b>
                {status.season.joinState === "OPEN" ? ` · ${t("layout.seasonOpen")}` : ` · ${t("layout.seasonLocked")}`}
              </button>
              {showSeasonCal && (
                <div className="popout season-popout">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 14 }}>
                    <h3 style={{ margin: 0 }}>{t("common.season")} {status.season.seasonNumber}</h3>
                    <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
                      {t("layout.dayOfSeason", { day: status.season.seasonDay, days: status.season.seasonDays, round: status.season.completedRounds })}
                    </span>
                  </div>
                  <SeasonCalendar days={status.calendar.days} today={status.calendar.today} matches={status.myMatches} />
                </div>
              )}
            </div>
          )}
          {user && (
            <span
              className={`chip account-chip${user.isAdmin || user.isPro ? " elevated" : ""}`}
              title={user.name}
              style={user.isAdmin || user.isPro ? { borderColor: "var(--gold-2)", color: "var(--gold-2)" } : undefined}
            >
              {user.isAdmin ? t("layout.roleAdmin") : user.isPro ? t("layout.rolePro") : t("layout.roleFree")}
            </span>
          )}
          <div className="top-pop-wrap" ref={langPopRef}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowLangPicker((v) => !v)}
              title={t("settings.language")}
              aria-label={t("settings.language")}
              aria-expanded={showLangPicker}
            >
              <Languages size={15} />
            </button>
            {showLangPicker && (
              <div className="popout lang-popout">
                <LanguagePicker compact />
              </div>
            )}
          </div>
          <div className="top-pop-wrap" ref={notifPopRef}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowNotifs((v) => !v)}
              title={t("common.notifications")}
              aria-label={t("common.notifications")}
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
                    {t("common.notifications")}
                    {notifications.some((n) => !n.readAt) && <span className="chip">{notifications.filter((n) => !n.readAt).length} {t("common.new")}</span>}
                  </h3>
                  <button
                    className="btn ghost btn-xs"
                    disabled={!notifications.some((n) => !n.readAt)}
                    onClick={() => void api.markAllNotificationsRead().then(() => setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))))}
                  >
                    {t("common.markAllRead")}
                  </button>
                </div>
                {notifications.length === 0 ? (
                  <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{t("common.noNotifications")}</div>
                ) : (
                  <div className="notif-list">
                    {notifications.slice(0, 20).map((n) => {
                      const { title, detail } = describeNotification(t as unknown as (k: string, o?: Record<string, unknown>) => string, n, matchByFixture);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          className={"notif-row" + (n.readAt ? "" : " unread")}
                          disabled={Boolean(n.readAt)}
                          title={n.readAt ? undefined : t("layout.markAsRead")}
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
                <div style={{ marginTop: 10, color: "var(--text-3)", fontSize: "0.75rem" }}>{t("layout.pushHint")}</div>
              </div>
            )}
          </div>
          {club && (
            <span className="club-chip" onClick={() => navigate(`/team/${club.id}`)} title={`${club.name} — ${t("layout.teamProfile")}`}>
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
          <button className="icon-btn" onClick={logout} title={t("auth.logout")} aria-label={t("auth.logout")}>
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {status?.paused && (
        <div className="card" style={{ margin: "12px auto", maxWidth: 960, borderColor: "rgba(240,180,41,0.55)", background: "rgba(240,180,41,0.08)", display: "flex", alignItems: "center", gap: 10 }}>
          <Hourglass size={16} style={{ color: "var(--gold-2)", flexShrink: 0 }} />
          <div>
            <b>{t("layout.seasonPaused")}</b>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>
              {t("layout.seasonPausedDescription")}
            </div>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="card" style={{ margin: "12px auto", maxWidth: 960, borderColor: "var(--red-2)", background: "rgba(220,60,60,0.08)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>{t("layout.moderationNotice")}</div>
          {warnings.map((w) => (
            <div key={w.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: "0.88rem" }}>{w.reason}</span>
              <button className="btn ghost" onClick={() => void api.ackWarning(w.id).then(() => setWarnings((prev) => prev.filter((x) => x.id !== w.id)))}>{t("layout.acknowledge")}</button>
            </div>
          ))}
        </div>
      )}
      <main key={lang} className="content animate-in">
        {children}
      </main>

      {isMobile && (
        <nav className="bottom-bar" aria-label={t("layout.primaryNavigation")}>
          {adminNav.filter((n) => PRIMARY_TO.includes(n.to)).map((item) => (
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
              {t(primaryShortKey(item.to))}
            </NavLink>
          ))}
          <div className="bottom-sheet-wrap" ref={morePopRef}>
            <button
              type="button"
              className={`bottom-sheet-trigger${showMore || moreActive ? " active" : ""}`}
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              aria-haspopup="menu"
            >
              <MoreHorizontal size={15} />
              {t("navShort.more")}
            </button>
            {showMore && (
              <div className="bottom-sheet" role="menu">
                {moreNav.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    role="menuitem"
                    className={({ isActive }) => (isActive ? "active" : "") + (item.admin ? " admin" : "")}
                    onClick={(event) => {
                      if (navLockedFor(item.to)) {
                        event.preventDefault();
                        return;
                      }
                      setShowMore(false);
                    }}
                    aria-disabled={navLockedFor(item.to)}
                  >
                    {item.icon}
                    {t(item.key)}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        </nav>
      )}

      {showMatchShortcut && (
        <button
          className="fab"
          onClick={goToMatch}
          title={t("dashboard.goToMatch")}
          aria-label={t("dashboard.goToMatch")}
        >
          <Radio size={22} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
