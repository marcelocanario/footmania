import { useEffect, useRef, useState } from "react";
import { Toast } from "primereact/toast";
import { CalendarClock, CalendarRange, Gauge, RefreshCw, ScrollText, Trophy, Users } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { Segmented } from "../components/Segmented";
import { useAdminFetch } from "./admin/adminShared";
import { OverviewTab } from "./admin/OverviewTab";
import { EventsTab } from "./admin/EventsTab";
import { MatchesAuctionsTab } from "./admin/MatchesAuctionsTab";
import { SeasonTab } from "./admin/SeasonTab";
import { UsersTab } from "./admin/UsersTab";
import { AuditTab } from "./admin/AuditTab";

type TabId = "overview" | "events" | "liveops" | "season" | "users" | "audit";

export function Admin() {
  const { user } = useGame();
  const toast = useRef<Toast>(null);
  const [tab, setTab] = useState<TabId>("overview");
  // Bumped by manual refresh / window focus so the mounted tab refetches.
  const [version, setVersion] = useState(0);
  const [eventStatusPreset, setEventStatusPreset] = useState<string | null>(null);
  const lastFocusRefresh = useRef(0);

  const clock = useAdminFetch(() => api.adminSchedulerClock().then((r) => r.clock), [version]);

  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastFocusRefresh.current < 15000) return;
      lastFocusRefresh.current = Date.now();
      setVersion((v) => v + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const notify = (severity: "success" | "error" | "warn" | "info", summary: string, detail?: string) =>
    toast.current?.show({ severity, summary, detail });

  if (!user?.isAdmin) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        Admins only
      </div>
    );
  }

  const clockData = clock.data;
  const eventBadge = clockData ? clockData.pendingEvents + clockData.failedEvents : undefined;

  const jumpToFailedEvents = () => {
    setEventStatusPreset("FAILED");
    setTab("events");
  };

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
      <div className="page-head">
        <div>
          <div className="kicker">Admin</div>
          <h1>World control</h1>
        </div>
        <Segmented<TabId>
          value={tab}
          onChange={(next) => {
            if (next !== "events") setEventStatusPreset(null);
            setTab(next);
          }}
          items={[
            { value: "overview", label: "Overview", icon: <Gauge size={14} /> },
            { value: "events", label: "Events", icon: <CalendarClock size={14} />, count: eventBadge },
            { value: "liveops", label: "Matches & Auctions", icon: <Trophy size={14} /> },
            { value: "season", label: "Season", icon: <CalendarRange size={14} /> },
            { value: "users", label: "Users", icon: <Users size={14} /> },
            { value: "audit", label: "Audit", icon: <ScrollText size={14} /> },
          ]}
        />
      </div>

      {clock.error && (
        <div className="card" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b", marginBottom: 12 }}>
          Scheduler unavailable: {clock.error}
        </div>
      )}

      {clockData && clockData.health !== "HEALTHY" && tab !== "overview" && tab !== "events" && (
        <button
          className="card hoverable"
          onClick={jumpToFailedEvents}
          style={{
            width: "100%",
            textAlign: "left",
            marginBottom: 12,
            padding: "10px 16px",
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: clockData.health === "OVERDUE" ? "var(--gold-2)" : "#ff6b6b",
          }}
        >
          <CalendarClock size={15} />
          <span>
            Scheduler attention needed{clockData.failedEvents > 0 ? ` — ${clockData.failedEvents} failed event(s)` : clockData.overdueEvents > 0 ? ` — ${clockData.overdueEvents} overdue event(s)` : ""}. Click to inspect.
          </span>
        </button>
      )}

      {tab === "overview" && <OverviewTab version={version} notify={notify} />}
      {tab === "events" && <EventsTab key={eventStatusPreset ?? "all"} version={version} notify={notify} statusPreset={eventStatusPreset} />}
      {tab === "liveops" && <MatchesAuctionsTab version={version} notify={notify} />}
      {tab === "season" && <SeasonTab version={version} notify={notify} />}
      {tab === "users" && <UsersTab version={version} notify={notify} />}
      {tab === "audit" && <AuditTab version={version} notify={notify} />}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn ghost" disabled={clock.loading} onClick={() => setVersion((v) => v + 1)}>
          <RefreshCw size={14} /> Refresh all
        </button>
      </div>
    </div>
  );
}
