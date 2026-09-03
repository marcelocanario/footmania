import { positionClass, positionLetter } from "../../positions";
import { useTranslation } from "react-i18next";

/**
 * Compact market listing row shared by every transfers tab. `name` renders as
 * a clickable player name (the parent wires it to the shared player popout);
 * `right` hosts the action buttons, `statusChip` a state chip above the meta
 * line. `muted` greys the row out (e.g. loaned-out players).
 */
export function TransferPlayerRow({
  name,
  position,
  overall,
  age,
  country,
  meta,
  statusChip,
  right,
  muted = false,
  own = false,
  onClick,
  sub,
}: {
  name: React.ReactNode;
  /** Natural-position string (e.g. "GK", "LW"). */
  position: string;
  overall: number;
  age: number;
  country?: string | null;
  meta?: React.ReactNode;
  statusChip?: React.ReactNode;
  right?: React.ReactNode;
  muted?: boolean;
  /** True when the row is a listing placed by the viewing club; tinted. */
  own?: boolean;
  onClick?: () => void;
  sub?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`card hoverable transfer-row${muted ? " transfer-row-muted" : ""}${own ? " transfer-row-own" : ""}`} style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <span className={`pos-tag ${positionClass(position)}`} title={position}>{positionLetter(position)}</span>
          <button type="button" className="link-btn" onClick={onClick} style={{ textAlign: "left" }}>{name}</button>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.15rem", color: "var(--grass-2)" }}>{overall}</span>
        </div>
        <div style={{ color: "var(--text-3)", fontSize: "0.86rem", marginTop: 5 }}>
          {t("market.yrs", { age })}{country ? ` · ${country}` : ""}
          {meta != null && <> · {meta}</>}
        </div>
        {sub != null && <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 2 }}>{sub}</div>}
        {statusChip != null && <span style={{ marginTop: 4, display: "inline-block" }}>{statusChip}</span>}
      </div>
      {right != null && <div style={{ display: "flex", gap: 8 }}>{right}</div>}
    </div>
  );
}
