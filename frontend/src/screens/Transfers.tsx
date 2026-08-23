import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { Toast } from "primereact/toast";
import { Gavel, HandCoins, Users } from "lucide-react";
import { api, type AuctionView, type FinanceSnapshot, type FreeAgentView, type LoanView, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { useSettings } from "../store/settings";
import { strings } from "../strings";
import { PlayerName, POSITION_CLASS, POSITION_LETTER } from "../components/PlayerName";
import { ClubNameLink } from "../components/ClubNameLink";
import { PlayerSkillsRadar } from "../components/PlayerSkillsRadar";
import { Segmented } from "../components/Segmented";
import { money } from "../format";
import { formatDuration, useCountdown } from "../components/useCountdown";
import { auctionOpeningRange } from "../market";

type Tab = "auctions" | "free" | "loans" | "sell";

function AuctionCountdown({ deadline }: { deadline: number }) {
  const remaining = useCountdown(deadline);
  if (remaining <= 0) return <span style={{ color: "var(--danger, #d66)" }}>Closing</span>;
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(remaining)}</span>;
}

export function Transfers() {
  const { snapshot, refresh } = useGame();
  const maxContractSeasons = useSettings((s) => s.maxContractSeasons);
  const [auctions, setAuctions] = useState<AuctionView[]>([]);
  const [freeAgents, setFreeAgents] = useState<FreeAgentView[]>([]);
  const [loans, setLoans] = useState<LoanView[]>([]);
  const [tab, setTab] = useState<Tab>("auctions");
  const [sellPlayer, setSellPlayer] = useState<PlayerView | null>(null);
  const [sellPreview, setSellPreview] = useState<{ value: number; baseValue: number; openingPriceRange: { min: number; max: number }; cooldownError: string | null; alreadyListed: boolean } | null>(null);
  const [sellPrice, setSellPrice] = useState(0);
  const [freeAgentTarget, setFreeAgentTarget] = useState<FreeAgentView | null>(null);
  const [freeAgentBidAmount, setFreeAgentBidAmount] = useState(0);
  const [freeAgentContractSeasons, setFreeAgentContractSeasons] = useState(1);
  const [loanTarget, setLoanTarget] = useState<LoanView | null>(null);
  const [auctionBidTarget, setAuctionBidTarget] = useState<AuctionView | null>(null);
  const [auctionBidAmount, setAuctionBidAmount] = useState(0);
  const [auctionContractSeasons, setAuctionContractSeasons] = useState(1);
  const [historyTarget, setHistoryTarget] = useState<AuctionView | FreeAgentView | null>(null);
  const [historyData, setHistoryData] = useState<{ player: { displayName: string; name: string; age: number; overall: number; careerGoals: number; careerAssists?: number; seasonGoals: number; seasonAssists?: number }; seasons: { seasonKey: string; clubName: string; goals: number; assists: number }[]; transfers: { type: string; price: number; seasonKey: string }[]; matches: { minute: number; type: number }[] } | null>(null);
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  const sell = async () => {
    if (!sellPlayer) return;
    try {
      await api.sellPlayer(sellPlayer.id, sellPrice > 0 ? sellPrice : undefined);
      toast.current?.show({ severity: "success", summary: "Player listed for auction" });
      setSellPlayer(null);
      setSellPreview(null);
      setSellPrice(0);
      refresh();
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const openSellDialog = async (p: PlayerView) => {
    setSellPlayer(p);
      setSellPreview(null);
      setSellPrice(0);
      try {
        const preview = await api.auctionPreview(p.id);
        setSellPreview(preview);
        setSellPrice(preview.openingPriceRange.max);
      } catch {
        // Fall back to the client-side estimate when the preview is unavailable.
        const range = auctionOpeningRange(p.value);
        setSellPreview({ value: p.value, baseValue: p.value, openingPriceRange: range, cooldownError: null, alreadyListed: false });
        setSellPrice(range.max);
      }
  };

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
        <div className="card">
          {loading ? (
            <div className="empty-state">{strings.common.loading}</div>
          ) : auctions.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🔨</span>
              No auctions right now. Check back after the next match day.
            </div>
          ) : (
            <div className="grid stagger">
              {auctions.map((a) => {
                const outbid = a.myMaxBid !== null && !a.amILeading;
                return (
                  <div className="card hoverable" key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                        <span className={`pos-tag ${POSITION_CLASS[a.position]}`}>{POSITION_LETTER[a.position]}</span>
                        {a.playerName}
                        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.15rem", color: "var(--grass-2)" }}>{a.overall}</span>
                      </div>
                      <div style={{ color: "var(--text-3)", fontSize: "0.86rem", marginTop: 5 }}>
                        {a.age} yrs · Salary <b style={{ color: "var(--text-2)" }}>{money(a.salary)}/season</b> · Opening <b style={{ color: "var(--text-2)" }}>{money(a.openingPrice)}</b> · Current <b style={{ color: "var(--gold-2)" }}>{money(a.currentPrice)}</b> · Bidders {a.bidderCount}
                      </div>
                      <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 2 }}>
                        Ends in <AuctionCountdown deadline={a.deadline} />
                      </div>
                      {a.amILeading && (
                        <span className="chip" style={{ marginTop: 4, color: "var(--grass-2)", borderColor: "var(--grass-2)" }}>You are leading</span>
                      )}
                      {outbid && (
                        <span className="chip" style={{ marginTop: 4, color: "var(--danger, #d66)", borderColor: "var(--danger, #d66)" }}>Outbid — raise your max</span>
                      )}
                      {!a.amILeading && !outbid && a.myMaxBid !== null && (
                        <div style={{ color: "var(--text-3)", fontSize: "0.84rem", marginTop: 4 }}>Your max: {money(a.myMaxBid)}</div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn ghost" onClick={() => void openAuctionHistory(a, "TRANSFER")}>History</button>
                      <button className="btn" onClick={() => { setAuctionBidTarget(a); setAuctionContractSeasons(a.myContractSeasons ?? 1); setAuctionBidAmount(Math.max(a.openingPrice, a.currentPrice + a.bidIncrement)); }}>
                        {a.myMaxBid !== null ? "Increase Max" : strings.transfers.bid}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "free" && (
        <div className="card">
          {freeAgents.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🆓</span>
              No free agents available.
            </div>
          ) : (
            <div className="grid stagger">
              {freeAgents.map((fa) => (
                <div className="card hoverable" key={fa.id} style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{fa.playerName}</div>
                    <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5 }}>
                      OVR <b style={{ color: "var(--text-2)" }}>{fa.overall}</b> · {fa.age} yrs · Salary {money(fa.salary)}/season · Value {money(fa.value)} · Signing {money(fa.currentPrice)} · Bidders {fa.bidderCount}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn ghost" onClick={() => void openAuctionHistory(fa as never, "FREE_AGENT")}>History</button>
                    <button className="btn" onClick={() => { setFreeAgentTarget(fa); setFreeAgentContractSeasons(fa.myContractSeasons ?? 1); setFreeAgentBidAmount(Math.max(fa.openingPrice, fa.currentPrice + fa.bidIncrement)); }}>
                      {strings.transfers.sign}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "loans" && (
        <div className="card">
          {loading ? <div className="empty-state">{strings.common.loading}</div> : loans.length === 0 ? <div className="empty-state">No players are currently listed for loan.</div> : (
            <div className="grid stagger">
              {loans.map((loan) => loan.player && (
                <div className="card hoverable" key={loan.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{loan.player.name}</div>
                    <div className="hint">
                      {loan.player.overall} OVR · {loan.player.age} yrs · Salary {money(loan.player.salary)}/season · From{" "}
                      <ClubNameLink clubId={loan.fromClubId} name={loan.fromClub} showCrest={false} />
                    </div>
                  </div>
                  {loan.available && <button className="btn" title={strings.transfers.borrowLoanHint} onClick={() => setLoanTarget(loan)}>View profile & take</button>}
                  {!loan.available && loan.claimableIn > 0 && !loan.toClub && <span className="chip">Claimable in {formatDuration(loan.claimableIn * 1000)}</span>}
                  {!loan.available && loan.toClub && (
                    <span className="chip">
                      At {loan.toClubId != null ? <ClubNameLink clubId={loan.toClubId} name={loan.toClub} showCrest={false} /> : loan.toClub}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "sell" && (
        <div className="card">
          {myActiveListings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>Your active listings</div>
              {myActiveListings.map((a) => (
                <div className="card" key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{a.playerName} · {a.overall} OVR</div>
                    <div className="hint">Current {money(a.currentPrice)} · {a.bidderCount} bidders · Ends in <AuctionCountdown deadline={a.deadline} /></div>
                  </div>
                  {a.bidderCount === 0 && (
                    <button className="btn ghost" onClick={() => cancelListing(a)}>Cancel listing</button>
                  )}
                  {a.bidderCount > 0 && <span className="chip">Bids received — cannot cancel</span>}
                </div>
              ))}
            </div>
          )}
          {squad.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>📤</span>
              No players available to sell.
            </div>
          ) : (
            <div className="grid stagger">
              {squad.filter((p) => !p.onSale && !p.onLoan && !p.onLoanOut).map((p) => (
                <div className="card hoverable" key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <div>
                    <PlayerName player={p} />
                    <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5 }}>
                      OVR <b style={{ color: "var(--text-2)" }}>{p.overall}</b> · Value {money(p.value)}
                    </div>
                  </div>
                  <button className="btn ghost" onClick={() => openSellDialog(p)}>
                    {strings.transfers.sell}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog header={`${strings.transfers.sell} — ${sellPlayer?.name ?? ""}`} visible={sellPlayer !== null} onHide={() => { setSellPlayer(null); setSellPreview(null); setSellPrice(0); }} style={{ width: 400 }}>
        <div style={{ display: "grid", gap: 6, color: "var(--text-2)", marginBottom: 16 }}>
          {sellPreview ? (
            <>
              <span>Value: <b style={{ color: "var(--gold-2)" }}>{money(sellPreview.value)}</b></span>
              <span>Opening price base: <b style={{ color: "var(--gold-2)" }}>{money(sellPreview.baseValue)}</b></span>
              <span>Allowed range: <b style={{ color: "var(--gold-2)" }}>{money(sellPreview.openingPriceRange.min)} – {money(sellPreview.openingPriceRange.max)}</b></span>
              <span style={{ fontSize: "0.86rem", color: "var(--text-3)" }}>Choose the opening asking price inside the allowed range. Bidding may go above it up to the market cap.</span>
              <div style={{ marginTop: 8 }}>
                <InputNumber value={sellPrice} onValueChange={(e) => setSellPrice(e.value ?? 0)} min={sellPreview.openingPriceRange.min} max={sellPreview.openingPriceRange.max} mode="currency" currency="USD" locale="en-US" />
              </div>
            </>
          ) : (
            <span>Loading listing preview…</span>
          )}
        </div>
        {sellPreview?.cooldownError && (
          <div className="card" style={{ marginBottom: 12, padding: 12, fontSize: "0.9rem", color: "var(--danger, #d66)" }}>
            {sellPreview.cooldownError}
          </div>
        )}
        {sellPreview?.alreadyListed && (
          <div className="card" style={{ marginBottom: 12, padding: 12, fontSize: "0.9rem", color: "var(--text-3)" }}>
            This player already has an active listing.
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setSellPlayer(null); setSellPreview(null); setSellPrice(0); }}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} disabled={!sellPreview || !!sellPreview.cooldownError || sellPreview.alreadyListed || sellPrice < sellPreview.openingPriceRange.min || sellPrice > sellPreview.openingPriceRange.max} onClick={sell}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`${strings.transfers.sign} — ${freeAgentTarget?.playerName ?? ""}`} visible={freeAgentTarget !== null} onHide={() => setFreeAgentTarget(null)} style={{ width: 400 }}>
        {freeAgentTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3>{POSITION_LETTER[freeAgentTarget.position] ?? "Player"}</h3>
              </div>
              <span className="transfer-overall">{freeAgentTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={freeAgentTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>Exact salary demand: <b>{money(freeAgentTarget.contractDemandsBySeason?.[freeAgentContractSeasons] ?? freeAgentTarget.salary)}/season</b></div>
              <div>Contract: <b>Current season + {freeAgentContractSeasons} full season{freeAgentContractSeasons === 1 ? "" : "s"}</b></div>
              <div style={{ marginTop: 4 }}>
                Current signing fee: <b style={{ color: "var(--gold-2)" }}>{money(freeAgentTarget.currentPrice)}</b> · Bidders: {freeAgentTarget.bidderCount} · Ends in <AuctionCountdown deadline={freeAgentTarget.deadline} />
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
          <button className="btn" style={{ flex: 1 }} onClick={submitFreeAgentBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`${strings.transfers.bid} — ${auctionBidTarget?.playerName ?? ""}`} visible={auctionBidTarget !== null} onHide={() => setAuctionBidTarget(null)} style={{ width: 400 }}>
        {auctionBidTarget && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3>{POSITION_LETTER[auctionBidTarget.position] ?? "Player"}</h3>
              </div>
              <span className="transfer-overall">{auctionBidTarget.overall}</span>
            </div>
            <PlayerSkillsRadar skills={auctionBidTarget.skills} />
            <div style={{ color: "var(--text-2)", marginTop: 8 }}>
              <div>Exact salary demand: <b>{money(auctionBidTarget.contractDemandsBySeason?.[auctionContractSeasons] ?? auctionBidTarget.salary)}/season</b></div>
              <div>Contract: <b>Current season + {auctionContractSeasons} full season{auctionContractSeasons === 1 ? "" : "s"}</b></div>
              <div style={{ marginTop: 4 }}>
                Current price: <b style={{ color: "var(--gold-2)" }}>{money(auctionBidTarget.currentPrice)}</b> · Bidders: {auctionBidTarget.bidderCount} · Ends in <AuctionCountdown deadline={auctionBidTarget.deadline} />
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
          <button className="btn" style={{ flex: 1 }} onClick={submitAuctionBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`Loan — ${loanTarget?.player?.name ?? ""}`} visible={loanTarget !== null} onHide={() => setLoanTarget(null)} style={{ width: 430 }}>
        {loanTarget?.player && (
          <>
            <div className="transfer-player-summary">
              <div>
                <div className="kicker">Player profile</div>
                <h3>{loanTarget.player.positionName} · {loanTarget.player.age} yrs</h3>
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
              <button className="btn" style={{ flex: 1 }} title={strings.transfers.borrowLoanHint} onClick={() => takeLoan(loanTarget)}>{strings.transfers.loan}</button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog header={historyTarget ? `${(historyTarget as AuctionView).playerName ?? (historyTarget as FreeAgentView).playerName} — Full history` : "Full history"} visible={historyTarget !== null} onHide={() => { setHistoryTarget(null); setHistoryData(null); }} style={{ width: 520 }}>
        {!historyData ? <div className="empty-state" style={{ padding: 20 }}>Loading…</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 800 }}>{historyData.player.displayName} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>· {historyData.player.age} yrs · OVR {historyData.player.overall}</span></div>
              <div style={{ color: "var(--text-2)", fontSize: "0.85rem", marginTop: 4 }}>Career {historyData.player.careerGoals}G {(historyData.player.careerAssists ?? 0)}A · Season {historyData.player.seasonGoals}G</div>
            </div>
            <div><div className="section-label">Per-season</div>{historyData.seasons.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No season history yet.</div> : historyData.seasons.map((s, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>{s.seasonKey} · {s.clubName}</span><span>{s.goals}G {s.assists}A</span></div>)}</div>
            <div><div className="section-label">Market moves</div>{historyData.transfers.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No moves.</div> : historyData.transfers.map((t, i) => <div key={i} className="news-item">{t.type} {money(t.price)} {t.seasonKey}</div>)}</div>
            <div><div className="section-label">Recent matches</div>{historyData.matches.length === 0 ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>No match events.</div> : historyData.matches.slice(0, 12).map((m, i) => <div key={i} className="news-item" style={{ display: "flex", justifyContent: "space-between" }}><span>Type {m.type} {m.minute}'</span></div>)}</div>
            <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>Auction view shows full history to everyone while listing is active.</div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
