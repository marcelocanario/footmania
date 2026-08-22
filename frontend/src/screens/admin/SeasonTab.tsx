import { CalendarRange, Coins, Flag, Hourglass, Moon, RefreshCcw, Swords } from "lucide-react";
import { api } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { StatusChip } from "./StatusChip";

const PHASE_ORDER = ["ACTIVE", "POST_MATCH", "INTERSEASON"] as const;
const PHASE_TITLES: Record<(typeof PHASE_ORDER)[number], string> = {
  ACTIVE: "Regular season",
  POST_MATCH: "Post-match buffer",
  INTERSEASON: "Inter-season break",
};

function dayIcon(entry: { label: string; weeklySimulation: boolean }) {
  if (entry.label.startsWith("Round")) return <Swords size={13} style={{ color: "var(--gold-2)" }} />;
  if (entry.label === "Post-match buffer") return <Hourglass size={13} />;
  if (entry.label === "Rest") return <Moon size={13} />;
  if (entry.weeklySimulation) return <RefreshCcw size={13} />;
  return <CalendarRange size={13} />;
}

export function SeasonTab({ version }: TabProps) {
  const clock = useAdminFetch(() => api.adminSchedulerClock().then((r) => r.clock), [version]);
  const seasonId = clock.data?.seasonId;
  const preview = useAdminFetch(
    () => (seasonId !== undefined ? api.adminSchedulerPreview(seasonId).then((r) => r.season) : Promise.resolve([])),
    [version, seasonId]
  );

  const entries = preview.data ?? [];
  const currentDayIndex = clock.data?.seasonDayIndex ?? -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <AdminCard
        icon={<CalendarRange size={17} />}
        title="Season calendar"
        subtitle="The full schedule of the shared world clock for this season — match rounds, payroll boundaries, weekly simulations and the inter-season transition."
      >
        {clock.loading || preview.loading ? (
          <div className="empty-state" style={{ padding: 20 }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>No season is scheduled right now.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {PHASE_ORDER.map((phase) => {
              const days = entries.filter((entry) => entry.phase === phase);
              if (days.length === 0) return null;
              const phaseLive = phase === (currentDayIndex >= 0 ? entries[currentDayIndex]?.phase : null);
              return (
                <div key={phase}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>{PHASE_TITLES[phase]}</h3>
                    <StatusChip label={`${days.length} day${days.length === 1 ? "" : "s"}`} tone={phaseLive ? (phase === "ACTIVE" ? "done" : phase === "POST_MATCH" ? "running" : "info") : "neutral"} />
                    {phaseLive && <StatusChip label="current phase" tone="gold" />}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {days.map((entry) => {
                      const isToday = entry.seasonDayIndex === currentDayIndex;
                      const isPast = entry.seasonDayIndex < currentDayIndex;
                      return (
                        <div
                          key={entry.seasonDayIndex}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "7px 12px",
                            borderRadius: 8,
                            background: isToday ? "rgba(61,220,132,0.1)" : undefined,
                            border: isToday ? "1px solid rgba(61,220,132,0.35)" : "1px solid transparent",
                            opacity: isPast && !isToday ? 0.55 : 1,
                          }}
                        >
                          <span style={{ width: 44, color: "var(--text-3)", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums" }}>D{entry.seasonDay}</span>
                          {dayIcon(entry)}
                          <span style={{ flex: 1, fontWeight: entry.label.startsWith("Round") ? 600 : 400 }}>
                            {entry.label}
                            {isToday && <span className="flag-chip fc-accent" style={{ marginLeft: 8 }}>today</span>}
                          </span>
                          {entry.payroll && <StatusChip label={<Coins size={11} />} tone="gold" title="Payroll run at end of this day" />}
                          {entry.weeklySimulation && <StatusChip label="weekly" tone="info" title="Weekly simulation update at end of this day" />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div style={{ color: "var(--text-3)", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: 6 }}>
              <Flag size={12} /> Payroll and weekly markers fire at end of day. The clock only moves when every due event has run.
            </div>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
