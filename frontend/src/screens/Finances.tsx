import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Wallet, Banknote, Landmark, Building2 } from "lucide-react";
import { Toast } from "primereact/toast";
import { api, type LedgerEntry } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { money, num } from "../format";

export function Finances() {
  const { snapshot, saveId, refresh } = useGame();
  const [income, setIncome] = useState<LedgerEntry[]>([]);
  const [expense, setExpense] = useState<LedgerEntry[]>([]);
  const [loanBalance, setLoanBalance] = useState(0);
  const [loanLimit, setLoanLimit] = useState(1000000);
  const [busy, setBusy] = useState(false);
  const toast = useRef<Toast>(null);

  useEffect(() => {
    if (!saveId) return;
    api.finances(saveId).then((res) => {
      setIncome(res.income);
      setExpense(res.expense);
      setLoanBalance(res.loanBalance);
      setLoanLimit(res.loanLimit);
    });
  }, [saveId, snapshot?.club?.cash]);

  const club = snapshot?.club;
  const loanPct = Math.min(100, (loanBalance / Math.max(1, loanLimit)) * 100);

  const doLoan = async (action: "take" | "repay") => {
    if (!saveId) return;
    setBusy(true);
    try {
      const res = await api.loan(saveId, action);
      setLoanBalance(res.loanBalance);
      toast.current?.show({ severity: "success", summary: action === "take" ? "Loan taken" : "Loan repaid" });
      await refresh();
      const fin = await api.finances(saveId);
      setIncome(fin.income);
      setExpense(fin.expense);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

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
      <Toast ref={toast} />
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
          <div className="hint">{num(club?.stadiumCapacity ?? 0)} seats · {club?.stadiumName}</div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div className="label" style={{ color: "var(--text-3)", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.11em", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Banknote size={12} /> {strings.finances.loan}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.7rem", fontWeight: 800, marginTop: 6 }}>{money(loanBalance)}</div>
          <div style={{ height: 7, background: "rgba(228,245,235,0.1)", borderRadius: 999, marginTop: 10, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${loanPct}%`, background: loanPct > 70 ? "var(--red)" : "linear-gradient(90deg, var(--gold), var(--gold-2))", borderRadius: 999, transition: "width .4s ease" }} />
          </div>
          <div className="hint">Limit {money(loanLimit)} · 3% monthly interest</div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn sm" disabled={busy || loanBalance >= loanLimit} onClick={() => doLoan("take")}>
              <Landmark size={14} /> {strings.finances.takeLoan}
            </button>
            <button className="btn sm ghost" disabled={busy || loanBalance <= 0} onClick={() => doLoan("repay")}>
              {strings.finances.repayLoan}
            </button>
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div className="label" style={{ color: "var(--text-3)", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.11em", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Building2 size={12} /> Stadium
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", fontWeight: 800, marginTop: 6 }}>{club?.stadiumName}</div>
          <div className="hint">{num(club?.stadiumCapacity ?? 0)} capacity</div>
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
