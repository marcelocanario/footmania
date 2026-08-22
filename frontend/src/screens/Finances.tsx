import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock3, Wallet } from "lucide-react";
import { api, type FinanceDetails, type FinanceSnapshot, type LedgerEntry } from "../api/client";
import { Segmented } from "../components/Segmented";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { money } from "../format";

const STATUS_LABEL: Record<FinanceSnapshot["status"], string> = {
  SAFE: "SAFE",
  AT_RISK: "AT RISK",
  NEGATIVE_CASH: "EMERGENCY",
};

type ActivityFilter = "all" | "income" | "expense";
type Activity = LedgerEntry & { direction: Exclude<ActivityFilter, "all"> };

export function Finances() {
  const { snapshot } = useGame();
  const [income, setIncome] = useState<LedgerEntry[]>([]);
  const [expense, setExpense] = useState<LedgerEntry[]>([]);
  const [details, setDetails] = useState<FinanceDetails | null>(null);
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");

  useEffect(() => {
    void (async () => {
      const [res, financeDetails] = await Promise.all([api.finances(), api.financeDetails()]);
      setIncome(res.income);
      setExpense(res.expense);
      setFinance(res.finance);
      setDetails(financeDetails);
    })();
  }, [snapshot?.club?.cash]);

  const club = snapshot?.club;
  const activity = useMemo(() => {
    const entries: Activity[] = [
      ...income.map((entry) => ({ ...entry, direction: "income" as const })),
      ...expense.map((entry) => ({ ...entry, direction: "expense" as const })),
    ];
    return entries
      .filter((entry) => activityFilter === "all" || entry.direction === activityFilter)
      .sort((a, b) => b.day - a.day || b.amount - a.amount);
  }, [activityFilter, expense, income]);

  const status = finance?.status ?? "SAFE";
  const statusTone = status === "SAFE" ? "good" : status === "AT_RISK" ? "mid" : "bad";

  return (
    <div className="finances-page">
      <div className="page-head fin-page-head">
        <div>
          <div className="kicker">Club office</div>
          <h1>{strings.finances.title}</h1>
        </div>
        {finance && (
          <div className="fin-head-meta">
            <span className={`chip fin-status ${statusTone}`}>
              <i className="dot" /> {STATUS_LABEL[status]}
            </span>
            {finance.nextPayroll !== null && (
              <span className="chip">
                <Clock3 size={13} /> Payroll in {formatPayroll(finance.nextPayroll)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="fin-stat-grid stagger">
        <div className="stat fin-stat fin-stat-primary">
          <div className="label"><Wallet size={13} /> Cash</div>
          <div className={`value ${club?.cash !== undefined && club.cash < 0 ? "negative" : "positive"}`}>{money(club?.cash ?? 0)}</div>
          <div className="hint">Current club balance</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">Available now</div>
          <div className={`value ${(finance?.immediateAvailableCash ?? 0) < 0 ? "negative" : "positive"}`}>{money(finance?.immediateAvailableCash ?? 0)}</div>
          <div className="hint">After reserved bids</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">Reserved bids</div>
          <div className="value gold">{money(finance?.activeBidCommitments ?? 0)}</div>
          <div className="hint">Held for active offers</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">Season salaries</div>
          <div className="value gold">{money(finance?.remainingSalaryCommitments ?? 0)}</div>
          <div className="hint">Remaining commitment</div>
        </div>
      </div>

      <section className="card fin-commitments stagger" aria-labelledby="commitments-title">
        <div className="fin-section-head">
          <div>
            <div className="kicker">Financial control</div>
            <h2 id="commitments-title">Commitments</h2>
          </div>
          <span className={`fin-cushion-badge ${statusTone}`}>{STATUS_LABEL[status]}</span>
        </div>

        <div className="fin-breakdown">
          <div className="fin-row">
            <span>Reserved bids</span>
            <b className="gold">{money(finance?.activeBidCommitments ?? 0)}</b>
          </div>
          <div className="fin-row">
            <span>Remaining season salaries</span>
            <b className="gold">{money(finance?.remainingSalaryCommitments ?? 0)}</b>
          </div>
          {!!finance?.contingentSalary && (
            <div className="fin-row">
              <span>Contingent salaries</span>
              <b className="gold">{money(finance.contingentSalary)}</b>
            </div>
          )}
          <div className="fin-row fin-total">
            <span>Financial cushion</span>
            <b className={finance?.financialCushion !== undefined && finance.financialCushion < 0 ? "negative" : "positive"}>
              {money(finance?.financialCushion ?? 0)}
            </b>
          </div>
        </div>

        {finance && finance.status !== "SAFE" && (
          <div className={`fin-callout ${statusTone}`}>
            <AlertTriangle size={16} />
            <span>{warningCopy(finance.status, club?.competitionState, club?.cash ?? 0)}</span>
          </div>
        )}
      </section>

      <section className="card fin-activity stagger" aria-labelledby="activity-title">
        <div className="fin-section-head fin-activity-head">
          <div>
            <div className="kicker">Club ledger</div>
            <h2 id="activity-title">Recent activity</h2>
          </div>
          <Segmented
            value={activityFilter}
            onChange={setActivityFilter}
            items={[
              { value: "all", label: "All", count: income.length + expense.length },
              { value: "income", label: "Income", icon: <ArrowUpRight size={13} />, count: income.length },
              { value: "expense", label: "Expenses", icon: <ArrowDownRight size={13} />, count: expense.length },
            ]}
          />
        </div>
        <div className="fin-ledger-list">
          {activity.length === 0 && <div className="empty-state fin-empty">No activity in this view</div>}
          {activity.map((entry, index) => (
            <div key={`${entry.day}-${entry.code}-${entry.label}-${index}`} className="news-item fin-ledger-row">
              <span className="day">Day {entry.day}</span>
              <span className="fin-ledger-label">{entry.label}</span>
              <b className={entry.direction === "income" ? "positive" : "negative"}>
                {entry.direction === "income" ? "+" : "−"}{money(entry.amount)}
              </b>
            </div>
          ))}
        </div>
        {details && details.records.length > 0 && (
          <div className="fin-ledger-foot">{details.records.length} club records archived separately</div>
        )}
      </section>
    </div>
  );
}

function warningCopy(status: FinanceSnapshot["status"], competitionState: string | undefined, cash: number): string {
  if (competitionState === "PROVISIONAL") {
    return "Upcoming-season salary commitments exceed available funds. Salaries are frozen while the club is provisional; this warning will be recalculated when the club activates.";
  }
  if (status === "NEGATIVE_CASH") {
    return `Current cash: ${money(cash)}. If the balance is still negative at the next payroll, a financial intervention may force players to leave.`;
  }
  return "Current cash does not cover existing bids and remaining salary commitments through season end. Keep an eye on your balance before making new commitments.";
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
