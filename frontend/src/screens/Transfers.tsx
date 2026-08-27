import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { Toast } from "primereact/toast";
import { Gavel, HandCoins, Users } from "lucide-react";
import { api, type AuctionView, type FinanceSnapshot, type FreeAgentView, type LoanView, type PlayerView, type SkillSet } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { strings } from "../strings";
import { POSITION_LETTER, positionTitle } from "../components/PlayerName";
import { ClubNameLink } from "../components/ClubNameLink";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { Segmented } from "../components/Segmented";
import { money } from "../format";
import { formatDuration, useCountdown } from "../components/useCountdown";
import { createMarketFilters, TransferFiltersSidebar, type MarketFilters, type SortOption } from "../components/market/TransferFiltersSidebar";
import { TransferPlayerRow } from "../components/market/TransferPlayerRow";
import { TransferStatusChips } from "../components/market/TransferStatusChips";
import { ListForSaleDialog } from "../components/market/ListForSaleDialog";
import { PlayerDetailsDialog } from "../components/PlayerDetailsDialog";

type Tab = "auctions" | "free" | "loans" | "sell";

function AuctionCountdown({ deadline, paused }: { deadline: number; paused?: boolean }) {
  const remaining = useCountdown(deadline);
  if (paused) return <span style={{ color: "var(--gold-2)", fontWeight: 700 }}>Paused</span>;
  if (remaining <= 0) return <span style={{ color: "var(--danger, #d66)" }}>Closing</span>;
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(remaining)}</span>;
}

/** Hover hint for every market action the season pause gates server-side. */
const SEASON_PAUSED_TITLE = "The season is paused by an administrator — bids, listings and loans are frozen.";

const SORT_OPTIONS: SortOption[] = [
  { value: "ovr-desc", label: "Rating (high → low)" },
  { value: "ovr-asc", label: "Rating (low → high)" },
  { value: "age-asc", label: "Age (youngest first)" },
  { value: "age-desc", label: "Age (oldest first)" },
  { value: "value-desc", label: "Value (high → low)" },
  { value: "value-asc", label: "Value (low → high)" },
  { value: "salary-desc", label: "Salary (high → low)" },
  { value: "name-asc", label: "Name (A → Z)" },
];

const SELL_SORT_OPTIONS: SortOption[] = [
  { value: "ovr-desc", label: "Rating (high → low)" },
  { value: "ovr-asc", label: "Rating (low → high)" },
  { value: "age-asc", label: "Age (youngest first)" },
  { value: "age-desc", label: "Age (oldest first)" },
  { value: "value-desc", label: "Value (high → low)" },
  { value: "salary-desc", label: "Salary (high → low)" },
  { value: "name-asc", label: "Name (A → Z)" },
];

/** Client-side filter + sort shared by every market list. */
function useMarketList<T extends { position: number; age: number; overall: number }>(
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
      const positionMatches = filters.positions.length === 0 || filters.positions.includes(item.position);
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
  const snapshot = useGame((s) => s.snapshot);
  const status = useGame((s) => s.status);
  const refresh = useGame((s) => s.refresh);
  const maxContractSeasons = useSettings((s) => s.maxContractSeasons);
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
    label: `${value} additional season${value === 1 ? "" : "s"} - ${money(demands?.[value] ?? fallback)}/season`,
    value,
  }));
  const seasonsOf = (days: number) => {
    const per = snapshot?.save.seasonDays;
    if (!per) return `${days}d`;
    const s = Math.round(days / per);
    return `${s} season${s === 1 ? "" : "s"}`;
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
        summary: res.leading ? "You are now leading the signing race" : "Signing bid placed",
        detail: `Current signing fee ${money(res.currentPrice)}`,
      });
      setFreeAgentTarget(null);
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const submitAuctionBid = async () => {
    if (!auctionBidTarget) return;
    try {
      const res = await api.bidAuction(auctionBidTarget.id, auctionBidAmount, auctionContractSeasons);
      toast.current?.show({
        severity: "success",
        summary: res.leading ? "You are now leading" : "Bid placed",
        detail: `Current price ${money(res.currentPrice)}`,
      });
      setAuctionBidTarget(null);
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const cancelListing = async (auction: AuctionView) => {
    try {
      await api.cancelAuction(auction.id);
      toast.current?.show({ severity: "success", summary: "Listing cancelled" });
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const openAuctionHistory = async (a: AuctionView | FreeAgentView, type: "TRANSFER" | "FREE_AGENT") => {
    setHistoryTarget(a as never);
    setHistoryData(null);
    try {
      const data = await api.marketPlayerHistory((a as AuctionView).id ?? (a as FreeAgentView).id, type);
      setHistoryData(data as never);
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "History", detail: (e as Error).message });
      setHistoryTarget(null);
    }
  };

  const takeLoan = async (loan: LoanView) => {
    if (!loan.player) return;
    try {
      await api.claimLoan(loan.id);
      toast.current?.show({ severity: "success", summary: "Loan agreed" });
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
  const pauseLock: { disabled?: boolean; title?: string } = status?.paused ? { disabled: true, title: SEASON_PAUSED_TITLE } : {};

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
        Current financial cushion: <b>{money(finance?.financialCushion ?? 0)}</b>
        <br />
        After this bid: <b style={{ color: "var(--red-2)" }}>{money(after)}</b>
        <br />
        <span style={{ fontSize: "0.8rem", color: "var(--text-3)" }}>
          Your cash would no longer cover your known bids and salaries through season end. You may continue, but the AI never makes this choice.
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
          <div className="kicker">{strings.transfers.title}</div>
          <h1>{strings.transfers.title}</h1>
        </div>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "auctions", label: strings.transfers.auctions, icon: <Gavel size={14} />, count: auctions.length },
            { value: "free", label: strings.transfers.freeAgents, icon: <Users size={14} />, count: freeAgents.length },
            { value: "loans", label: "Loans", icon: <Users size={14} />, count: loans.filter((loan) => loan.available).length },
            { value: "sell", label: strings.transfers.sell, icon: <HandCoins size={14} /> },
          ]}
        />
      </div>

      {loadError && (
        <div className="card" style={{ color: "var(--danger, #d66)" }}>
          Could not load transfer listings: {loadError}
          <button className="btn ghost" style={{ marginLeft: 10 }} onClick={() => void loadAuctions()}>Retry</button>
        </div>
      )}

      {tab === "auctions" && (
        <div className="transfer-layout">
          <div className="card">
          {loading ? (
            <div className="empty-state">{strings.common.loading}</div>
          ) : auctions.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🔨</span>
              No auctions right now. Check back after the next match day.
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
                      position={a.position}
                      overall={a.overall}
                      age={a.age}
                      onClick={() => setPlayerTarget({ id: a.playerId, name: a.playerName })}
                      meta={
                        <>
                          Salary <b style={{ color: "var(--text-2)" }}>{money(a.salary)}/season</b> · Opening <b style={{ color: "var(--text-2)" }}>{money(a.openingPrice)}</b> · Current <b style={{ color: "var(--gold-2)" }}>{money(a.currentPrice)}</b> · Bidders {a.bidderCount}
                        </>
                      }
                      sub={<>Ends in <AuctionCountdown deadline={a.deadline} paused={status?.paused} /></>}
                      statusChip={<TransferStatusChips amILeading={a.amILeading} outbid={outbid} myMaxBid={a.myMaxBid} myMaxLabel="Your max" />}
                      right={
                        <>
                          <button className="btn ghost" onClick={() => void openAuctionHistory(a, "TRANSFER")}>History</button>
                          <button className="btn" {...pauseLock} onClick={() => { setAuctionBidTarget(a); setAuctionContractSeasons(a.myContractSeasons ?? 1); setAuctionBidAmount(Math.max(a.openingPrice, a.currentPrice + a.bidIncrement)); }}>
                            {a.myMaxBid !== null ? "Increase Max" : strings.transfers.bid}
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </div>
              {filteredAuctions.length === 0 && <div className="empty-state">No auctions match your filters.</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={auctionFilters}
            onChange={setAuctionFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredAuctions.length}
            totalCount={auctions.length}
            priceLabel="Current price"
          />
        </div>
      )}

      {tab === "free" && (
        <div className="transfer-layout">
          <div className="card">
          {freeAgents.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🆓</span>
              No free agents available.
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
                      position={fa.position}
                      overall={fa.overall}
                      age={fa.age}
                      onClick={() => setPlayerTarget({ id: fa.playerId, name: fa.playerName })}
                      meta={
                        <>
                          Salary {money(fa.salary)}/season · Value {money(fa.value)} · Signing <b style={{ color: "var(--gold-2)" }}>{money(fa.currentPrice)}</b> · Bidders {fa.bidderCount}
                        </>
                      }
                      sub={<>Ends in <AuctionCountdown deadline={fa.deadline} paused={status?.paused} /></>}
                      statusChip={<TransferStatusChips amILeading={fa.amILeading} outbid={outbid} myMaxBid={fa.myMaxBid} myMaxLabel="Your max" />}
                      right={
                        <>
                          <button className="btn ghost" onClick={() => void openAuctionHistory(fa as never, "FREE_AGENT")}>History</button>
                          <button className="btn" {...pauseLock} onClick={() => { setFreeAgentTarget(fa); setFreeAgentContractSeasons(fa.myContractSeasons ?? 1); setFreeAgentBidAmount(Math.max(fa.openingPrice, fa.currentPrice + fa.bidIncrement)); }}>
                            {strings.transfers.sign}
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </div>
              {filteredFreeAgents.length === 0 && <div className="empty-state">No free agents match your filters.</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={freeFilters}
            onChange={setFreeFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredFreeAgents.length}
            totalCount={freeAgents.length}
            priceLabel="Signing fee"
          />
        </div>
      )}

      {tab === "loans" && (
        <div className="transfer-layout">
          <div className="card">
          {loading ? <div className="empty-state">{strings.common.loading}</div> : loans.length === 0 ? <div className="empty-state">No players are currently listed for loan.</div> : (
            <>
              <div className="transfer-rows">
                {filteredLoans.map((row) => (
                  <TransferPlayerRow
                    key={row.loan.id}
                    name={row.name}
                    position={row.position}
                    overall={row.overall}
                    age={row.age}
                    onClick={() => setPlayerTarget({ id: row.id, name: row.name })}
                    meta={
                      <>
                        Salary {money(row.salary)}/season · From <ClubNameLink clubId={row.loan.fromClubId} name={row.loan.fromClub} showCrest={false} />
                      </>
                    }
                    statusChip={
                      !row.loan.available && row.loan.claimableIn > 0 && !row.loan.toClub
                        ? <span className="chip">Claimable in {formatDuration(row.loan.claimableIn * 1000)}</span>
                        : !row.loan.available && row.loan.toClub
                          ? (
                            <span className="chip">
                              At {row.loan.toClubId != null ? <ClubNameLink clubId={row.loan.toClubId} name={row.loan.toClub} showCrest={false} /> : row.loan.toClub}
                            </span>
                          )
                          : undefined
                    }
                    right={
                      row.loan.available
                        ? <button className="btn" title={strings.transfers.borrowLoanHint} {...pauseLock} onClick={() => setLoanTarget(row.loan)}>View profile & take</button>
                        : undefined
                    }
                  />
                ))}
              </div>
              {filteredLoans.length === 0 && <div className="empty-state">No loan listings match your filters.</div>}
            </>
          )}
          </div>
          <TransferFiltersSidebar
            filters={loanFilters}
            onChange={setLoanFilters}
            sortOptions={SORT_OPTIONS}
            resultCount={filteredLoans.length}
            totalCount={loanRows.length}
            priceLabel="Loan fee"
          />
        </div>
      )}

      {tab === "sell" && (
        <div className="transfer-layout">
          <div className="card">
          {myActiveListings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>Your active listings</div>
              <div className="transfer-rows">
                {myActiveListings.map((a) => (
                  <TransferPlayerRow
                    key={a.id}
                    name={a.playerName}
                    position={a.position}
                    overall={a.overall}
                    age={a.age}
                    onClick={() => setPlayerTarget({ id: a.playerId, name: a.playerName })}
                    meta={
                      <>
                        Current <b style={{ color: "var(--gold-2)" }}>{money(a.currentPrice)}</b> · {a.bidderCount} bidders
                      </>
                    }
                    sub={<>Ends in <AuctionCountdown deadline={a.deadline} paused={status?.paused} /></>}
                    right={
                      a.bidderCount === 0
                        ? <button className="btn ghost" {...pauseLock} onClick={() => cancelListing(a)}>Cancel listing</button>
                        : <span className="chip">Bids received — cannot cancel</span>
                    }
                  />
                ))}
              </div>
            </div>
          )}
          {squad.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>📤</span>
              No players available to sell.
            </div>
          ) : (
            <>
              <div className="kicker" style={{ marginBottom: 6 }}>List a player</div>
              <div className="transfer-rows">
                {filteredSellable.map((p) => (
                  <TransferPlayerRow
                    key={p.id}
                    name={p.displayName ?? p.name}
                    position={p.position}
                    overall={p.overall}
                    age={p.age}
                    onClick={() => setPlayerTarget({ id: p.id, name: p.name })}
                    meta={<>OVR <b style={{ color: "var(--text-2)" }}>{p.overall}</b> · Value {money(p.value)}</>}
                    right={<button className="btn ghost" {...pauseLock} onClick={() => setSellPlayer(p)}>{strings.transfers.sell}</button>}
                  />
                ))}
              </div>
              {filteredSellable.length === 0 && <div className="empty-state">No squad players match your filters.</div>}
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

      <Dialog header={`${strings.transfers.sign} — ${freeAgentTarget?.playerName ?? ""}`} visible={freeAgentTarget !== null} onHide={() => setFreeAgentTarget(null)} dismissableMask style={{ width: 400 }}>
        {freeAgentTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3 title={positionTitle(freeAgentTarget.position)}>{POSITION_LETTER[freeAgentTarget.position] ?? "Player"}</h3>
              </div>
              <span className="transfer-overall">{freeAgentTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={freeAgentTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>Exact salary demand: <b>{money(freeAgentTarget.contractDemandsBySeason?.[freeAgentContractSeasons] ?? freeAgentTarget.salary)}/season</b></div>
              <div>Contract: <b>Current season + {freeAgentContractSeasons} full season{freeAgentContractSeasons === 1 ? "" : "s"}</b></div>
              <div style={{ marginTop: 4 }}>
                Current signing fee: <b style={{ color: "var(--gold-2)" }}>{money(freeAgentTarget.currentPrice)}</b> · Bidders: {freeAgentTarget.bidderCount} · Ends in <AuctionCountdown deadline={freeAgentTarget.deadline} paused={status?.paused} />
              </div>
              {freeAgentTarget.myMaxBid !== null && (
                <div style={{ marginTop: 4 }}>
                  Your current max: <b>{money(freeAgentTarget.myMaxBid)}</b> {freeAgentTarget.amILeading ? "· You are leading" : "· You are outbid"}
                </div>
              )}
            </div>
          </>
        )}
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="fa-contract-term">Contract term</label>
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
            {strings.transfers.yourBid} (minimum {money(freeAgentTarget ? Math.max(freeAgentTarget.openingPrice, freeAgentTarget.myMaxBid ?? 0, freeAgentTarget.currentPrice + freeAgentTarget.bidIncrement) : 0)})
          </label>
          <InputNumber id="fa-bid" value={freeAgentBidAmount} onValueChange={(e) => setFreeAgentBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        {cushionWarning(cushionProjection(freeAgentBidAmount, freeAgentTarget?.contractDemandsBySeason?.[freeAgentContractSeasons] ?? freeAgentTarget?.salary ?? 0, freeAgentTarget?.myMaxBid ?? null, freeAgentTarget?.amILeading ?? false))}
        <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 8 }}>
          The signing fee is paid to the system. Salary is charged through normal payroll, not immediately. Your maximum is private and cannot be lowered once submitted.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setFreeAgentTarget(null)}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} {...pauseLock} onClick={submitFreeAgentBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`${strings.transfers.bid} — ${auctionBidTarget?.playerName ?? ""}`} visible={auctionBidTarget !== null} onHide={() => setAuctionBidTarget(null)} dismissableMask style={{ width: 400 }}>
        {auctionBidTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3 title={positionTitle(auctionBidTarget.position)}>{POSITION_LETTER[auctionBidTarget.position] ?? "Player"}</h3>
              </div>
              <span className="transfer-overall">{auctionBidTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={auctionBidTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>Exact salary demand: <b>{money(auctionBidTarget.contractDemandsBySeason?.[auctionContractSeasons] ?? auctionBidTarget.salary)}/season</b></div>
              <div>Contract: <b>Current season + {auctionContractSeasons} full season{auctionContractSeasons === 1 ? "" : "s"}</b></div>
              <div style={{ marginTop: 4 }}>
                Current price: <b style={{ color: "var(--gold-2)" }}>{money(auctionBidTarget.currentPrice)}</b> · Bidders: {auctionBidTarget.bidderCount} · Ends in <AuctionCountdown deadline={auctionBidTarget.deadline} paused={status?.paused} />
              </div>
              {auctionBidTarget.myMaxBid !== null && (
                <div style={{ marginTop: 4 }}>
                  Your current max: <b>{money(auctionBidTarget.myMaxBid)}</b> {auctionBidTarget.amILeading ? "· You are leading" : "· You are outbid"}
                </div>
              )}
            </div>
          </>
        )}
        <div className="form-group" style={{ marginTop: 12 }}>
          <label htmlFor="auc-contract-term">Contract term</label>
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
            {strings.transfers.yourBid} (minimum {money(auctionBidTarget ? Math.max(auctionBidTarget.openingPrice, auctionBidTarget.myMaxBid ?? 0, auctionBidTarget.currentPrice + auctionBidTarget.bidIncrement) : 0)})
          </label>
          <InputNumber id="auc-bid" value={auctionBidAmount} onValueChange={(e) => setAuctionBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        {cushionWarning(cushionProjection(auctionBidAmount, auctionBidTarget?.contractDemandsBySeason?.[auctionContractSeasons] ?? auctionBidTarget?.salary ?? 0, auctionBidTarget?.myMaxBid ?? null, auctionBidTarget?.amILeading ?? false))}
        <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginBottom: 8 }}>
          Salary is charged through normal payroll, not immediately. Your maximum is private and cannot be lowered once submitted. The market clears at the second-highest max plus increment.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setAuctionBidTarget(null)}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} {...pauseLock} onClick={submitAuctionBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`Loan — ${loanTarget?.player?.name ?? ""}`} visible={loanTarget !== null} onHide={() => setLoanTarget(null)} dismissableMask style={{ width: 430 }}>
        {loanTarget?.player && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3><span title={positionTitle(loanTarget.player.position)}>{loanTarget.player.positionName}</span> · {loanTarget.player.age} yrs</h3>
                <div style={{ color: "var(--text-2)", marginTop: 4 }}>
                  From <ClubNameLink clubId={loanTarget.fromClubId} name={loanTarget.fromClub} showCrest={false} /> · Salary {money(loanTarget.player.salary)}/season
                </div>
              </div>
              <span className="transfer-overall">{loanTarget.player.overall}</span>
            </div>
            <PlayerSkillsRadar skills={loanTarget.player.skills} />
            <div className="stats-row" style={{ marginTop: 14 }}>
              <div className="stat"><div className="label">Value</div><div className="value">{money(loanTarget.player.value)}</div></div>
              <div className="stat"><div className="label">Contract</div><div className="value">{seasonsOf(loanTarget.player.contractDays)}</div></div>
            </div>
            {loanCushionProjection(loanTarget) !== null && loanCushionProjection(loanTarget)! < 0 && (
              <div className="card" style={{ marginTop: 12, padding: 10, fontSize: "0.88rem", color: "var(--gold-2)", borderColor: "var(--gold-2)" }}>
                This loan would reduce your financial cushion to <b style={{ color: "var(--red-2)" }}>{money(loanCushionProjection(loanTarget)!)}</b>.
                You may continue, but future payroll could require financial intervention.
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setLoanTarget(null)}>{strings.common.cancel}</button>
              <button className="btn" style={{ flex: 1 }} title={strings.transfers.borrowLoanHint} {...pauseLock} onClick={() => takeLoan(loanTarget)}>{strings.transfers.loan}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={historyTarget ? `${(historyTarget as AuctionView).playerName ?? (historyTarget as FreeAgentView).playerName} — Full history` : "Full history"} visible={historyTarget !== null} onHide={() => { setHistoryTarget(null); setHistoryData(null); }} dismissableMask style={{ width: 520 }}>
        {!historyData ? <div className="empty-state" style={{ padding: 20 }}>Loading…</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 800 }}>{historyData.player.displayName} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>· {historyData.player.age} yrs · OVR {historyData.player.overall}</span></div>
              <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginTop: 4 }}>Career {historyData.player.careerGoals}G {(historyData.player.careerAssists ?? 0)}A · Season {historyData.player.seasonGoals}G</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 2 }}>{(historyData.player.careerMvps ?? 0) > 0 ? `${historyData.player.careerMvps} career MVP · ` : ""}{(historyData.player.seasonMvps ?? 0) > 0 ? `${historyData.player.seasonMvps} MVP this season` : ""}</div>
            </div>
            <div><div className="section-label">Per-season</div>{historyData.seasons.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No season history yet.</div> : historyData.seasons.map((s, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>{s.seasonKey} · {s.clubName}</span><span>{s.goals}G {s.assists}A</span></div>)}</div>
            <div><div className="section-label">Market moves</div>{historyData.transfers.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No moves.</div> : historyData.transfers.map((t, i) => <div key={i} className="news-item">{t.type} {money(t.price)} {t.seasonKey}</div>)}</div>
            <div><div className="section-label">Recent matches</div>{historyData.matches.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No match events.</div> : historyData.matches.slice(0, 12).map((m, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>Type {m.type} {m.minute}'</span></div>)}</div>
            <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>Auction view shows full history to everyone while listing is active.</div>
          </div>
        )}
      </Dialog>

      <PlayerDetailsDialog target={playerTarget} onClose={() => setPlayerTarget(null)} />
    </div>
  );
}
