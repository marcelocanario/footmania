import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Dialog } from "primereact/dialog";
import { MultiSelect } from "primereact/multiselect";
import { InputText } from "primereact/inputtext";
import { Ban, CalendarClock, Play, RotateCcw, TriangleAlert } from "lucide-react";
import { api, type ScheduledEventView } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { EVENT_CATEGORIES, eventInfo, eventStatusMeta, type EventCategory } from "./eventCatalog";
import { StatusChip, phaseTone } from "./StatusChip";
import { entityLabel, eventDueLabel } from "./adminTime";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

const STATUS_OPTIONS = ["PENDING", "RUNNING", "FAILED", "COMPLETED", "CANCELLED"].map((s) => ({ label: eventStatusMeta(s).label, value: s }));
const ACTIVE_STATUSES = "PENDING,RUNNING,FAILED";

function dueSortValue(event: ScheduledEventView): number {
  if (event.timeBasis === "REAL_TIME") return event.dueAt ? new Date(event.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return (event.dueAbsoluteGameDay ?? 0) * 1_000_000 + event.priority;
}

/** Failed first, then running/pending by due date; finished events keep their natural order. */
function defaultOrder(events: ScheduledEventView[]): ScheduledEventView[] {
  const rank = (status: string) => (status === "FAILED" ? 0 : status === "RUNNING" || status === "PENDING" ? 1 : 2);
  return [...events].sort((a, b) => rank(a.status) - rank(b.status) || dueSortValue(a) - dueSortValue(b));
}

export function EventsTab({ version, notify, statusPreset }: TabProps & { statusPreset?: string | null }) {
  const [statusFilter, setStatusFilter] = useState<string[]>([...ACTIVE_STATUSES.split(",")]);
  const [categoryFilter, setCategoryFilter] = useState<EventCategory[]>([]);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<ScheduledEventView | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (statusPreset) setStatusFilter([statusPreset]);
  }, [statusPreset]);

  // Server-side status filter keeps the payload small; category and text
  // filtering run client-side because they map over many event types.
  const events = useAdminFetch(
    () => api.adminSchedulerEvents({ status: statusFilter.join(","), limit: 300 }).then((r) => r.events),
    [version, statusFilter.join(",")]
  );

  const rows = useMemo(() => {
    const all = events.data ?? [];
    const query = search.trim().toLowerCase();
    return defaultOrder(all.filter((event) => {
      if (categoryFilter.length > 0 && !categoryFilter.includes(eventInfo(event.type).category)) return false;
      if (!query) return true;
      const info = eventInfo(event.type);
      return (
        info.label.toLowerCase().includes(query) ||
        event.type.toLowerCase().includes(query) ||
        entityLabel(event.entityType, event.entityId).toLowerCase().includes(query) ||
        (event.idempotencyKey ?? "").toLowerCase().includes(query)
      );
    }));
  }, [events.data, categoryFilter, search]);

  const act = async (event: ScheduledEventView, action: () => Promise<unknown>, done: string) => {
    setBusyId(event.id);
    try {
      await action();
      notify("success", done);
      events.reload();
    } catch (e) {
      notify("error", `Could not update ${eventInfo(event.type).label.toLowerCase()}`, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const actionButtons = (event: ScheduledEventView) => (
    <div style={{ display: "flex", gap: 6 }}>
      {event.status === "PENDING" && (
        <>
          <button className="btn sm" disabled={busyId === event.id} title="Run this event immediately" onClick={() => void act(event, () => api.adminSchedulerExecuteEvent(event.id), `${eventInfo(event.type).label} executed`)}>
            <Play size={13} /> Execute
          </button>
          <button className="btn sm ghost" disabled={busyId === event.id} title="Cancel without executing" onClick={() => setConfirm({
            title: `Cancel ${eventInfo(event.type).label}?`,
            message: <>The pending event for <b>{entityLabel(event.entityType, event.entityId)}</b> will be marked cancelled. The scheduler will not run it.</>,
            confirmLabel: "Cancel event",
            onConfirm: () => act(event, () => api.adminSchedulerCancelEvent(event.id), `${eventInfo(event.type).label} cancelled`),
          })}>
            <Ban size={13} /> Cancel
          </button>
        </>
      )}
      {event.status === "FAILED" && (
        <button className="btn sm" disabled={busyId === event.id} title="Re-queue this failed event" onClick={() => void act(event, () => api.adminSchedulerRetryEvent(event.id), `${eventInfo(event.type).label} queued for retry`)}>
          <RotateCcw size={13} /> Retry
        </button>
      )}
    </div>
  );

  const errorBody = (event: ScheduledEventView) =>
    event.lastError ? (
      <span title={event.lastError} style={{ color: "#ff6b6b", display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <TriangleAlert size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        {event.lastError}
      </span>
    ) : (
      <span style={{ color: "var(--text-3)" }}>-</span>
    );

  const dueBody = (event: ScheduledEventView) => {
    const due = eventDueLabel(event);
    return (
      <span title={due.absolute} style={{ whiteSpace: "nowrap" }}>
        {due.overdue && <StatusChip label="overdue" tone="failed" />}
        <span style={{ marginLeft: due.overdue ? 6 : 0 }}>{due.primary}</span>
      </span>
    );
  };

  const typeBody = (event: ScheduledEventView) => {
    const info = eventInfo(event.type);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
        <info.icon size={15} style={{ flexShrink: 0, color: "var(--gold-2)" }} />
        <div style={{ minWidth: 0 }}>
          <div>{info.label}</div>
          <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>{event.type}</div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

      <AdminCard
        icon={<CalendarClock size={17} />}
        title="Scheduled events"
        subtitle={
          <>
            Every automated step the durable scheduler will run — game-day advances, payrolls, match kick-offs, auction settlements and the season lifecycle. Failed events are listed first; select a row for full details.
          </>
        }
      >
        <div className="squad-filters">
          <MultiSelect
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={(e) => setStatusFilter((e.value as string[]) ?? [])}
            placeholder="All statuses"
            maxSelectedLabels={2}
            selectedItemsLabel="{0} statuses"
            aria-label="Filter by status"
            style={{ minWidth: 170 }}
          />
          <MultiSelect
            value={categoryFilter}
            options={EVENT_CATEGORIES.map((c) => ({ label: c.label, value: c.id }))}
            onChange={(e) => setCategoryFilter(e.value as EventCategory[])}
            placeholder="All categories"
            maxSelectedLabels={2}
            selectedItemsLabel="{0} categories"
            aria-label="Filter by category"
            style={{ minWidth: 170 }}
          />
          <InputText value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search label, entity or key" aria-label="Search events" />
        </div>

        <div className="table-wrap" style={{ marginTop: 12 }}>
          <DataTable
            value={rows}
            loading={events.loading}
            dataKey="id"
            paginator
            rows={15}
            rowsPerPageOptions={[15, 30, 50]}
            className="squad-table"
            tableStyle={{ width: "100%", tableLayout: "fixed" }}
            emptyMessage="No events match the current filters."
            onRowClick={(e) => setDetail(e.data as ScheduledEventView)}
          >
            <Column header="Due" body={dueBody} style={{ width: 130 }} />
            <Column header="Event" body={typeBody} style={{ width: 210 }} />
            <Column header="Phase" body={(e) => (e.phase ? <StatusChip label={e.phase.replaceAll("_", " ").toLowerCase()} tone={phaseTone(e.phase)} /> : "-")} style={{ width: 110 }} />
            <Column header="Status" body={(e) => { const meta = eventStatusMeta(e.status); return <StatusChip label={meta.label} tone={meta.tone} pulse={e.status === "RUNNING"} />; }} style={{ width: 110 }} />
            <Column header="Entity" body={(e) => entityLabel(e.entityType, e.entityId)} style={{ width: 160 }} />
            <Column header="Attempts" body={(e) => <span title={`Max ${e.maxAttempts ?? 3}`}>{e.attempts}/{e.maxAttempts ?? 3}</span>} style={{ width: 80 }} />
            <Column header="Error" body={errorBody} style={{ width: 240 }} />
            <Column header="Actions" body={actionButtons} style={{ width: 190 }} />
          </DataTable>
        </div>
      </AdminCard>

      <Dialog header="Event details" visible={detail !== null} onHide={() => setDetail(null)} style={{ width: 560 }}>
        {detail && <EventDetail event={detail} actions={actionButtons(detail)} />}
      </Dialog>
    </div>
  );
}

function EventDetail({ event, actions }: { event: ScheduledEventView; actions: ReactNode }) {
  const info = eventInfo(event.type);
  let payloadPretty = event.payloadJson ?? "{}";
  try {
    payloadPretty = JSON.stringify(JSON.parse(payloadPretty), null, 2);
  } catch {
    // keep raw text when the payload is not valid JSON
  }

  const field = (label: string, value: ReactNode) => (
    <div className="stat" style={{ padding: 0 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: "0.9rem", fontWeight: 500 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <info.icon size={20} style={{ color: "var(--gold-2)" }} />
        <div>
          <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>{info.label}</div>
          <div style={{ color: "var(--text-2)", fontSize: "0.85rem", lineHeight: 1.45 }}>{info.description}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(() => { const meta = eventStatusMeta(event.status); return <StatusChip label={meta.label} tone={meta.tone} pulse={event.status === "RUNNING"} />; })()}
        {event.phase && <StatusChip label={event.phase.replaceAll("_", " ").toLowerCase()} tone={phaseTone(event.phase)} />}
        <StatusChip label={event.timeBasis === "REAL_TIME" ? "real time" : "game day"} tone="neutral" />
      </div>

      <div className="stats-row">
        {field("Due", (() => { const due = eventDueLabel(event); return <span title={due.absolute}>{due.primary}</span>; })())}
        {field("Entity", entityLabel(event.entityType, event.entityId))}
        {field("Attempts", `${event.attempts}/${event.maxAttempts ?? 3}`)}
        {field("Source", event.executionSource)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: "0.82rem", color: "var(--text-3)" }}>
        <div>Created {event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</div>
        <div>Started {event.startedAt ? new Date(event.startedAt).toLocaleString() : "-"}</div>
        <div>Completed {event.completedAt ? new Date(event.completedAt).toLocaleString() : "-"}</div>
        <div>Key <code style={{ fontSize: "0.75rem" }}>{event.idempotencyKey ?? "-"}</code></div>
      </div>

      {event.lastError && (
        <div className="card" style={{ padding: 10, borderColor: "rgba(255,99,99,0.5)" }}>
          <div style={{ color: "#ff6b6b", fontSize: "0.85rem", fontFamily: "monospace", wordBreak: "break-word" }}>{event.lastError}</div>
        </div>
      )}

      <div>
        <div className="section-label">Payload</div>
        <pre style={{ margin: "8px 0 0", padding: 10, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8, fontSize: "0.78rem", overflowX: "auto" }}>{payloadPretty}</pre>
      </div>

      <div>{actions}</div>
    </div>
  );
}
