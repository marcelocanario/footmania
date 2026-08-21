import { useEffect, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Wallet, Building2, TrendingDown } from "lucide-react";
import { api, type FinanceDetails, type FinanceSnapshot, type LedgerEntry } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { money } from "../format";

const STATUS_LABEL: Record<FinanceSnapshot["status"], string> = {
  SAFE: "SAFE",
  AT_RISK: "AT RISK",
  NEGATIVE_CASH: "FINANCIAL EMERGENCY",
};

export function Finances() {
  const { snapshot } = useGame();
  const [income, setIncome] = useState<LedgerEntry[]>([]);
  const [expense, setExpense] = useState<LedgerEntry[]>([]);
  const [details, setDetails] = useState<FinanceDetails | null>(null);
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.finances();
      setIncome(res.income);
      setExpense(res.expense);
      setFinance(res.finance);
      setDetails(await api.financeDetails());
    })();
  }, [snapshot?.club?.cash]);

  const club = snapshot?.club;

  const ledgerRow = (e: LedgerEntry, positive: boolean) => (
    <div key={`${e.day}-${e.label}-${e.amount}`} className="news-item">
      <span className="day">Day {e.day}</span>
      <span style={{ flex: 1 }}>{e.label}</span>
      <b style={{ color: positive ? "var(--grass-2)" : "var(--red-2)", fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}>
        {positive ? "+" : "−"}{money(e.amount)}
      </b>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{strings.finances.title}</div>
          <h1>{strings.finances.title}</h1>
        </div>
      </div>

      <div className="stats-row stagger">
        <div className="card" style={{ flex: 1 }}>
          <div className="label" style={{ color: "var(--text-3)", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.11em", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Wallet size={12} /> {strings.dashboard.cash}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "2.3rem", fontWeight: 800, marginTop: 6, color: (club?.cash ?? 0) >= 0 ? "var(--grass-2)" : "var(--red-2)" }}>
            {money(club?.cash ?? 0)}
          </div>
          <div className="hint">{club?.stadiumName}</div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div className="label" style={{ color: "var(--text-3)", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.11em", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Building2 size={12} /> Stadium
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", fontWeight: 800, marginTop: 6 }}>{club?.stadiumName}</div>
        </div>
      </div>

      <div className="card stagger" style={{ marginTop: 16 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>Financial cushion</div>
        <div className="grid cols-2" style={{ gap: 6, maxWidth: 560 }}>
          <span className="hint">Reserved bids</span>
          <b style={{ textAlign: "right", color: "var(--gold-2)" }}>{money(finance?.activeBidCommitments ?? 0)}</b>
          <span className="hint">Remaining season salaries</span>
          <b style={{ textAlign: "right", color: "var(--gold-2)" }}>{money(finance?.remainingSalaryCommitments ?? 0)}</b>
          {finance && finance.contingentSalary > 0 && (
            <>
              <span className="hint">Contingent (leading bids)</span>
              <b style={{ textAlign: "right", color: "var(--gold-2)" }}>{money(finance.contingentSalary)}</b>
            </>
          )}
          <span className="hint" style={{ borderTop: "1px solid var(--line, #333)", paddingTop: 6 }}>Financial cushion</span>
          <b
            style={{
              textAlign: "right",
              borderTop: "1px solid var(--line, #333)",
              paddingTop: 6,
              fontFamily: "var(--font-display)",
              fontSize: "1.15rem",
              color: (finance?.financialCushion ?? 0) >= 0 ? "var(--grass-2)" : "var(--red-2)",
            }}
          >
            {money(finance?.financialCushion ?? 0)}
          </b>
        </div>
        {finance && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className={`chip ${finance.status === "SAFE" ? "" : ""}`} style={statusChipStyle(finance.status)}>
              Status: {STATUS_LABEL[finance.status]}
            </span>
            {finance.nextPayroll !== null && (
              <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TrendingDown size={13} /> Next payroll: {formatPayroll(finance.nextPayroll)}
              </span>
            )}
          </div>
        )}
        {finance && finance.status !== "SAFE" && (
          <div className="card" style={{ marginTop: 12, padding: 12, fontSize: "0.9rem", color: "var(--red-2)", background: "var(--red-1, #2a1515)" }}>
            <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {club?.competitionState === "PROVISIONAL"
              ? `Your funded upcoming-season salary commitments currently exceed available funds. Salaries are frozen while the club is provisional; the warning will be recalculated when the club activates.`
              : finance.status === "NEGATIVE_CASH"
              ? `Current cash: ${money(club?.cash ?? 0)}. If the club is still in a negative cash position when the next payroll cycle is processed, a financial intervention may force players to leave.`
              : `Your current cash does not cover your existing bids and remaining salary commitments through season end. Future income may improve this position, but if your cash balance becomes negative and remains negative until a later payroll cycle, players may be forced to leave the club.`}
          </div>
        )}
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title">Club operations</h2>
          <div className="hint" style={{ marginTop: 12 }}>Coach: {club?.coachName}</div>
          {details && details.records.length > 0 && (
            <div className="hint" style={{ marginTop: 12 }}>{details.records.length} club records on file</div>
          )}
        </div>
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}>
          <span className="hint">More club facilities are planned for a future season.</span>
        </div>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title" style={{ color: "var(--grass-2)" }}>
            <ArrowUpRight size={17} /> {strings.finances.income}
          </h2>
          <div className="news-list">
            {income.length === 0 && <div className="empty-state" style={{ padding: "24px 10px" }}>No income yet</div>}
            {income.map((e) => ledgerRow(e, true))}
          </div>
        </div>
        <div className="card">
          <h2 className="card-title" style={{ color: "var(--red-2)" }}>
            <ArrowDownRight size={17} /> {strings.finances.expense}
          </h2>
          <div className="news-list">
            {expense.length === 0 && <div className="empty-state" style={{ padding: "24px 10px" }}>No expenses yet</div>}
            {expense.map((e) => ledgerRow(e, false))}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusChipStyle(status: FinanceSnapshot["status"]): React.CSSProperties {
  if (status === "NEGATIVE_CASH") return { color: "var(--red-2)", borderColor: "var(--red-2)" };
  if (status === "AT_RISK") return { color: "var(--gold-2)", borderColor: "var(--gold-2)" };
  return { color: "var(--grass-2)", borderColor: "var(--grass-2)" };
}

function formatPayroll(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}
