import { useNavigate } from "react-router-dom";
import type { FixtureView } from "../../api/client";
import { ClubCrest } from "../ClubCrest";
import { formatKickoff as kickoffLabel } from "../../utils/time";

/**
 * Round-by-round fixture cards shared by the Competitions screen and the admin
 * drill-down. Live fixtures jump to the live view; played fixtures trigger
 * `onOpenResult` for the results popout. `contextBuilder` optionally supplies
 * the per-fixture competition chip (season/division/group/round label).
 */
export function FixturesList({
  fixtures,
  contextBuilder,
  onOpenResult,
}: {
  fixtures: FixtureView[];
  contextBuilder?: (f: FixtureView) => { label: string; tooltip: string };
  onOpenResult?: (f: FixtureView) => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="card">
      <div className="table-wrap">
        {fixtures.map((f) => {
          const context = contextBuilder?.(f);
          const isLive = f.liveMatchId != null;
          const isClickable = isLive || (f.played && f.matchId != null);
          return (
            <div
              className={`result-card${f.isHuman ? " human" : ""}${isLive ? " live-now" : ""}`}
              key={f.id}
              style={{ marginBottom: 6, ...(isClickable ? { cursor: "pointer" } : {})}}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              onClick={() => {
                if (isLive && f.liveMatchId != null) navigate(`/live-match/${f.liveMatchId}`);
                else if (f.played) onOpenResult?.(f);
              }}
              onKeyDown={(e) => {
                if (!isClickable) return;
                if (e.key === "Enter") {
                  if (isLive && f.liveMatchId != null) navigate(`/live-match/${f.liveMatchId}`);
                  else if (f.played) onOpenResult?.(f);
                }
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                {context && <span className="chip" title={context.tooltip} style={{ minWidth: 160, justifyContent: "center" }}>{context.label}</span>}
                {isLive && (
                  <span className="live-tag" style={{ fontSize: "0.68rem", padding: "2px 8px" }}>
                    <span className="pulse-dot" /> LIVE
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div className="side">
                    <ClubCrest name={f.home} kit={f.homeKit} size={24} clubId={f.homeClubId} hasCustomLogo={f.homeHasCustomLogo} />
                    {f.home}
                  </div>
                  <div className="score">
                    {isLive || f.played ? `${f.homeScore ?? 0} - ${f.awayScore ?? 0}` : "vs"}
                  </div>
                  <div className="side right">
                    {f.away}
                    <ClubCrest name={f.away} kit={f.awayKit} size={24} clubId={f.awayClubId} hasCustomLogo={f.awayHasCustomLogo} />
                  </div>
                </div>
                {/* Kickoff date/time and stadium, shown for every match (finished ones too). */}
                {(f.kickoffAt || f.venue) && (
                  <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 4, textAlign: "center" }}>
                    {[kickoffLabel(f.kickoffAt), f.venue].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {fixtures.length === 0 && <div className="empty-state" style={{ padding: 20 }}>No fixtures yet.</div>}
      </div>
    </div>
  );
}
