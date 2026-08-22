import { useMemo, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { InputText } from "primereact/inputtext";
import { ScrollText } from "lucide-react";
import { api, type SchedulerAuditView } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw || "-";
  }
}

function JsonBlock({ title, raw }: { title: string; raw: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="section-label">{title}</div>
      <pre style={{ margin: "6px 0 0", padding: 10, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8, fontSize: "0.75rem", overflowX: "auto", maxHeight: 220 }}>{prettyJson(raw)}</pre>
    </div>
  );
}

export function AuditTab({ version }: TabProps) {
  const audit = useAdminFetch(() => api.adminSchedulerAudit().then((r) => r.audit), [version]);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return audit.data ?? [];
    return (audit.data ?? []).filter((entry) =>
      `${entry.action} ${entry.targetType}:${entry.targetId ?? ""} ${entry.reason ?? ""} #${entry.adminUserId}`.toLowerCase().includes(query)
    );
  }, [audit.data, search]);

  const targetBody = (entry: SchedulerAuditView) => (
    <span>
      {entry.targetType}
      {entry.targetId ? <span style={{ color: "var(--text-3)" }}> #{entry.targetId}</span> : null}
    </span>
  );

  const expansion = (entry: SchedulerAuditView) => (
    <div style={{ display: "flex", gap: 12, padding: "4px 6px 10px", flexWrap: "wrap" }}>
      <JsonBlock title="Before" raw={entry.beforeJson ?? "{}"} />
      <JsonBlock title="After" raw={entry.afterJson ?? "{}"} />
    </div>
  );

  return (
    <AdminCard
      icon={<ScrollText size={17} />}
      title="Scheduler audit log"
      subtitle="Every manual admin action on the clock, events, matches, auctions and users — with the state before and after. Newest first."
    >
      <div className="squad-filters">
        <InputText value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search action, target or reason" aria-label="Search audit log" />
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <DataTable
          value={rows}
          loading={audit.loading}
          dataKey="id"
          paginator
          rows={20}
          rowExpansionTemplate={expansion}
          className="squad-table"
          tableStyle={{ width: "100%", tableLayout: "fixed" }}
          emptyMessage={audit.loading ? "Loading…" : "No admin actions recorded yet."}
        >
          <Column expander style={{ width: 40 }} />
          <Column header="When" body={(e) => <span title={new Date(e.createdAt).toLocaleString()}>{new Date(e.createdAt).toLocaleString()}</span>} sortable sortField="createdAt" style={{ width: 170 }} />
          <Column field="action" header="Action" sortable style={{ width: 200 }} />
          <Column header="Target" body={targetBody} style={{ width: 180 }} />
          <Column header="By" body={(e) => <>admin #{e.adminUserId}</>} style={{ width: 90 }} />
          <Column header="Reason" body={(e) => e.reason ?? <span style={{ color: "var(--text-3)" }}>-</span>} style={{ width: "auto" }} />
        </DataTable>
      </div>
    </AdminCard>
  );
}
