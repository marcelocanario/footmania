import { BarChart3 } from "lucide-react";
import { api, type AdminAnalytics, type AdminAnalyticsDivision } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { groupLabel } from "../../components/competition/shared";

/**
 * World analytics for admins. The headline metric compares the real senior
 * quality in each division against the canonical generation expectation
 * (`divisionMean(tier, depth)`) so designers can see where live squads drift
 * from the pyramid's design curve, plus financial distress hotspots.
 */
export function AnalyticsTab({ version }: TabProps) {
  const analytics = useAdminFetch(() => api.adminAnalytics(), [version]);
  const data = analytics.data?.analytics ?? null;

  return (
    <AdminCard
      icon={<BarChart3 size={17} />}
      title="World analytics"
      subtitle="Real squad quality vs the projected divisionMean(tier) formula from player generation, and per-division financial distress. Read-only telemetry — never fed back into gameplay."
    >
      <SummaryRow data={data} loading={analytics.loading} error={analytics.error} />
      {data && data.divisions.length === 0 && <div className="empty-state" style={{ padding: 24 }}>No active divisions.</div>}
      {data && <TierSections data={data} />}
    </AdminCard>
  );
}

function SummaryRow({ data, loading, error }: { data: AdminAnalytics | null; loading: boolean; error: string | null }) {
  if (error) return <div style={{ color: "#ff6b6b", marginBottom: 12 }}>{error}</div>;
  if (loading || !data) return <div className="empty-state" style={{ padding: 20 }}>Loading…</div>;
  const summary = data.summary;
  const delta =
    summary.realAvgOverall !== null && summary.projectedAvgOverall !== null
      ? Math.round((summary.realAvgOverall - summary.projectedAvgOverall) * 100) / 100
      : null;
  return (
    <div className="grid cols-3" style={{ marginBottom: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div className="stat">
          <div className="label">Divisions · clubs</div>
          <div className="value" style={{ fontSize: "1.8rem" }}>{summary.divisionCount} · {summary.clubCount}</div>
          <div style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>pyramid depth {data.totalDivisions} tiers</div>
        </div>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="stat">
          <div className="label">Avg senior OVR (real → projected)</div>
          <div className="value" style={{ fontSize: "1.8rem" }}>
            {summary.realAvgOverall !== null ? summary.realAvgOverall.toFixed(2) : "—"}
            <span style={{ color: "var(--text-3)", fontSize: "1rem" }}> → {summary.projectedAvgOverall !== null ? summary.projectedAvgOverall.toFixed(2) : "—"}</span>
          </div>
          {delta !== null && <DeltaChip delta={delta} />}
        </div>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="stat">
          <div className="label">Clubs in financial distress</div>
          <div className="value" style={{ fontSize: "1.8rem", color: summary.clubsInFinancialDistress > 0 ? "#ff6b6b" : undefined }}>{summary.clubsInFinancialDistress}</div>
          <div style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>negative cushion, active humans</div>
        </div>
      </div>
    </div>
  );
}

function TierSections({ data }: { data: AdminAnalytics }) {
  const byTier = new Map<number, AdminAnalyticsDivision[]>();
  for (const row of data.divisions) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier)!.push(row);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {[...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([tier, rows]) => (
        <div key={tier}>
          <div className="section-label" style={{ marginBottom: 6 }}>Division {tier}</div>
          <div className="table-wrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.88rem" }}>
              <thead>
                <tr style={{ color: "var(--text-3)", textAlign: "left" }}>
                  <th style={{ padding: "6px 10px" }}>Group</th>
                  <th style={{ padding: "6px 10px" }}>Clubs</th>
                  <th style={{ padding: "6px 10px" }}>Humans</th>
                  <th style={{ padding: "6px 10px" }}>Real OVR</th>
                  <th style={{ padding: "6px 10px" }}>Projected</th>
                  <th style={{ padding: "6px 10px" }}>Δ</th>
                  <th style={{ padding: "6px 10px" }}>Quality gap</th>
                  <th style={{ padding: "6px 10px" }}>Distress</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.divisionId} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "7px 10px", fontWeight: 600 }}>{row.name || `Group ${groupLabel(row.groupIndex)}`}</td>
                    <td style={{ padding: "7px 10px" }}>{row.clubCount}</td>
                    <td style={{ padding: "7px 10px" }}>{row.humanCount}</td>
                    <td style={{ padding: "7px 10px" }}>{row.realAvgOverall !== null ? row.realAvgOverall.toFixed(2) : "—"}</td>
                    <td style={{ padding: "7px 10px", color: "var(--text-3)" }}>{row.projectedAvgOverall.toFixed(2)}</td>
                    <td style={{ padding: "7px 10px" }}>{row.deltaOverall !== null ? <DeltaChip delta={row.deltaOverall} /> : "—"}</td>
                    <td style={{ padding: "7px 10px", minWidth: 120 }}>
                      <DeltaBar delta={row.deltaOverall} />
                    </td>
                    <td style={{ padding: "7px 10px", color: row.clubsInFinancialDistress > 0 ? "#ff6b6b" : undefined }}>
                      {row.clubsInFinancialDistress > 0 ? `${row.clubsInFinancialDistress}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeltaChip({ delta }: { delta: number }) {
  const positive = delta >= 0;
  return (
    <span
      className="chip"
      style={{
        borderColor: positive ? "rgba(61,220,132,0.5)" : "rgba(255,99,99,0.5)",
        color: positive ? "var(--grass-2)" : "#ff6b6b",
        fontSize: "0.75rem",
      }}
    >
      {positive ? "+" : ""}{delta.toFixed(2)} vs projected
    </span>
  );
}

/** Diverging bar centered on the projection: right = stronger than expected. */
function DeltaBar({ delta }: { delta: number | null }) {
  if (delta === null) return <span style={{ color: "var(--text-3)" }}>—</span>;
  // ±10 OVR fills the track; anything beyond clamps.
  const clamped = Math.max(-10, Math.min(10, delta));
  const half = Math.abs(clamped) / 10 * 50;
  return (
    <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }} title={`${delta >= 0 ? "+" : ""}${delta.toFixed(2)} OVR`}>
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--line)" }} />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: `${half}%`,
          left: delta >= 0 ? "50%" : `${50 - half}%`,
          background: delta >= 0 ? "var(--grass-2)" : "#ff6b6b",
          opacity: 0.75,
        }}
      />
    </div>
  );
}
