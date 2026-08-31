import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock3, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type FinanceDetails, type FinanceSnapshot, type LedgerEntry } from "../api/client";
import { Segmented } from "../components/Segmented";
import { useGame } from "../store/game";
import { money } from "../format";

const STATUS_LABEL: Record<FinanceSnapshot["status"], string> = {
  SAFE: "finances.statusSafe",
  AT_RISK: "finances.statusAtRisk",
  NEGATIVE_CASH: "finances.statusEmergency",
};

/** Code → localized ledger line. `name`/`season` are extracted from the
 *  persisted English label; unknown codes fall back to the label verbatim. */
const LEDGER_SPEC: Record<number, { key: string; param?: "name" | "season" }> = {
  1: { key: "ledger.1", param: "name" },
  2: { key: "ledger.2", param: "name" },
  3: { key: "ledger.3", param: "name" },
  4: { key: "ledger.4" },
  13: { key: "ledger.13", param: "season" },
  15: { key: "ledger.15", param: "name" },
  16: { key: "ledger.16", param: "name" },
  17: { key: "ledger.17", param: "name" },
};

function ledgerLabel(entry: { code: number; label: string }, t: (k: string, o?: Record<string, unknown>) => string): string {
  const spec = LEDGER_SPEC[entry.code];
  if (!spec) return entry.label;
  if (spec.param === "name") return t(spec.key, { name: entry.label.split(": ")[1] ?? "" });
  if (spec.param === "season") return t(spec.key, { season: entry.label.match(/Season\s+(\d+)/)?.[1] ?? "" });
  return t(spec.key);
}

type ActivityFilter = "all" | "income" | "expense";
type Activity = LedgerEntry & { direction: Exclude<ActivityFilter, "all"> };

export function Finances() {
  const { t } = useTranslation();
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
          <div className="kicker">{t("myclub.clubOffice")}</div>
          <h1>{t("finances.title")}</h1>
        </div>
        {finance && (
          <div className="fin-head-meta">
            <span className={`chip fin-status ${statusTone}`}>
              <i className="dot" /> {(t as unknown as (k: string) => string)(STATUS_LABEL[status])}
            </span>
            {finance.nextPayroll !== null && (
              <span className="chip">
                <Clock3 size={13} /> {t("finances.payrollIn", { time: formatPayroll(finance.nextPayroll) })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="fin-stat-grid stagger">
        <div className="stat fin-stat fin-stat-primary">
          <div className="label"><Wallet size={13} /> {t("finances.cash")}</div>
          <div className={`value ${club?.cash !== undefined && club.cash < 0 ? "negative" : "positive"}`}>{money(club?.cash ?? 0)}</div>
          <div className="hint">{t("finances.currentBalance")}</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">{t("finances.availableNow")}</div>
          <div className={`value ${(finance?.immediateAvailableCash ?? 0) < 0 ? "negative" : "positive"}`}>{money(finance?.immediateAvailableCash ?? 0)}</div>
          <div className="hint">{t("finances.afterReservedBids")}</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">{t("finances.reservedBids")}</div>
          <div className="value gold">{money(finance?.activeBidCommitments ?? 0)}</div>
          <div className="hint">{t("finances.heldForOffers")}</div>
        </div>
        <div className="stat fin-stat">
          <div className="label">{t("finances.seasonSalaries")}</div>
          <div className="value gold">{money(finance?.remainingSalaryCommitments ?? 0)}</div>
          <div className="hint">{t("finances.remainingCommitment")}</div>
        </div>
      </div>

      <section className="card fin-commitments stagger" aria-labelledby="commitments-title">
        <div className="fin-section-head">
          <div>
            <div className="kicker">{t("finances.financialControl")}</div>
            <h2 id="commitments-title">{t("finances.commitments")}</h2>
          </div>
          <span className={`fin-cushion-badge ${statusTone}`}>{(t as unknown as (k: string) => string)(STATUS_LABEL[status])}</span>
        </div>

        <div className="fin-breakdown">
          <div className="fin-row">
            <span>{t("finances.reservedBids")}</span>
            <b className="gold">{money(finance?.activeBidCommitments ?? 0)}</b>
          </div>
          <div className="fin-row">
            <span>{t("finances.remainingSeasonSalaries")}</span>
            <b className="gold">{money(finance?.remainingSalaryCommitments ?? 0)}</b>
          </div>
          {!!finance?.contingentSalary && (
            <div className="fin-row">
              <span>{t("finances.contingentSalaries")}</span>
              <b className="gold">{money(finance.contingentSalary)}</b>
            </div>
          )}
          <div className="fin-row fin-total">
            <span>{t("finances.financialCushion")}</span>
            <b className={finance?.financialCushion !== undefined && finance.financialCushion < 0 ? "negative" : "positive"}>
              {money(finance?.financialCushion ?? 0)}
            </b>
          </div>
        </div>

        {finance && finance.status !== "SAFE" && (
          <div className={`fin-callout ${statusTone}`}>
            <AlertTriangle size={16} />
            <span>{warningCopy(finance.status, club?.competitionState, club?.cash ?? 0, t as unknown as (k: string, o?: Record<string, unknown>) => string)}</span>
          </div>
        )}
      </section>

      <section className="card fin-activity stagger" aria-labelledby="activity-title">
        <div className="fin-section-head fin-activity-head">
          <div>
            <div className="kicker">{t("finances.clubLedger")}</div>
            <h2 id="activity-title">{t("finances.recentActivity")}</h2>
          </div>
          <Segmented
            value={activityFilter}
            onChange={setActivityFilter}
            items={[
              { value: "all", label: t("finances.all"), count: income.length + expense.length },
              { value: "income", label: t("finances.income"), icon: <ArrowUpRight size={13} />, count: income.length },
              { value: "expense", label: t("finances.expense"), icon: <ArrowDownRight size={13} />, count: expense.length },
            ]}
          />
        </div>
        <div className="fin-ledger-list">
          {activity.length === 0 && <div className="empty-state fin-empty">{t("finances.noActivity")}</div>}
          {activity.map((entry, index) => (
            <div key={`${entry.day}-${entry.code}-${entry.label}-${index}`} className="news-item fin-ledger-row">
              <span className="day">{t("finances.day", { day: entry.day })}</span>
              <span className="fin-ledger-label">{ledgerLabel(entry, t as unknown as (k: string, o?: Record<string, unknown>) => string)}</span>
              <b className={entry.direction === "income" ? "positive" : "negative"}>
                {entry.direction === "income" ? "+" : "−"}{money(entry.amount)}
              </b>
            </div>
          ))}
        </div>
        {details && details.records.length > 0 && (
          <div className="fin-ledger-foot">{t("finances.recordsArchived", { count: details.records.length })}</div>
        )}
      </section>
    </div>
  );
}

function warningCopy(status: FinanceSnapshot["status"], competitionState: string | undefined, cash: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (competitionState === "PROVISIONAL") {
    return t("finances.provisionalWarn");
  }
  if (status === "NEGATIVE_CASH") {
    return t("finances.negativeWarn", { cash: money(cash) });
  }
  return t("finances.atRiskWarn");
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
