import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { ArrowUp, ArrowDown, TrendingUp, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StandingsRow } from "../../api/client";
import { ClubCrest } from "../ClubCrest";

export interface StandingsRowWithPosition extends StandingsRow {
  displayPosition: number;
}

function statusBadge(row: StandingsRow, position: number, isTopDivision: boolean, seasonComplete: boolean, t: (k: string) => string) {
  const badges: React.ReactNode[] = [];
  if (position === 1) {
    badges.push(
      seasonComplete ? (
        <span key="champion" className="chip" style={{ borderColor: "rgba(240,180,41,0.65)", color: "var(--gold-2)", background: "rgba(240,180,41,0.12)" }}>
          <Trophy size={12} /> {t("standings.champion")}
        </span>
      ) : (
        <span key="leader" className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}>
          <TrendingUp size={12} /> {t("standings.leader")}
        </span>
      ),
    );
  }
  if (!isTopDivision && row.promotionStatus === "POSSIBLE") {
    badges.push(<span key="possible" className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)" }}><ArrowUp size={12} /> {t("standings.possiblePromotion")}</span>);
  }
  if (!isTopDivision && row.promotionStatus === "PROMOTED") {
    badges.push(<span key="promoted" className="chip" style={{ borderColor: "rgba(61,220,132,0.5)", color: "var(--grass-2)" }}><ArrowUp size={12} /> {t("standings.promoted")}</span>);
  }
  if (row.relegationStatus === "RELEGATED") {
    badges.push(<span key="relegated" className="chip" style={{ borderColor: "rgba(255,99,99,0.5)", color: "#ff6b6b" }}><ArrowDown size={12} /> {t("standings.relegated")}</span>);
  }
  if (row.clubType === "AI") {
    badges.push(<span key="ai" className="chip" style={{ borderColor: "rgba(120,140,130,0.4)", color: "var(--text-3)" }}>{t("standings.ai")}</span>);
  }
  return badges.length > 0 ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>{badges}</span> : null;
}

/**
 * League table shared by the player Competitions screen and the admin
 * drill-down. Rows are already-sorted standings plus a 1-based display
 * position. When `onClubClick` is set, team cells become clickable.
 * `compact` drops the per-result columns so the table fits narrow side-by-side
 * cards without horizontal scrolling; `highlightClubId` tints the row of the
 * club currently being inspected (independent of the viewer's own `isMine`).
 */
export function StandingsTable({
  rows,
  isTopDivision,
  seasonComplete,
  onClubClick,
  compact = false,
  highlightClubId,
}: {
  rows: StandingsRow[];
  isTopDivision: boolean;
  seasonComplete: boolean;
  onClubClick?: (row: StandingsRow) => void;
  compact?: boolean;
  highlightClubId?: number;
}) {
  const { t } = useTranslation();
  const tableRows = rows.map((row, index) => ({ ...row, displayPosition: index + 1 }));
  return (
    <div className="table-wrap">
      <DataTable
        value={tableRows}
        rowClassName={(r) => [
          r.isHuman ? "human-row" : "",
          r.clubId === highlightClubId ? "my-row" : "",
          r.displayPosition === 1 && seasonComplete ? "standings-champion" : "",
          !isTopDivision && r.promotionStatus === "POSSIBLE" ? "standings-promotion-possible" : "",
          !isTopDivision && r.promotionStatus === "PROMOTED" ? "standings-promoted" : "",
          r.relegationStatus === "RELEGATED" ? "standings-relegated" : "",
        ].filter(Boolean).join(" ")}
        rows={20}
        dataKey="clubId"
      >
        <Column
          key="pos"
          header={t("standings.pos")}
          body={(r) => <span className={`rank-pill${r.displayPosition === 1 ? " champion-rank" : ""}`}>{r.displayPosition}</span>}
          style={{ width: compact ? 44 : 56 }}
        />
        <Column key="team" header={t("standings.team")} body={(r: StandingsRowWithPosition) => (
          <span
            style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              ...(onClubClick ? { cursor: "pointer" } : {}),
            }}
            role={onClubClick ? "button" : undefined}
            tabIndex={onClubClick ? 0 : undefined}
            onKeyDown={onClubClick ? (e) => { if (e.key === "Enter") onClubClick(r); } : undefined}
            onClick={onClubClick ? () => onClubClick(r) : undefined}
          >
            <ClubCrest name={r.clubName} primary={r.colors?.primary} secondary={r.colors?.secondary} kit={r.kit} size={26} clubId={r.clubId} hasCustomLogo={r.hasCustomLogo} />
            <span style={{ fontWeight: 600 }}>{r.clubName}</span>
            {r.isMine && <span className="flag-chip fc-accent">{t("standings.you")}</span>}
            {statusBadge(r, r.displayPosition, isTopDivision, seasonComplete, t as unknown as (k: string) => string)}
          </span>
        )} style={{ minWidth: compact ? 0 : 260 }} />
        {!compact && (
          <>
            <Column key="p" field="played" header={t("standings.p")} style={{ width: 44 }} />
            <Column key="w" field="wins" header={t("standings.w")} style={{ width: 44 }} />
            <Column key="d" field="draws" header={t("standings.d")} style={{ width: 44 }} />
            <Column key="l" field="losses" header={t("standings.l")} style={{ width: 44 }} />
            <Column key="gd" header={t("standings.gd")} body={(r: StandingsRow) => r.goalsFor - r.goalsAgainst} style={{ width: 52 }} />
          </>
        )}
        <Column key="pts" field="points" header={t("standings.pts")} style={{ width: compact ? 48 : 64 }} body={(r: StandingsRow) => <b style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem" }}>{r.points}</b>} />
      </DataTable>
    </div>
  );
}
