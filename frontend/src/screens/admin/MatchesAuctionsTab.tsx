import { useEffect, useMemo, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Gavel, Trophy } from "lucide-react";
import { api, type SchedulerAuctionView, type SchedulerMatchView } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { StatusChip } from "./StatusChip";
import { eventDueLabel, relativeTime } from "./adminTime";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { money } from "../../format";

const MATCH_STATUS_TONE: Record<string, "info" | "running" | "done"> = { SCHEDULED: "info", LIVE: "running", COMPLETED: "done" };

export function MatchesAuctionsTab({ version, notify }: TabProps) {
  const matches = useAdminFetch(() => api.adminSchedulerMatches().then((r) => r.matches), [version]);
  const auctions = useAdminFetch(() => api.adminSchedulerAuctions().then((r) => r.auctions), [version]);
  const [matchSearch, setMatchSearch] = useState("");
  const [matchStatusFilter, setMatchStatusFilter] = useState("ALL");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [extendAuction, setExtendAuction] = useState<SchedulerAuctionView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runAction = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusyId(key);
    try {
      await action();
      notify("success", done);
      matches.reload();
      auctions.reload();
    } catch (e) {
      notify("error", "Action failed", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const filteredMatches = useMemo(() => {
    const query = matchSearch.trim().toLowerCase();
    return (matches.data ?? []).filter((m) => {
      if (matchStatusFilter !== "ALL" && m.status !== matchStatusFilter) return false;
      if (!query) return true;
      return `${m.homeClub} ${m.awayClub}`.toLowerCase().includes(query);
    });
  }, [matches.data, matchSearch, matchStatusFilter]);

  const startMatch = (m: SchedulerMatchView) =>
    setConfirm({
      title: "Start match now?",
      message: <><b>{m.homeClub} vs {m.awayClub}</b> will kick off immediately as a live match, ahead of its scheduled day.</>,
      confirmLabel: "Start now",
      onConfirm: (reason) => runAction(`match:${m.id}`, () => api.adminSchedulerStartMatch(m.id, reason || undefined), "Match started"),
    });

  const resolveMatch = (m: SchedulerMatchView) =>
    setConfirm({
      title: "Resolve match now?",
      danger: true,
      message: <>Simulates and finalizes <b>{m.homeClub} vs {m.awayClub}</b> right away. Completed fixtures are immutable afterwards.</>,
      confirmLabel: "Resolve now",
      onConfirm: (reason) => runAction(`match:${m.id}`, () => api.adminSchedulerResolveMatch(m.id, reason || undefined), "Match resolved"),
    });

  const matchActions = (m: SchedulerMatchView) => (
    <div style={{ whiteSpace: "nowrap", display: "flex", gap: 6 }}>
      {m.status === "SCHEDULED" && <button className="btn sm" disabled={busyId !== null} onClick={() => startMatch(m)}>Start now…</button>}
      {m.status !== "COMPLETED" && <button className="btn sm ghost" disabled={busyId !== null} onClick={() => resolveMatch(m)}>Resolve now…</button>}
    </div>
  );

  const auctionActions = (a: SchedulerAuctionView) => (
    <div style={{ whiteSpace: "nowrap", display: "flex", gap: 6 }}>
      <button
        className="btn sm"
        disabled={busyId !== null}
        onClick={() =>
          setConfirm({
            title: "End auction now?",
            danger: true,
            message: <>The auction for <b>{a.player}</b> settles immediately — highest bidder wins or the player returns to <b>{a.seller}</b>.</>,
            confirmLabel: "End now",
            onConfirm: (reason) => runAction(`auction:${a.id}`, () => api.adminSchedulerEndAuction(a.id, reason || undefined), "Auction ended"),
          })
        }
      >
        End now…
      </button>
      <button className="btn sm ghost" disabled={busyId !== null} onClick={() => setExtendAuction(a)}>Extend…</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <ExtendDialog auction={extendAuction} onClose={() => setExtendAuction(null)} onDone={(msg) => { setExtendAuction(null); notify("success", msg); matches.reload(); auctions.reload(); }} onError={(msg) => notify("error", "Action failed", msg)} />

      <AdminCard
        icon={<Trophy size={17} />}
        title="Fixtures & live matches"
        subtitle="Every fixture on the world calendar. Start or resolve individual matches manually when the schedule needs a nudge."
      >
        <div className="squad-filters">
          <InputText value={matchSearch} onChange={(e) => setMatchSearch(e.target.value)} placeholder="Search club name" aria-label="Search fixtures" />
          <select
            value={matchStatusFilter}
            onChange={(e) => setMatchStatusFilter(e.target.value)}
            aria-label="Filter by match status"
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
          >
            <option value="ALL">All statuses</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="LIVE">Live</option>
            <option value="COMPLETED">Completed</option>
          </select>
        </div>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <DataTable
            value={filteredMatches}
            loading={matches.loading}
            dataKey="id"
            paginator
            rows={15}
            rowsPerPageOptions={[15, 30, 50]}
            className="squad-table"
            tableStyle={{ width: "100%", tableLayout: "fixed" }}
            emptyMessage={matches.loading ? "Loading…" : "No fixtures match."}
          >
            <Column header="Day" body={(m) => `Day ${m.scheduledGameDay}`} sortable sortField="scheduledGameDay" style={{ width: 90 }} />
            <Column header="Fixture" body={(m) => <><b>{m.homeClub}</b> vs <b>{m.awayClub}</b></>} style={{ width: "auto" }} />
            <Column field="division" header="Division" style={{ width: 170 }} />
            <Column field="round" header="Round" body={(m) => `R${m.round + 1}`} sortable style={{ width: 80 }} />
            <Column header="Status" body={(m) => <StatusChip label={m.status.toLowerCase()} tone={MATCH_STATUS_TONE[m.status] ?? "neutral"} />} sortable sortField="status" style={{ width: 120 }} />
            <Column
              header="Kick-off event"
              body={(m) => {
                if (!m.event) return <span style={{ color: "var(--text-3)" }}>-</span>;
                const due = eventDueLabel(m.event);
                const meta = m.event.status === "FAILED" ? "failed" : m.event.status === "PENDING" ? "pending" : m.event.status.toLowerCase();
                return <span title={`Event ${m.event.status}${due.absolute ? ` · due ${due.absolute}` : ""}`}>{meta}{due.overdue ? " · overdue" : ""}</span>;
              }}
              style={{ width: 130 }}
            />
            <Column header="Actions" body={matchActions} style={{ width: 160 }} />
          </DataTable>
        </div>
      </AdminCard>

      <AdminCard
        icon={<Gavel size={17} />}
        title="Transfer auctions"
        subtitle="Live transfer-market auctions. Ending an auction settles it immediately; extending pushes the deadline back."
      >
        <div className="table-wrap">
          <DataTable
            value={auctions.data ?? []}
            loading={auctions.loading}
            dataKey="id"
            paginator
            rows={15}
            className="squad-table"
            tableStyle={{ width: "100%", tableLayout: "fixed" }}
            emptyMessage={auctions.loading ? "Loading…" : "No auctions right now."}
          >
            <Column field="player" header="Player" style={{ width: "auto" }} />
            <Column field="seller" header="Seller" style={{ width: 150 }} />
            <Column header="Current bid" body={(a) => money(a.displayedBid)} sortable sortField="displayedBid" style={{ width: 110 }} />
            <Column header="Top max bid" body={(a) => (a.leadingMaxBid !== null ? <span title="Highest proxy bid committed by any bidder">{money(a.leadingMaxBid)}</span> : "-")} style={{ width: 110 }} />
            <Column header="Bids" body={(a) => a.bidCount} sortable sortField="bidCount" style={{ width: 70 }} />
            <Column
              header="Ends"
              body={(a) => <span title={new Date(a.endsAt).toLocaleString()}>{relativeTime(a.endsAt)}</span>}
              sortable
              sortField="endsAt"
              style={{ width: 110 }}
            />
            <Column header="Status" body={(a) => <StatusChip label={a.status.toLowerCase()} tone={a.status === "ACTIVE" ? "running" : a.status === "SETTLED" ? "done" : "neutral"} />} style={{ width: 110 }} />
            <Column header="Actions" body={auctionActions} style={{ width: 190 }} />
          </DataTable>
        </div>
      </AdminCard>
    </div>
  );
}

function ExtendDialog({ auction, onClose, onDone, onError }: { auction: SchedulerAuctionView | null; onClose: () => void; onDone: (message: string) => void; onError: (message: string) => void }) {
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
  }, [auction]);

  const extend = async () => {
    if (!auction) return;
    setBusy(true);
    try {
      await api.adminSchedulerExtendAuction(auction.id, minutes);
      onDone(`Auction extended by ${minutes} minute(s)`);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog header="Extend auction" visible={auction !== null} onHide={onClose} style={{ width: 380 }}>
      {auction && (
        <>
          <div style={{ color: "var(--text-2)", marginBottom: 14 }}>
            Push the deadline for <b>{auction.player}</b> back. All bidders keep their proxy bids.
          </div>
          <div className="form-group">
            <label htmlFor="extend-minutes">Additional minutes</label>
            <input
              id="extend-minutes"
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy}
              style={{ width: 120, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void extend()}>{busy ? "Working…" : "Extend"}</button>
          </div>
        </>
      )}
    </Dialog>
  );
}
