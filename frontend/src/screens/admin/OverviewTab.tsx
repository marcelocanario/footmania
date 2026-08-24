import { useState } from "react";
import { CalendarClock, Clock, FastForward, Gauge, Pause, Play, RefreshCw, ScrollText, Trash2, Undo2, CalendarX } from "lucide-react";
import { api, type SchedulerClockView } from "../../api/client";
import { AdminCard, useAdminFetch, type AdminFetchResult, type TabProps } from "./adminShared";
import { StatusChip, type ChipTone } from "./StatusChip";
import { relativeTime } from "./adminTime";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

interface WorldStatus {
  seasonKey: string;
  seasonStatus: string;
  completedRounds: number;
  joinState: string;
  joinLockRound: number;
  manualRound: number | null;
  realCompletedRounds: number;
  roundsPerSeason: number;
  divisionCount: number;
  clubCount: number;
  humanClubCount: number;
  liveMatchCount: number;
}

const HEALTH_META: Record<string, { label: string; tone: ChipTone; hint: string }> = {
  HEALTHY: { label: "Healthy", tone: "done", hint: "All due events are processed and nothing failed." },
  OVERDUE: { label: "Overdue events", tone: "running", hint: "Some real-time events passed their deadline without running. Use “Scan due events” to catch up." },
  FAILED_EVENTS: { label: "Failed events", tone: "failed", hint: "One or more events failed after retries. Inspect them on the Events tab." },
  SCHEDULER_REQUIRES_ADMIN_REVIEW: { label: "Admin review required", tone: "failed", hint: "A review flag was raised — inspect failed events before advancing the clock." },
};

export function OverviewTab({ version, notify, clock }: TabProps & { clock: AdminFetchResult<SchedulerClockView> }) {
  const world = useAdminFetch(() => api.adminStatus().then((r) => r.world as WorldStatus), [version]);
  const [advanceDays, setAdvanceDays] = useState(1);
  const [reason, setReason] = useState("");
  const [targetRound, setTargetRound] = useState(14);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const runAction = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      notify("success", done);
      world.reload();
      clock.reload();
    } catch (e) {
      notify("error", "Action failed", (e as Error).message);
    }
  };

  const w = world.data;
  const c: SchedulerClockView | null = clock.data;
  const health = c ? HEALTH_META[c.health] ?? { label: c.health, tone: "failed" as ChipTone, hint: "" } : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

      {health && c && (
        <div
          className="card"
          style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            borderColor: health.tone === "failed" ? "rgba(255,99,99,0.5)" : health.tone === "running" ? "rgba(240,180,41,0.5)" : "rgba(61,220,132,0.4)",
          }}
        >
          <Gauge size={18} style={{ color: health.tone === "failed" ? "#ff6b6b" : health.tone === "running" ? "var(--gold-2)" : "var(--grass-2)" }} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 700 }}>{health.label}</div>
            <div style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>{health.hint}</div>
          </div>
          {(c.failedEvents > 0 || c.overdueEvents > 0 || c.pendingEvents > 0) && (
            <div style={{ display: "flex", gap: 6 }}>
              <StatusChip label={`${c.pendingEvents} pending`} tone="info" />
              {c.overdueEvents > 0 && <StatusChip label={`${c.overdueEvents} overdue`} tone="running" />}
              {c.failedEvents > 0 && <StatusChip label={`${c.failedEvents} failed`} tone="failed" />}
            </div>
          )}
        </div>
      )}

      {w && (
        <div className="stats-row">
          <div className="stat">
            <div className="label">Season</div>
            <div className="value">{w.seasonKey}</div>
            <div className="hint">{w.seasonStatus}</div>
          </div>
          <div className="stat">
            <div className="label">Rounds</div>
            <div className="value">{w.completedRounds}<span style={{ color: "var(--text-3)", fontSize: "1rem" }}> / {w.roundsPerSeason}</span></div>
            <div className="hint">join lock at round {w.joinLockRound}</div>
          </div>
          <div className="stat">
            <div className="label">Join state</div>
            <div className="value">{w.joinState}</div>
            <div className="hint">{w.manualRound !== null ? `manual mode: round ${w.manualRound}` : "manual mode off"}</div>
          </div>
          <div className="stat">
            <div className="label">World</div>
            <div className="value">{w.humanClubCount} human{w.humanClubCount === 1 ? "" : "s"}</div>
            <div className="hint">{w.clubCount} clubs · {w.divisionCount} divisions · {w.liveMatchCount} live</div>
          </div>
        </div>
      )}

      {c && (
        <AdminCard icon={<Clock size={17} />} title="World clock" subtitle={`Where the multiplayer world is right now — every club shares this clock.`}>
          <div className="stats-row" style={{ marginBottom: 14 }}>
            <div className="stat">
              <div className="label">Season day</div>
              <div className="value">{c.seasonDay} / {c.seasonDays}</div>
              <div className="hint"><StatusChip label={c.phase === "ACTIVE" ? "Season active" : c.phase === "POST_MATCH" ? "Post-match buffer" : "Inter-season"} tone={c.phase === "ACTIVE" ? "done" : c.phase === "POST_MATCH" ? "running" : "info"} /></div>
            </div>
            <div className="stat">
              <div className="label">Absolute day</div>
              <div className="value">{c.absoluteGameDay + 1}</div>
              <div className="hint">season {c.seasonNumber}</div>
            </div>
            <div className="stat">
              <div className="label">Next automatic advance</div>
              <div className="value" style={{ fontSize: "1.05rem" }}>{c.nextAutomaticDayAdvance ? relativeTime(c.nextAutomaticDayAdvance) : "paused"}</div>
              <div className="hint">{c.nextAutomaticDayAdvance ? new Date(c.nextAutomaticDayAdvance).toLocaleString() : "no day-advance event scheduled"}</div>
            </div>
            <div className="stat">
              <div className="label">Last advanced</div>
              <div className="value" style={{ fontSize: "1.05rem" }}>{relativeTime(c.lastAdvancedAt)}</div>
              <div className="hint">{new Date(c.lastAdvancedAt).toLocaleString()}</div>
            </div>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: "0.8rem", lineHeight: 1.6 }}>
            Inter-season starts day {c.interseasonStartIndex + 1} · preparation window opens day {c.preparationStartIndex + 1} ({c.interseasonBeforeNextSeasonDays}d) · post-match buffer {c.interseasonAfterMatchDays}d
            {c.oldestOverdueSeconds > 0 && <> · oldest overdue event is {relativeTime(Date.now() - c.oldestOverdueSeconds * 1000)}</>}
          </div>

          <div style={{ borderTop: "1px solid var(--line)", margin: "16px 0 14px" }} />
          <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginBottom: 10 }}>Manual controls — each action is written to the audit log.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {c.paused ? (
              <button className="btn gold" onClick={() => void runAction(() => api.adminSchedulerResume(reason || undefined), "Season resumed — timers shifted by the paused interval")}>
                <Play size={15} /> Resume season
              </button>
            ) : (
              <button className="btn gold" onClick={() => void runAction(() => api.adminSchedulerPause(reason || undefined), "Season paused — world clock frozen")}>
                <Pause size={15} /> Pause season
              </button>
            )}
            <button className="btn gold" disabled={c.paused} onClick={() => void runAction(() => api.adminSchedulerAdvanceDay(reason || undefined), "Game day advanced")}>
              <FastForward size={15} /> Advance day
            </button>
            <input
              type="number"
              min={1}
              max={c.seasonDays}
              value={advanceDays}
              onChange={(e) => setAdvanceDays(Math.max(1, Math.min(c.seasonDays, Number(e.target.value) || 1)))}
              aria-label="Days to advance"
              style={{ width: 70, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
            />
            <button className="btn" disabled={c.paused} onClick={() => void runAction(() => api.adminSchedulerAdvanceMany(advanceDays, reason || undefined), `${advanceDays} game day(s) advanced`)}>
              Advance many
            </button>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional audit reason"
              aria-label="Audit reason for manual controls"
              style={{ flex: "1 1 190px", minWidth: 160, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
            />
            <button className="btn" disabled={c.paused} onClick={() => void runAction(() => api.adminSchedulerScan().then((r) => notify("success", `${r.executed} due event(s) executed`)), "Scan complete")}>
              <RefreshCw size={15} /> Scan due events
            </button>
            <button
              className="btn ghost danger"
              disabled={c.paused}
              onClick={() =>
                setConfirm({
                  title: "Force advance",
                  danger: true,
                  message: "Force advance bypasses the normal day pipeline and re-runs mandatory events. Only use this when the scheduler is stuck.",
                  confirmLabel: "Force advance",
                  minReasonLength: 10,
                  reasonHint: "Why is the scheduler stuck? (min 10 characters)",
                  onConfirm: async (r) => {
                    await api.adminSchedulerForceAdvance(r);
                    notify("success", "Force advance completed");
                    world.reload();
                    clock.reload();
                  },
                })
              }
            >
              Force advance…
            </button>
          </div>
          {c.paused && (
            <div style={{ color: "var(--gold-2)", fontSize: "0.8rem", marginTop: 10 }}>
              Season is paused since {new Date(c.pausedAt ?? Date.now()).toLocaleString()}. Resuming shifts every deadline, kickoff and live-match clock by the frozen interval — nothing expires while paused.
            </div>
          )}
        </AdminCard>
      )}

      <AdminCard
        icon={<CalendarX size={17} />}
        title="Season maintenance"
        subtitle="Schedule regeneration before the first kickoff and the full world reset. Both are audited."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="btn"
            onClick={() =>
              setConfirm({
                title: "Recalculate fixtures",
                message: "Regenerates every current-season division schedule from the untouched standings. Kickoffs are re-timed; standings and results are unchanged. Only possible before any match of the season has been played.",
                confirmLabel: "Recalculate fixtures",
                minReasonLength: 10,
                reasonHint: "Why is the schedule being regenerated? (min 10 characters)",
                onConfirm: async (r) => {
                  const res = await api.adminRecalculateFixtures(r);
                  notify("success", `Fixtures recalculated (${res.fixturesAfter} across ${res.divisions} divisions)`);
                  world.reload();
                  clock.reload();
                },
              })
            }
          >
            <CalendarX size={15} /> Recalculate fixtures…
          </button>
          <button
            className="btn ghost danger"
            onClick={() =>
              setConfirm({
                title: "Reset the world",
                danger: true,
                message: "Destroys EVERYTHING: clubs, squads, matches, history, markets, notifications. User accounts, friendships, bans and settings are kept. Every player must recreate a club via Join. This cannot be undone.",
                confirmLabel: "Reset world",
                confirmWord: "RESET",
                minReasonLength: 10,
                reasonHint: "Why is the world being reset? (min 10 characters)",
                onConfirm: async (r) => {
                  await api.adminWorldReset("RESET", r);
                  notify("success", "World reset — a fresh season has started");
                  world.reload();
                  clock.reload();
                },
              })
            }
          >
            <Trash2 size={15} /> Reset world…
          </button>
        </div>
      </AdminCard>

      <AdminCard
        icon={<CalendarClock size={17} />}
        title="Manual round mode"
        subtitle={
          <>
            Instantly simulate every division through a chosen round. While manual mode is active the real schedule is paused and the manual round is authoritative — clear it to resume the durable scheduler.
          </>
        }
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={w?.roundsPerSeason ?? 14}
            value={targetRound}
            onChange={(e) => setTargetRound(Math.max(1, Math.min(w?.roundsPerSeason ?? 14, Number(e.target.value) || 1)))}
            aria-label="Target round"
            style={{ width: 90, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
          />
          <button className="btn gold" disabled={Boolean(c?.paused)} onClick={() => void runAction(() => api.adminAdvanceRound(targetRound), `Advanced to round ${targetRound}`)}>
            <FastForward size={15} /> Advance to round
          </button>
          <button className="btn" disabled={Boolean(c?.paused)} onClick={() => void runAction(() => api.adminSetRound(targetRound), `Manual round set to ${targetRound}`)}>
            Set manual round
          </button>
          <button className="btn" disabled={Boolean(c?.paused)} onClick={() => void runAction(() => api.adminClearManual(), "Manual mode cleared — real schedule resumed")}>
            <Undo2 size={15} /> Clear manual mode
          </button>
          <button
            className="btn ghost danger"
            disabled={Boolean(c?.paused)}
            onClick={() =>
              setConfirm({
                title: "Force season rollover",
                danger: true,
                message: "Runs the full rollover workflow now (archive, promotion/relegation, fixtures, budgets). Completed seasons are immutable — this cannot be undone.",
                confirmLabel: "Force rollover",
                minReasonLength: 10,
                onConfirm: async (r) => {
                  await api.adminSchedulerRollover(r);
                  notify("success", "Rollover forced");
                  world.reload();
                  clock.reload();
                },
              })
            }
          >
            <ScrollText size={15} /> Force rollover…
          </button>
        </div>
        {c?.paused && (
          <div style={{ color: "var(--gold-2)", fontSize: "0.8rem", marginTop: 10 }}>
            These controls are unavailable while the season is paused. Resume the season first.
          </div>
        )}
      </AdminCard>
    </div>
  );
}
