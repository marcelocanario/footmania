import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { Toast } from "primereact/toast";
import { Gavel, HandCoins, Users } from "lucide-react";
import { api, type AuctionView, type FinanceSnapshot, type FreeAgentView, type LoanView, type PlayerView, type SkillSet } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { useLang } from "../i18n/store";
import { ClubNameLink } from "../components/ClubNameLink";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { Segmented } from "../components/Segmented";
import { money } from "../format";
import { positionLabel } from "../positions";
import { formatDuration, useCountdown } from "../components/useCountdown";
import { createMarketFilters, TransferFiltersSidebar, type MarketFilters, type SortOption } from "../components/market/TransferFiltersSidebar";
import { TransferPlayerRow } from "../components/market/TransferPlayerRow";
import { TransferStatusChips } from "../components/market/TransferStatusChips";
import { ListForSaleDialog } from "../components/market/ListForSaleDialog";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";

type Tab = "auctions" | "free" | "loans" | "sell";

function AuctionCountdown({ deadline, paused }: { deadline: number; paused?: boolean }) {
  const remaining = useCountdown(deadline);
  if (paused) return <span style={{ color: "var(--gold-2)", fontWeight: 700 }}>{i18n.t("transfers.paused")}</span>;
  if (remaining <= 0) return <span style={{ color: "var(--danger, #d66)" }}>{i18n.t("transfers.closing")}</span>;
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(remaining)}</span>;
}

/** Hover hint for every market action the season pause gates server-side. */
const SEASON_PAUSED_TITLE = () => i18n.t("transfers.seasonPausedTitle");

const SORT_OPTIONS: SortOption[] = [
  { value: "ovr-desc", label: i18n.t("sort.ratingDesc") },
  { value: "ovr-asc", label: i18n.t("sort.ratingAsc") },
  { value: "age-asc", label: i18n.t("sort.ageAsc") },
  { value: "age-desc", label: i18n.t("sort.ageDesc") },
  { value: "value-desc", label: i18n.t("sort.valueDesc") },
  { value: "value-asc", label: i18n.t("sort.valueAsc") },
  { value: "salary-desc", label: i18n.t("sort.salaryDesc") },
  { value: "name-asc", label: i18n.t("sort.nameAsc") },
];

const SELL_SORT_OPTIONS: SortOption[] = [
  { value: "ovr-desc", label: i18n.t("sort.ratingDesc") },
  { value: "ovr-asc", label: i18n.t("sort.ratingAsc") },
  { value: "age-asc", label: i18n.t("sort.ageAsc") },
  { value: "age-desc", label: i18n.t("sort.ageDesc") },
  { value: "value-desc", label: i18n.t("sort.valueDesc") },
  { value: "salary-desc", label: i18n.t("sort.salaryDesc") },
  { value: "name-asc", label: i18n.t("sort.nameAsc") },
];

/** Client-side filter + sort shared by every market list. */
function useMarketList<T extends { naturalPosition: string; age: number; overall: number }>(
  items: T[],
  filters: MarketFilters,
  valueOf: (item: T) => number,
  salaryOf: (item: T) => number,
  nameOf: (item: T) => string,
  priceOf: (item: T) => number,
  skillsOf: (item: T) => Partial<Record<keyof SkillSet, number>> | undefined,
) {
  return useMemo(() => {
    const inRange = (value: number, min: number | null, max: number | null) =>
      (min === null || value >= min) && (max === null || value <= max);
    const filtered = items.filter((item) => {
      const q = filters.query.trim().toLowerCase();
      const nameMatches = !q || nameOf(item).toLowerCase().includes(q);
      const positionMatches = filters.positions.length === 0 || filters.positions.includes(item.naturalPosition);
      const profileMatches = inRange(item.overall, filters.overallMin, filters.overallMax)
        && inRange(item.age, filters.ageMin, filters.ageMax)
        && inRange(valueOf(item), filters.valueMin, filters.valueMax)
        && inRange(salaryOf(item), filters.salaryMin, filters.salaryMax)
        && inRange(priceOf(item), filters.priceMin, filters.priceMax);
      const skills = skillsOf(item);
      const skillsMatch = Object.entries(filters.skillMins).every(([key, minimum]) => (skills?.[key as keyof SkillSet] ?? 0) >= (minimum ?? 0));
      return nameMatches && positionMatches && profileMatches && skillsMatch;
    });
    return [...filtered].sort((a, b) => {
      switch (filters.sortKey) {
        case "ovr-asc": return a.overall - b.overall;
        case "age-asc": return a.age - b.age;
        case "age-desc": return b.age - a.age;
        case "value-desc": return valueOf(b) - valueOf(a);
        case "value-asc": return valueOf(a) - valueOf(b);
        case "salary-desc": return salaryOf(b) - salaryOf(a);
        case "name-asc": return nameOf(a).localeCompare(nameOf(b));
        default: return b.overall - a.overall;
      }
    });
  }, [items, filters, valueOf, salaryOf, nameOf, priceOf, skillsOf]);
}

export function Transfers() {
  const { t } = useTranslation();
  const snapshot = useGame((s) => s.snapshot);
  const status = useGame((s) => s.status);
  const refresh = useGame((s) => s.refresh);
  const maxContractSeasons = useSettings((s) => s.maxContractSeasons);
  const lang = useLang((s) => s.lang);
  const [auctions, setAuctions] = useState<AuctionView[]>([]);
  const [freeAgents, setFreeAgents] = useState<FreeAgentView[]>([]);
  const [loans, setLoans] = useState<LoanView[]>([]);
  const [tab, setTab] = useState<Tab>("auctions");
  const [sellPlayer, setSellPlayer] = useState<PlayerView | null>(null);
  const [freeAgentTarget, setFreeAgentTarget] = useState<FreeAgentView | null>(null);
  const [freeAgentBidAmount, setFreeAgentBidAmount] = useState(0);
  const [freeAgentContractSeasons, setFreeAgentContractSeasons] = useState(1);
  const [loanTarget, setLoanTarget] = useState<LoanView | null>(null);
  const [auctionBidTarget, setAuctionBidTarget] = useState<AuctionView | null>(null);
  const [auctionBidAmount, setAuctionBidAmount] = useState(0);
  const [auctionContractSeasons, setAuctionContractSeasons] = useState(1);
  const [historyTarget, setHistoryTarget] = useState<AuctionView | FreeAgentView | null>(null);
  const [historyData, setHistoryData] = useState<{ player: { displayName: string; name: string; age: number; overall: number; careerGoals: number; careerAssists?: number; seasonGoals: number; seasonAssists?: number; careerMvps?: number; seasonMvps?: number }; seasons: { seasonKey: string; clubName: string; goals: number; assists: number }[]; transfers: { type: string; price: number; seasonKey: string }[]; matches: { minute: number; type: number }[] } | null>(null);
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playerTarget, setPlayerTarget] = useState<{ id: number; name: string } | null>(null);

  // Detailed sidebar filters are kept independently per market tab.
  const [auctionFilters, setAuctionFilters] = useState<MarketFilters>(() => createMarketFilters());
  const [freeFilters, setFreeFilters] = useState<MarketFilters>(() => createMarketFilters());
  const [loanFilters, setLoanFilters] = useState<MarketFilters>(() => createMarketFilters());
  const [sellFilters, setSellFilters] = useState<MarketFilters>(() => createMarketFilters());

  const toast = useRef<Toast>(null);
  const contractTermOptions = (demands: Record<number, number> | undefined, fallback: number) => Array.from({ length: maxContractSeasons }, (_, index) => index + 1).map((value) => ({
    label: `${t("transfers.additionalSeason", { count: value })} - ${money(demands?.[value] ?? fallback)}/season`,
    value,
  }));
  const seasonsOf = (days: number) => {
    const per = snapshot?.save.seasonDays;
    if (!per) return `${days}d`;
    const s = Math.round(days / per);
    return t("squad.nSeasons", { count: s });
  };

  const loadAuctions = useCallback(async () => {
    setLoadError(null);
    try {
      const [auctionResult, freeAgentResult, loanResult, financeResult] = await Promise.all([api.listAuctions(), api.listFreeAgents(), api.listLoans(), api.finances()]);
      setAuctions(auctionResult.auctions);
      setFreeAgents(freeAgentResult.signings);
      setLoans(loanResult.loans);
      setFinance(financeResult.finance);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAuctions();
  }, [loadAuctions]);

  useEffect(() => api.cache.subscribe((scope) => {
    if (scope === "transfers" || scope === "background:transfers") void loadAuctions();
  }), [loadAuctions]);

  useEffect(() => api.cache.subscribeMarketUpdated((event) => {
    const patch = <T extends AuctionView | FreeAgentView>(items: T[]) => items
      .filter((item) => !(item.id === event.listingId && event.status !== "ACTIVE"))
      .map((item) => item.id !== event.listingId ? item : {
        ...item,
        ...(event.currentPrice !== undefined ? { currentPrice: event.currentPrice } : {}),
        ...(event.deadline !== undefined ? { deadline: event.deadline } : {}),
        ...(event.bidderCount !== undefined ? { bidderCount: event.bidderCount } : {}),
        ...(event.amILeading !== undefined ? { amILeading: event.amILeading } : {}),
      });
    if (event.marketType === "TRANSFER") setAuctions(patch);
    else setFreeAgents(patch);
  }), []);

  useEffect(() => {
    if (freeAgentContractSeasons > maxContractSeasons) setFreeAgentContractSeasons(maxContractSeasons);
    if (auctionContractSeasons > maxContractSeasons) setAuctionContractSeasons(maxContractSeasons);
  }, [auctionContractSeasons, freeAgentContractSeasons, maxContractSeasons]);

  const submitFreeAgentBid = async () => {
    if (!freeAgentTarget) return;
    try {
      const res = await api.bidFreeAgent(freeAgentTarget.id, freeAgentBidAmount, freeAgentContractSeasons);
      toast.current?.show({
        severity: "success",
        summary: res.leading ? t("transfers.nowLeadingSigning") : t("transfers.signingBidPlaced"),
        detail: t("transfers.currentSigningFee", { amount: money(res.currentPrice) }),
      });
      setFreeAgentTarget(null);
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("transfers.errorTitle"), detail: (e as Error).message });
    }
  };

  const submitAuctionBid = async () => {
    if (!auctionBidTarget) return;
    try {
      const res = await api.bidAuction(auctionBidTarget.id, auctionBidAmount, auctionContractSeasons);
      toast.current?.show({
        severity: "success",
        summary: res.leading ? t("transfers.nowLeading") : t("transfers.bidPlaced"),
        detail: t("transfers.currentPrice", { amount: money(res.currentPrice) }),
      });
      setAuctionBidTarget(null);
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("transfers.errorTitle"), detail: (e as Error).message });
    }
  };

  const cancelListing = async (auction: AuctionView) => {
    try {
      await api.cancelAuction(auction.id);
      toast.current?.show({ severity: "success", summary: t("transfers.listingCancelled") });
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("transfers.errorTitle"), detail: (e as Error).message });
    }
  };

  const openAuctionHistory = async (a: AuctionView | FreeAgentView, type: "TRANSFER" | "FREE_AGENT") => {
    setHistoryTarget(a as never);
    setHistoryData(null);
    try {
      const data = await api.marketPlayerHistory((a as AuctionView).id ?? (a as FreeAgentView).id, type);
      setHistoryData(data as never);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: t("transfers.history"), detail: (e as Error).message });
      setHistoryTarget(null);
    }
  };

  const takeLoan = async (loan: LoanView) => {
    if (!loan.player) return;
    try {
      await api.claimLoan(loan.id);
      toast.current?.show({ severity: "success", summary: t("transfers.loanAgreed") });
      await refresh();
      setLoans((await api.listLoans()).loans);
      setLoanTarget(null);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const squad = snapshot?.squad ?? [];
  const myClubId = snapshot?.club?.id ?? null;
  const myActiveListings = auctions.filter((a) => a.sellerClubId === myClubId && a.status === "ACTIVE");
  // Spread onto every schedule-dependent action button: while paused the
  // button is disabled and hovering explains why (server also enforces 409).
  const pauseLock: { disabled?: boolean; title?: string } = status?.paused ? { disabled: true, title: SEASON_PAUSED_TITLE() } : {};

  // Financial-cushion projection for a proposed maximum bid (financial-control
  // §56). The new bid reserves `maxBid` immediately and adds a contingent
  // salary commitment if it makes the club lead the listing.
  const cushionProjection = (maxBid: number, salary: number, currentMax: number | null, currentlyLeading: boolean) => {
    if (!finance) return null;
    // The current cushion already includes any reservation/contingent salary
    // for a listing on which the user is leading. Only an increase is new in
    // that case. If the user is not leading, this is intentionally a
    // conservative "if this makes you lead" projection because competing
    // private maxima are hidden by design.
    const existingReservation = currentlyLeading ? currentMax ?? 0 : 0;
    const newReservation = currentlyLeading ? Math.max(existingReservation, maxBid) : Math.max(0, maxBid);
    const bidDelta = Math.max(0, newReservation - existingReservation);
    const salaryDelta = currentlyLeading ? 0 : salary > 0 ? salary * finance.remainingSeasonFraction : 0;
    return finance.financialCushion - bidDelta - salaryDelta;
  };
  const cushionWarning = (after: number | null) => {
    if (after === null || after >= 0) return null;
    return (
      <div className="card" style={{ marginBottom: 10, padding: 10, fontSize: "0.88rem", color: "var(--gold-2)", borderColor: "var(--gold-2)" }}>
        {t("transfers.currentCushion", { amount: money(finance?.financialCushion ?? 0) })}
        <br />
        {t("transfers.afterBid", { amount: money(after) })}
        <br />
        <span style={{ fontSize: "0.8rem", color: "var(--text-3)" }}>
          {t("transfers.cushionWarnNote")}
        </span>
      </div>
    );
  };
  const loanCushionProjection = (loan: LoanView) => {
    if (!finance || !snapshot || !loan.player) return null;
    const end = Math.min(snapshot.save.seasonDays, loan.endDay);
    const days = Math.max(0, end - snapshot.save.dayIndex);
    return finance.financialCushion - (loan.player.salary * days) / snapshot.save.seasonDays;
  };

  const filteredAuctions = useMarketList(
    auctions,
    auctionFilters,
    (a) => a.value,
    (a) => a.salary,
    (a) => a.playerName,
    (a) => a.currentPrice,
    (a) => a.skills,
  );
  const filteredFreeAgents = useMarketList(
    freeAgents,
    freeFilters,
    (fa) => fa.value,
    (fa) => fa.salary,
    (fa) => fa.playerName,
    (fa) => fa.currentPrice,
    (fa) => fa.skills,
  );
  const loanRows = useMemo(
    () => loans.flatMap((loan) => loan.player ? [{ loan, ...loan.player }] : []),
    [loans],
  );
  const filteredLoans = useMarketList(
    loanRows,
    loanFilters,
    (row) => row.value,
    (row) => row.salary,
    (row) => row.name,
    (row) => row.loan.feeAmount ?? 0,
    (row) => row.skills,
  );
  const sellableSquad = useMemo(() => squad.filter((p) => !p.onSale && !p.onLoan && !p.onLoanOut), [squad]);
  const filteredSellable = useMarketList(
    sellableSquad,
    sellFilters,
    (p) => p.value,
    (p) => p.salary,
    (p) => p.displayName ?? p.name,
    () => 0,
    (p) => p.skills,
  );

  return (
    <div>
      <Toast ref={toast} position="bottom-right" />
      <div className="page-head">
        <div>
          <div className="kicker">{t("transfers.title")}</div>
          <h1>{t("transfers.title")}</h1>
        </div>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "auctions", label: t("transfers.auctions"), icon: <Gavel size={14} />, count: auctions.length },
            { value: "free", label: t("transfers.freeAgents"), icon: <Users size={14} />, count: freeAgents.length },
            { value: "loans", label: t("transfers.loansTab"), icon: <Users size={14} />, count: loans.filter((loan) => loan.available).length },
            { value: "sell", label: t("transfers.sell"), icon: <HandCoins size={14} /> },
          ]}
        />
      </div>

      {loadError && (
        <div className="card" style={{ color: "var(--danger, #d66)" }}>
          {t("transfers.loadFailed", { error: loadError })}
          <button className="btn ghost" style={{ marginLeft: 10 }} onClick={() => void loadAuctions()}>{t("transfers.retry")}</button>
        </div>
      )}

      {tab === "auctions" && (
        <div className="transfer-layout">
          <div className="card">
          {loading ? (
            <div className="empty-state">{t("common.loading")}</div>
          ) : auctions.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🔨</span>
              {t("transfers.noAuctions")}
            </div>
          ) : (
            <>
              <div className="transfer-rows">
                {filteredAuctions.map((a) => {
                  const outbid = a.myMaxBid !== null && !a.amILeading;
                  return (
                    <TransferPlayerRow
                      key={a.id}
                      name={a.playerName}
                      position={a.naturalPosition}
                      overall={a.overall}
                      age={a.age}
                      onClick={() => setPlayerTarget({ id: a.playerId, name: a.playerName })}
                      meta={
                        <>
                          {t("transfers.salarySeason", { amount: money(a.salary) })} · {t("transfers.opening")} <b style={{ color: "var(--text-2)" }}>{money(a.openingPrice)}</b> · {t("transfers.current")} <b style={{ color: "var(--gold-2)" }}>{money(a.currentPrice)}</b> · {t("transfers.bidders", { count: a.bidderCount })}
                        </>
                      }
                      sub={<>{t("transfers.endsIn")} <AuctionCountdown deadline={a.deadline} paused={status?.paused} /></>}
                      statusChip={<TransferStatusChips amILeading={a.amILeading} outbid={outbid} myMaxBid={a.myMaxBid} myMaxLabel={t("transfers.yourMax")} />}
                      right={
                        <>
                          <button className="btn ghost" onClick={() => void openAuctionHistory(a, "TRANSFER")}>{t("transfers.history")}</button>
                          <button className="btn" {...pauseLock} onClick={() => { setAuctionBidTarget(a); setAuctionContractSeasons(a.myContractSeasons ?? 1); setAuctionBidAmount(Math.max(a.openingPrice, a.currentPrice + a.bidIncrement)); }}>
                            {a.myMaxBid !== null ? t("transfers.increaseMax") : t("transfers.bid")}
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </div>
              {filteredAuctions.length === 0 && <div className="empty-state">{t("transfers.noAuctionsFilter")}</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={auctionFilters}
            onChange={setAuctionFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredAuctions.length}
            totalCount={auctions.length}
            priceLabel={t("transfers.priceCurrentLabel")}
          />
        </div>
      )}

      {tab === "free" && (
        <div className="transfer-layout">
          <div className="card">
          {freeAgents.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🆓</span>
              {t("transfers.noFreeAgents")}
            </div>
          ) : (
            <>
              <div className="transfer-rows">
                {filteredFreeAgents.map((fa) => {
                  const outbid = fa.myMaxBid !== null && !fa.amILeading;
                  return (
                    <TransferPlayerRow
                      key={fa.id}
                      name={fa.playerName}
                      position={fa.naturalPosition}
                      overall={fa.overall}
                      age={fa.age}
                      onClick={() => setPlayerTarget({ id: fa.playerId, name: fa.playerName })}
                      meta={
                        <>
                          {t("transfers.salarySeason", { amount: money(fa.salary) })} · {t("transfers.value")} {money(fa.value)} · {t("transfers.signing")} <b style={{ color: "var(--gold-2)" }}>{money(fa.currentPrice)}</b> · {t("transfers.bidders", { count: fa.bidderCount })}
                        </>
                      }
                      sub={<>{t("transfers.endsIn")} <AuctionCountdown deadline={fa.deadline} paused={status?.paused} /></>}
                      statusChip={<TransferStatusChips amILeading={fa.amILeading} outbid={outbid} myMaxBid={fa.myMaxBid} myMaxLabel={t("transfers.yourMax")} />}
                      right={
                        <>
                          <button className="btn ghost" onClick={() => void openAuctionHistory(fa as never, "FREE_AGENT")}>{t("transfers.history")}</button>
                          <button className="btn" {...pauseLock} onClick={() => { setFreeAgentTarget(fa); setFreeAgentContractSeasons(fa.myContractSeasons ?? 1); setFreeAgentBidAmount(Math.max(fa.openingPrice, fa.currentPrice + fa.bidIncrement)); }}>
                            {t("transfers.sign")}
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </div>
              {filteredFreeAgents.length === 0 && <div className="empty-state">{t("transfers.noFreeAgentsFilter")}</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={freeFilters}
            onChange={setFreeFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredFreeAgents.length}
            totalCount={freeAgents.length}
            priceLabel={t("transfers.priceSigningLabel")}
          />
        </div>
      )}

      {tab === "loans" && (
        <div className="transfer-layout">
          <div className="card">
          {loading ? <div className="empty-state">{t("common.loading")}</div> : loans.length === 0 ? <div className="empty-state">{t("transfers.noLoans")}</div> : (
            <>
              <div className="transfer-rows">
                {filteredLoans.map((row) => (
                  <TransferPlayerRow
                    key={row.loan.id}
                    name={row.name}
                    position={row.naturalPosition}
                    overall={row.overall}
                    age={row.age}
                    onClick={() => setPlayerTarget({ id: row.id, name: row.name })}
                    meta={
                      <>
                        {t("transfers.salarySeason", { amount: money(row.salary) })} · {t("transfers.from")} <ClubNameLink clubId={row.loan.fromClubId} name={row.loan.fromClub} showCrest={false} />
                      </>
                    }
                    statusChip={
                      !row.loan.available && row.loan.claimableIn > 0 && !row.loan.toClub
                        ? <span className="chip">{t("transfers.claimableIn", { time: formatDuration(row.loan.claimableIn * 1000) })}</span>
                        : !row.loan.available && row.loan.toClub
                          ? (
                            <span className="chip">
                              {t("transfers.at")} {row.loan.toClubId != null ? <ClubNameLink clubId={row.loan.toClubId} name={row.loan.toClub} showCrest={false} /> : row.loan.toClub}
                            </span>
                          )
                          : undefined
                    }
                    right={
                      row.loan.available
                        ? <button className="btn" title={t("transfers.borrowLoanHint")} {...pauseLock} onClick={() => setLoanTarget(row.loan)}>{t("transfers.viewAndTake")}</button>
                        : undefined
                    }
                  />
                ))}
              </div>
              {filteredLoans.length === 0 && <div className="empty-state">{t("transfers.noLoansFilter")}</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={loanFilters}
            onChange={setLoanFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredLoans.length}
            totalCount={loanRows.length}
            priceLabel={t("transfers.priceLoanLabel")}
          />
        </div>
      )}

      {tab === "sell" && (
        <div className="transfer-layout">
          <div className="card">
          {myActiveListings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>{t("transfers.yourActiveListings")}</div>
              <div className="transfer-rows">
                {myActiveListings.map((a) => (
                  <TransferPlayerRow
                    key={a.id}
                    name={a.playerName}
                    position={a.naturalPosition}
                    overall={a.overall}
                    age={a.age}
                    onClick={() => setPlayerTarget({ id: a.playerId, name: a.playerName })}
                    meta={
                      <>
                        {t("transfers.current")} <b style={{ color: "var(--gold-2)" }}>{money(a.currentPrice)}</b> · {t("transfers.bidders", { count: a.bidderCount })}
                      </>
                    }
                    sub={<>{t("transfers.endsIn")} <AuctionCountdown deadline={a.deadline} paused={status?.paused} /></>}
                    right={
                      a.bidderCount === 0
                        ? <button className="btn ghost" {...pauseLock} onClick={() => cancelListing(a)}>{t("transfers.cancelListing")}</button>
                        : <span className="chip">{t("transfers.bidsCannotCancel")}</span>
                    }
                  />
                ))}
              </div>
            </div>
          )}
          {squad.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>📤</span>
              {t("transfers.noSellable")}
            </div>
          ) : (
            <>
              <div className="kicker" style={{ marginBottom: 6 }}>{t("transfers.listAPlayer")}</div>
              <div className="transfer-rows">
                {filteredSellable.map((p) => (
                  <TransferPlayerRow
                    key={p.id}
                    name={p.displayName ?? p.name}
                    position={p.naturalPosition}
                    overall={p.overall}
                    age={p.age}
                    onClick={() => setPlayerTarget({ id: p.id, name: p.name })}
                    meta={<>{t("squad.overall")} <b style={{ color: "var(--text-2)" }}>{p.overall}</b> · {t("transfers.value")} {money(p.value)}</>}
                    right={<button className="btn ghost" {...pauseLock} onClick={() => setSellPlayer(p)}>{t("transfers.sell")}</button>}
                  />
                ))}
              </div>
              {filteredSellable.length === 0 && <div className="empty-state">{t("transfers.noSquadFilter")}</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={sellFilters}
            onChange={setSellFilters}
            sortOptions={SELL_SORT_OPTIONS}
            resultCount={filteredSellable.length}
            totalCount={sellableSquad.length}
            showPriceFilter={false}
          />
        </div>
      )}

      <ListForSaleDialog player={sellPlayer} onClose={() => setSellPlayer(null)} onListed={() => { refresh(); loadAuctions(); }} />

      <Dialog header={`${t("transfers.sign")} — ${freeAgentTarget?.playerName ?? ""}`} visible={freeAgentTarget !== null} onHide={() => setFreeAgentTarget(null)} dismissableMask style={{ width: 400 }}>
        {freeAgentTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">{t("transfers.playerProfile")}</div>
                <h3 title={positionLabel(freeAgentTarget.naturalPosition)}>{freeAgentTarget.naturalPosition}</h3>
              </div>
              <span className="transfer-overall">{freeAgentTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={freeAgentTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>{t("transfers.exactSalaryDemand", { amount: money(freeAgentTarget.contractDemandsBySeason?.[freeAgentContractSeasons] ?? freeAgentTarget.salary) })}</div>
              <div>{t("transfers.currentSeasonPlus", { count: freeAgentContractSeasons })}</div>
              <div style={{ marginTop: 4 }}>
                {t("transfers.currentSigningFee", { amount: money(freeAgentTarget.currentPrice) })} · {t("transfers.bidders", { count: freeAgentTarget.bidderCount })} · {t("transfers.endsIn")} <AuctionCountdown deadline={freeAgentTarget.deadline} paused={status?.paused} />
              </div>
              {freeAgentTarget.myMaxBid !== null && (
                <div style={{ marginTop: 4 }}>
                  {t("transfers.yourCurrentMax", { amount: money(freeAgentTarget.myMaxBid) })} {freeAgentTarget.amILeading ? t("transfers.youAreLeading") : t("transfers.youAreOutbid")}
                </div>
              )}
            </div>
          </>
        )}
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="fa-contract-term">{t("transfers.contractTerm")}</label>
          <Dropdown
            inputId="fa-contract-term"
            value={freeAgentContractSeasons}
            options={contractTermOptions(freeAgentTarget?.contractDemandsBySeason, freeAgentTarget?.salary ?? 0)}
            onChange={(e) => setFreeAgentContractSeasons(e.value as number)}
            style={{ width: "100%" }}
          />
        </div>
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="fa-bid">
            {t("transfers.yourBid")} (minimum {money(freeAgentTarget ? Math.max(freeAgentTarget.openingPrice, freeAgentTarget.myMaxBid ?? 0, freeAgentTarget.currentPrice + freeAgentTarget.bidIncrement) : 0)})
          </label>
          <InputNumber id="fa-bid" value={freeAgentBidAmount} onValueChange={(e) => setFreeAgentBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale={lang} style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        {cushionWarning(cushionProjection(freeAgentBidAmount, freeAgentTarget?.contractDemandsBySeason?.[freeAgentContractSeasons] ?? freeAgentTarget?.salary ?? 0, freeAgentTarget?.myMaxBid ?? null, freeAgentTarget?.amILeading ?? false))}
        <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 8 }}>
          {t("transfers.signingFeeSystem")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setFreeAgentTarget(null)}>{t("common.cancel")}</button>
          <button className="btn" style={{ flex: 1 }} {...pauseLock} onClick={submitFreeAgentBid}>{t("common.confirm")}</button>
        </div>
      </Dialog>

      <Dialog header={`${t("transfers.bid")} — ${auctionBidTarget?.playerName ?? ""}`} visible={auctionBidTarget !== null} onHide={() => setAuctionBidTarget(null)} dismissableMask style={{ width: 400 }}>
        {auctionBidTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">{t("transfers.playerProfile")}</div>
                <h3 title={positionLabel(auctionBidTarget.naturalPosition)}>{auctionBidTarget.naturalPosition}</h3>
              </div>
              <span className="transfer-overall">{auctionBidTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={auctionBidTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>{t("transfers.exactSalaryDemand", { amount: money(auctionBidTarget.contractDemandsBySeason?.[auctionContractSeasons] ?? auctionBidTarget.salary) })}</div>
              <div>{t("transfers.currentSeasonPlus", { count: auctionContractSeasons })}</div>
              <div style={{ marginTop: 4 }}>
                {t("transfers.currentPrice", { amount: money(auctionBidTarget.currentPrice) })} · {t("transfers.bidders", { count: auctionBidTarget.bidderCount })} · {t("transfers.endsIn")} <AuctionCountdown deadline={auctionBidTarget.deadline} paused={status?.paused} />
              </div>
              {auctionBidTarget.myMaxBid !== null && (
                <div style={{ marginTop: 4 }}>
                  {t("transfers.yourCurrentMax", { amount: money(auctionBidTarget.myMaxBid) })} {auctionBidTarget.amILeading ? t("transfers.youAreLeading") : t("transfers.youAreOutbid")}
                </div>
              )}
            </div>
          </>
        )}
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="auc-contract-term">{t("transfers.contractTerm")}</label>
          <Dropdown
            inputId="auc-contract-term"
            value={auctionContractSeasons}
            options={contractTermOptions(auctionBidTarget?.contractDemandsBySeason, auctionBidTarget?.salary ?? 0)}
            onChange={(e) => setAuctionContractSeasons(e.value as number)}
            style={{ width: "100%" }}
          />
        </div>
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="auc-bid">
            {t("transfers.yourBid")} (minimum {money(auctionBidTarget ? Math.max(auctionBidTarget.openingPrice, auctionBidTarget.myMaxBid ?? 0, auctionBidTarget.currentPrice + auctionBidTarget.bidIncrement) : 0)})
          </label>
          <InputNumber id="auc-bid" value={auctionBidAmount} onValueChange={(e) => setAuctionBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale={lang} style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        {cushionWarning(cushionProjection(auctionBidAmount, auctionBidTarget?.contractDemandsBySeason?.[auctionContractSeasons] ?? auctionBidTarget?.salary ?? 0, auctionBidTarget?.myMaxBid ?? null, auctionBidTarget?.amILeading ?? false))}
        <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 8 }}>
          {t("transfers.auctionPayrollNote")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setAuctionBidTarget(null)}>{t("common.cancel")}</button>
          <button className="btn" style={{ flex: 1 }} {...pauseLock} onClick={submitAuctionBid}>{t("common.confirm")}</button>
        </div>
      </Dialog>

      <Dialog header={t("transfers.loanDialogTitle", { name: loanTarget?.player?.name ?? "" })} visible={loanTarget !== null} onHide={() => setLoanTarget(null)} dismissableMask style={{ width: 430 }}>
        {loanTarget?.player && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">{t("transfers.playerProfile")}</div>
                <h3><span title={positionLabel(loanTarget.player.naturalPosition)}>{loanTarget.player.naturalPosition}</span> · {loanTarget.player.age} yrs</h3>
                <div style={{ color: "var(--text-2)", marginTop: 4 }}>
                  {t("transfers.salarySeason", { amount: money(loanTarget.player.salary) })} · {t("transfers.from")} <ClubNameLink clubId={loanTarget.fromClubId} name={loanTarget.fromClub} showCrest={false} />
                </div>
              </div>
              <span className="transfer-overall">{loanTarget.player.overall}</span>
            </div>
            <PlayerSkillsRadar skills={loanTarget.player.skills} />
            <div className="stats-row" style={{ marginTop: 14 }}>
              <div className="stat"><div className="label">{t("transfers.value")}</div><div className="value">{money(loanTarget.player.value)}</div></div>
              <div className="stat"><div className="label">{t("squad.contract")}</div><div className="value">{seasonsOf(loanTarget.player.contractDays)}</div></div>
            </div>
            {loanCushionProjection(loanTarget) !== null && loanCushionProjection(loanTarget)! < 0 && (
              <div className="card" style={{ marginTop: 12, padding: 10, fontSize: "0.88rem", color: "var(--gold-2)", borderColor: "var(--gold-2)" }}>
                {t("transfers.loanReducesCushion", { amount: money(loanCushionProjection(loanTarget)!) })}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setLoanTarget(null)}>{t("common.cancel")}</button>
              <button className="btn" style={{ flex: 1 }} title={t("transfers.borrowLoanHint")} {...pauseLock} onClick={() => takeLoan(loanTarget)}>{t("transfers.loan")}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={historyTarget ? `${(historyTarget as AuctionView).playerName ?? (historyTarget as FreeAgentView).playerName} — ${t("transfers.fullHistory")}` : t("transfers.fullHistory")} visible={historyTarget !== null} onHide={() => { setHistoryTarget(null); setHistoryData(null); }} dismissableMask style={{ width: 520 }}>
        {!historyData ? <div className="empty-state" style={{ padding: 20 }}>{t("transfers.loadingDots")}</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 800 }}>{historyData.player.displayName} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>· {historyData.player.age} yrs · {t("squad.overall")} {historyData.player.overall}</span></div>
              <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginTop: 4 }}>{t("transfers.career")} {historyData.player.careerGoals}G {(historyData.player.careerAssists ?? 0)}A · {t("squad.season")} {historyData.player.seasonGoals}G</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 2 }}>{(historyData.player.careerMvps ?? 0) > 0 ? `${historyData.player.careerMvps} ${t("transfers.careerMvp")} · ` : ""}{(historyData.player.seasonMvps ?? 0) > 0 ? `${historyData.player.seasonMvps} ${t("transfers.mvpThisSeason")}` : ""}</div>
            </div>
            <div><div className="section-label">{t("transfers.perSeason")}</div>{historyData.seasons.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{t("transfers.noSeasonHistory")}</div> : historyData.seasons.map((s, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>{s.seasonKey} · {s.clubName}</span><span>{s.goals}G {s.assists}A</span></div>)}</div>
            <div><div className="section-label">{t("transfers.marketMoves")}</div>{historyData.transfers.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{t("transfers.noMoves")}</div> : historyData.transfers.map((t, i) => <div key={i} className="news-item">{t.type} {money(t.price)} {t.seasonKey}</div>)}</div>
            <div><div className="section-label">{t("transfers.recentMatches")}</div>{historyData.matches.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>{t("transfers.noMatchEvents")}</div> : historyData.matches.slice(0, 12).map((m, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>{t("transfers.typeMinute", { type: m.type, minute: m.minute })}</span></div>)}</div>
            <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>{t("transfers.historyNote")}</div>
          </div>
        )}
      </Dialog>

      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}
