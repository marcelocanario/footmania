import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Wallet, Building2 } from "lucide-react";
import { Toast } from "primereact/toast";
import { api, type FinanceDetails, type LedgerEntry } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { money, num } from "../format";

export function Finances() {
  const { snapshot, refresh } = useGame();
  const [income, setIncome] = useState<LedgerEntry[]>([]);
  const [expense, setExpense] = useState<LedgerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<FinanceDetails | null>(null);
  const [prices, setPrices] = useState<number[]>([]);
  const toast = useRef<Toast>(null);

  useEffect(() => {
    if (false) return;
    void (async () => {
      const res = await api.finances();
      setIncome(res.income);
      setExpense(res.expense);
      const financeDetails = await api.financeDetails();
      setDetails(financeDetails);
      setPrices([...financeDetails.ticketPrices]);
    })();
  }, [snapshot?.club?.cash]);

  const club = snapshot?.club;

  const savePrices = async () => {
    if (prices.length !== 4) return;
    setBusy(true);
    try {
      await api.setTicketPrices(prices as [number, number, number, number]);
      toast.current?.show({ severity: "success", summary: "Ticket prices updated" });
      await refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const upgrade = async () => {
    if (false) return;
    setBusy(true);
    try {
      await api.startStadiumUpgrade();
      toast.current?.show({ severity: "success", summary: "Stadium expansion started" });
      await refresh();
      setDetails(await api.financeDetails());
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
            <Building2 size={12} /> Stadium
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", fontWeight: 800, marginTop: 6 }}>{club?.stadiumName}</div>
          <div className="hint">{num(club?.stadiumCapacity ?? 0)} capacity</div>
          {details?.stadiumUpgrade ? (
            <div className="hint" style={{ marginTop: 10 }}>Expansion completes on day {details.stadiumUpgrade.completesDay}</div>
          ) : (
            <button className="btn sm" style={{ marginTop: 12 }} disabled={busy} onClick={upgrade}>Expand by 5,000 seats</button>
          )}
        </div>
      </div>

      <div className="grid cols-2 stagger" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="card-title">Ticket prices</h2>
          <div className="hint" style={{ marginBottom: 12 }}>Prices affect attendance through demand elasticity.</div>
          <div className="grid cols-2">
            {prices.map((price, i) => {
              const bounds = details?.ticketBounds[i];
              return <div className="form-group" key={i}>
                <label htmlFor={`ticket-${i}`}>Sector {i + 1}</label>
                <input id={`ticket-${i}`} type="number" min={bounds?.min} max={bounds?.max} value={price} onChange={(e) => setPrices((current) => current.map((v, j) => j === i ? Number(e.target.value) : v))} />
                {bounds && <span className="hint">{bounds.min} - {bounds.max}</span>}
              </div>;
            })}
          </div>
          <button className="btn sm" disabled={busy || prices.length !== 4} onClick={savePrices}>{strings.common.save}</button>
        </div>
        <div className="card">
          <h2 className="card-title">TV deal & confidence</h2>
          <div className="stats-row">
            <div className="stat"><div className="label">TV this season</div><div className="value" style={{ fontSize: "1.2rem" }}>{money((details?.tvDeal?.baseAmount ?? 0) + (details?.tvDeal?.positionBonus ?? 0))}</div></div>
            <div className="stat"><div className="label">Board</div><div className="value" style={{ fontSize: "1.2rem" }}>{club?.boardConfidence ?? 0}%</div></div>
            <div className="stat"><div className="label">Fans</div><div className="value" style={{ fontSize: "1.2rem" }}>{club?.fanConfidence ?? 0}%</div></div>
          </div>
          <div className="hint" style={{ marginTop: 12 }}>Coach: {club?.coachName}</div>
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
