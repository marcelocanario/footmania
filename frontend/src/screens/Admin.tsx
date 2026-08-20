import { useEffect, useState } from "react";
import { FastForward, RefreshCw, Undo2 } from "lucide-react";
import { api, type ScheduledEventView, type SchedulerAuctionView, type SchedulerAuditView, type SchedulerClockView, type SchedulerMatchView, type SchedulerPreviewEntry } from "../api/client";
import { useGame } from "../store/game";

interface AdminWorld {
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

export function Admin() {
  const { user } = useGame();
  const [world, setWorld] = useState<AdminWorld | null>(null);
  const [clock, setClock] = useState<SchedulerClockView | null>(null);
  const [events, setEvents] = useState<ScheduledEventView[]>([]);
  const [matches, setMatches] = useState<SchedulerMatchView[]>([]);
  const [auctions, setAuctions] = useState<SchedulerAuctionView[]>([]);
  const [audit, setAudit] = useState<SchedulerAuditView[]>([]);
  const [preview, setPreview] = useState<SchedulerPreviewEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState(14);
  const [advanceDays, setAdvanceDays] = useState(1);
  const [reason, setReason] = useState("");
  const [auctionExtensionMinutes, setAuctionExtensionMinutes] = useState(30);

  const refresh = async () => {
    setLoading(true);
    try {
      const [status, scheduler, scheduled, matchRows, auctionRows, auditRows] = await Promise.all([
        api.adminStatus(),
        api.adminSchedulerClock(),
        api.adminSchedulerEvents(),
        api.adminSchedulerMatches(),
        api.adminSchedulerAuctions(),
        api.adminSchedulerAudit(),
      ]);
      setWorld(status.world);
      setClock(scheduler.clock);
      setEvents(scheduled.events);
      setMatches(matchRows.matches);
      setAuctions(auctionRows.auctions);
      setAudit(auditRows.audit);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!clock) return;
    void api.adminSchedulerPreview(clock.seasonId).then((result) => setPreview(result.season)).catch(() => setPreview([]));
  }, [clock?.seasonId]);

  const run = async (action: () => Promise<unknown>) => {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.isAdmin) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        Admins only
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">Admin</div>
          <h1>Multiplayer Clock</h1>
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <span className="kicker" style={{ alignSelf: "center", marginRight: 8 }}>Scheduler sections</span>
        <a className="btn" href="#world-clock">World Clock</a>
        <a className="btn" href="#scheduled-events">Scheduled Events</a>
        <a className="btn" href="#scheduled-matches">Matches</a>
        <a className="btn" href="#scheduled-auctions">Auctions</a>
        <a className="btn" href="#season-preview">Season Preview</a>
        <a className="btn" href="#scheduler-audit">Audit</a>
      </div>

      {error && <div className="card" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b", marginBottom: 12 }}>{error}</div>}
      {message && <div className="card" style={{ borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)", marginBottom: 12 }}>{message}</div>}

      {world && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Season</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.seasonKey}</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>{world.seasonStatus}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Rounds</div>
             <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.completedRounds}<span style={{ color: "var(--text-3)", fontSize: "0.9rem" }}> / {world.roundsPerSeason}</span></div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>join lock at {world.joinLockRound}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">Join state</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.joinState}</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>manual: {world.manualRound ?? "off"}</div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="kicker">World</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>{world.humanClubCount} human</div>
            <div style={{ color: "var(--text-2)", fontSize: "0.85rem" }}>{world.clubCount} clubs · {world.divisionCount} divisions · {world.liveMatchCount} live</div>
          </div>
        </div>
      )}

      {clock && (
        <>
          <div id="world-clock" className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ marginBottom: 6 }}>Durable scheduler</h3>
                <div style={{ color: "var(--text-2)", fontSize: "0.9rem" }}>
                  Season {clock.seasonNumber}, Day {clock.seasonDay} / {clock.seasonDays} · {clock.phase}
                </div>
              </div>
              <div style={{ color: clock.health === "HEALTHY" ? "var(--grass-2)" : "#ff6b6b", fontWeight: 700 }}>
                {clock.health.replace("_", " ")}
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, margin: "16px 0" }}>
              <div><div className="kicker">Absolute day</div><strong>{clock.absoluteGameDay}</strong></div>
              <div><div className="kicker">Pending</div><strong>{clock.pendingEvents}</strong></div>
              <div><div className="kicker">Overdue</div><strong>{clock.overdueEvents}</strong></div>
              <div><div className="kicker">Failed</div><strong>{clock.failedEvents}</strong></div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn gold" disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerAdvanceDay(reason || undefined); setMessage("Game day advanced."); })}>
                <FastForward size={15} /> Advance day
              </button>
              <input
                type="number"
                min={1}
                max={35}
                value={advanceDays}
                onChange={(e) => setAdvanceDays(Math.max(1, Math.min(35, Number(e.target.value) || 1)))}
                style={{ width: 70, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
              />
              <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerAdvanceMany(advanceDays, reason || undefined); setMessage(`${advanceDays} game day(s) advanced.`); })}>
                Advance many
              </button>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for audit log"
                style={{ flex: "1 1 190px", minWidth: 160, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
              />
              <button className="btn" disabled={loading} onClick={() => void run(async () => { const result = await api.adminSchedulerScan(); setMessage(`${result.executed} due event(s) executed.`); })}>
                Scan due events
              </button>
              <button className="btn" disabled={loading || reason.trim().length < 10} onClick={() => void run(async () => { await api.adminSchedulerForceAdvance(reason.trim()); setMessage("Force advance completed."); })}>
                Force advance
              </button>
            </div>
            <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 10 }}>
              Last advance: {new Date(clock.lastAdvancedAt).toLocaleString()}
            </div>
          </div>

          <div id="scheduled-events" className="card" style={{ padding: 20, marginBottom: 16, overflowX: "auto" }}>
            <h3 style={{ marginBottom: 12 }}>Scheduled events</h3>
            <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ color: "var(--text-3)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>Due</th>
                  <th style={{ padding: "8px 6px" }}>Type</th>
                  <th style={{ padding: "8px 6px" }}>Phase</th>
                  <th style={{ padding: "8px 6px" }}>Status</th>
                  <th style={{ padding: "8px 6px" }}>Attempts</th>
                      <th style={{ padding: "8px 6px" }}>Entity</th>
                      <th style={{ padding: "8px 6px" }}>Error</th>
                      <th style={{ padding: "8px 6px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "9px 6px", whiteSpace: "nowrap" }}>{event.timeBasis === "REAL_TIME" ? (event.dueAt ? new Date(event.dueAt).toLocaleString() : "-") : `Day ${(event.dueAbsoluteGameDay ?? 0) + 1}`}</td>
                    <td style={{ padding: "9px 6px" }}>{event.type}</td>
                    <td style={{ padding: "9px 6px" }}>{event.phase ?? "-"}</td>
                    <td style={{ padding: "9px 6px" }}>{event.status}</td>
                    <td style={{ padding: "9px 6px" }}>{event.attempts}</td>
                    <td style={{ padding: "9px 6px" }}>{event.entityType ? `${event.entityType}:${event.entityId ?? ""}` : "-"}</td>
                    <td style={{ padding: "9px 6px", color: "#ff6b6b", maxWidth: 240 }}>{event.lastError ?? "-"}</td>
                    <td style={{ padding: "9px 6px", whiteSpace: "nowrap" }}>
                      {event.status === "PENDING" && <button className="btn" style={{ marginRight: 6 }} disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerExecuteEvent(event.id, reason || undefined); setMessage(`${event.type} executed.`); })}>Execute</button>}
                      {event.status === "FAILED" && <button className="btn" style={{ marginRight: 6 }} disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerRetryEvent(event.id); setMessage(`${event.type} queued for retry.`); })}>Retry</button>}
                      {event.status === "PENDING" && <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerCancelEvent(event.id); setMessage(`${event.type} cancelled.`); })}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length === 0 && <div className="empty-state" style={{ padding: 18 }}>No scheduled events.</div>}
          </div>
        </>
      )}

      <div className="card" style={{ maxWidth: 620, padding: 20 }}>
        <h3 style={{ marginBottom: 10 }}>Manual clock</h3>
        <div style={{ color: "var(--text-2)", marginBottom: 16, fontSize: "0.9rem" }}>
          Instantly simulate every division through the requested round. While manual mode is set, the real schedule is paused and the manual round is authoritative.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn gold" disabled={loading} onClick={() => void run(() => api.adminAdvanceRound(targetRound))}>
            <FastForward size={15} /> Advance to round
          </button>
          <input
            type="number"
            min={1}
             max={world?.roundsPerSeason ?? 14}
            value={targetRound}
            onChange={(e) => setTargetRound(Number(e.target.value))}
            style={{ width: 90, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
          />
          <button className="btn" disabled={loading} onClick={() => void run(() => api.adminSetRound(targetRound))}>
            Set manual round
          </button>
          <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminClearManual(); setMessage("Manual mode cleared — real schedule resumed."); })}>
            <Undo2 size={15} /> Clear manual
          </button>
           <button className="btn" disabled={loading || reason.trim().length < 10} onClick={() => void run(async () => { await api.adminSchedulerRollover(reason.trim()); setMessage("Rollover forced."); })}>
            <RefreshCw size={15} /> Force rollover
          </button>
        </div>
      </div>

      <div id="scheduled-matches" className="card" style={{ padding: 20, marginTop: 16, overflowX: "auto" }}>
        <h3 style={{ marginBottom: 12 }}>Matches</h3>
        <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead><tr style={{ color: "var(--text-3)", textAlign: "left" }}><th style={{ padding: "8px 6px" }}>Day</th><th style={{ padding: "8px 6px" }}>Fixture</th><th style={{ padding: "8px 6px" }}>Status</th><th style={{ padding: "8px 6px" }}>Actions</th></tr></thead>
          <tbody>{matches.map((match) => <tr key={match.id} style={{ borderTop: "1px solid var(--line)" }}>
            <td style={{ padding: "9px 6px" }}>Day {match.scheduledGameDay}</td>
            <td style={{ padding: "9px 6px" }}>{match.homeClub} vs {match.awayClub}</td>
            <td style={{ padding: "9px 6px" }}>{match.status}</td>
            <td style={{ padding: "9px 6px" }}>
              {match.status === "SCHEDULED" && <button className="btn" style={{ marginRight: 6 }} disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerStartMatch(match.id, reason || undefined); setMessage("Match started."); })}>Start Now</button>}
              {match.status !== "COMPLETED" && <button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerResolveMatch(match.id, reason || undefined); setMessage("Match resolved."); })}>Resolve Now</button>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>

      <div id="scheduled-auctions" className="card" style={{ padding: 20, marginTop: 16, overflowX: "auto" }}>
        <h3 style={{ marginBottom: 12 }}>Auctions</h3>
        <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginBottom: 10 }}>Extension minutes: <input type="number" min={1} value={auctionExtensionMinutes} onChange={(e) => setAuctionExtensionMinutes(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70, marginLeft: 6, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }} /></div>
        <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead><tr style={{ color: "var(--text-3)", textAlign: "left" }}><th style={{ padding: "8px 6px" }}>Player</th><th style={{ padding: "8px 6px" }}>Seller</th><th style={{ padding: "8px 6px" }}>Ends</th><th style={{ padding: "8px 6px" }}>Status</th><th style={{ padding: "8px 6px" }}>Actions</th></tr></thead>
          <tbody>{auctions.map((auction) => <tr key={auction.id} style={{ borderTop: "1px solid var(--line)" }}>
            <td style={{ padding: "9px 6px" }}>{auction.player}</td>
            <td style={{ padding: "9px 6px" }}>{auction.seller}</td>
            <td style={{ padding: "9px 6px" }}>{new Date(auction.endsAt).toLocaleString()}</td>
            <td style={{ padding: "9px 6px" }}>{auction.status}</td>
            <td style={{ padding: "9px 6px" }}>
              {auction.status === "ACTIVE" && <><button className="btn" style={{ marginRight: 6 }} disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerEndAuction(auction.id, reason || undefined); setMessage("Auction ended."); })}>End Now</button><button className="btn" disabled={loading} onClick={() => void run(async () => { await api.adminSchedulerExtendAuction(auction.id, auctionExtensionMinutes, reason || undefined); setMessage("Auction extended."); })}>Extend</button></>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>

      <div id="season-preview" className="card" style={{ padding: 20, marginTop: 16, overflowX: "auto" }}>
        <h3 style={{ marginBottom: 12 }}>Season preview</h3>
        <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead><tr style={{ color: "var(--text-3)", textAlign: "left" }}><th style={{ padding: "8px 6px" }}>Day</th><th style={{ padding: "8px 6px" }}>Label</th><th style={{ padding: "8px 6px" }}>Phase</th><th style={{ padding: "8px 6px" }}>Payroll</th><th style={{ padding: "8px 6px" }}>Weekly simulation</th></tr></thead>
          <tbody>{preview.map((entry) => <tr key={entry.seasonDayIndex} style={{ borderTop: "1px solid var(--line)" }}><td style={{ padding: "9px 6px" }}>{entry.seasonDay}</td><td style={{ padding: "9px 6px" }}>{entry.label}</td><td style={{ padding: "9px 6px" }}>{entry.phase}</td><td style={{ padding: "9px 6px" }}>{entry.payroll ? "Yes" : "-"}</td><td style={{ padding: "9px 6px" }}>{entry.weeklySimulation ? "Yes" : "-"}</td></tr>)}</tbody>
        </table>
      </div>

      <div id="scheduler-audit" className="card" style={{ padding: 20, marginTop: 16, overflowX: "auto" }}>
        <h3 style={{ marginBottom: 12 }}>Scheduler audit</h3>
        <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead><tr style={{ color: "var(--text-3)", textAlign: "left" }}><th style={{ padding: "8px 6px" }}>Time</th><th style={{ padding: "8px 6px" }}>Action</th><th style={{ padding: "8px 6px" }}>Target</th><th style={{ padding: "8px 6px" }}>Reason</th></tr></thead>
          <tbody>{audit.map((entry) => <tr key={entry.id} style={{ borderTop: "1px solid var(--line)" }}><td style={{ padding: "9px 6px" }}>{new Date(entry.createdAt).toLocaleString()}</td><td style={{ padding: "9px 6px" }}>{entry.action}</td><td style={{ padding: "9px 6px" }}>{entry.targetType}:{entry.targetId ?? ""}</td><td style={{ padding: "9px 6px" }}>{entry.reason ?? "-"}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
