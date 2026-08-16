import { useEffect, useRef, useState } from "react";
import { Dialog } from "primereact/dialog";
import { InputNumber } from "primereact/inputnumber";
import { Toast } from "primereact/toast";
import { Gavel, HandCoins, Users } from "lucide-react";
import { api, type AuctionView, type PlayerView } from "../api/client";
import { useGame } from "../store/game";
import { strings } from "../strings";
import { PlayerName, POSITION_CLASS, POSITION_LETTER } from "../components/PlayerName";
import { Segmented } from "../components/Segmented";
import { money } from "../format";

type Tab = "auctions" | "free" | "sell";

export function Transfers() {
  const { snapshot, saveId, refresh } = useGame();
  const [auctions, setAuctions] = useState<AuctionView[]>([]);
  const [tab, setTab] = useState<Tab>("auctions");
  const [sellPlayer, setSellPlayer] = useState<PlayerView | null>(null);
  const [sellMode, setSellMode] = useState<"auction" | "fixed">("auction");
  const [sellPrice, setSellPrice] = useState(0);
  const [bidTarget, setBidTarget] = useState<{ playerId: number; name: string; value: number } | null>(null);
  const [bidAmount, setBidAmount] = useState(0);
  const [auctionBidTarget, setAuctionBidTarget] = useState<AuctionView | null>(null);
  const [auctionBidAmount, setAuctionBidAmount] = useState(0);
  const toast = useRef<Toast>(null);

  const loadAuctions = async () => {
    if (!saveId) return;
    setAuctions((await api.listAuctions(saveId)).auctions);
  };

  useEffect(() => {
    loadAuctions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId]);

  const sell = async () => {
    if (!saveId || !sellPlayer) return;
    try {
      await api.sellPlayer(saveId, sellPlayer.id, sellMode, sellMode === "fixed" ? sellPrice : undefined);
      toast.current?.show({ severity: "success", summary: "Player listed for sale" });
      setSellPlayer(null);
      refresh();
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const submitBid = async () => {
    if (!saveId || !bidTarget) return;
    try {
      const res = await api.bidPlayer(saveId, bidTarget.playerId, bidAmount);
      if (res.accepted) {
        toast.current?.show({ severity: "success", summary: strings.transfers.bidAccepted });
      } else {
        toast.current?.show({
          severity: "info",
          summary: strings.transfers.bidRejected,
          detail: res.counter ? `Counter-offer: ${money(res.counter)}` : undefined,
        });
      }
      setBidTarget(null);
      refresh();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const submitAuctionBid = async () => {
    if (!saveId || !auctionBidTarget) return;
    try {
      await api.bidAuction(saveId, auctionBidTarget.id, auctionBidAmount);
      toast.current?.show({ severity: "success", summary: "Bid placed" });
      setAuctionBidTarget(null);
      loadAuctions();
    } catch (e) {
      toast.current?.show({ severity: "error", summary: "Error", detail: (e as Error).message });
    }
  };

  const freeAgents = snapshot?.freeAgents ?? [];
  const squad = snapshot?.squad ?? [];

  return (
    <div>
      <Toast ref={toast} />
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
            { value: "sell", label: strings.transfers.sell, icon: <HandCoins size={14} /> },
          ]}
        />
      </div>

      {tab === "auctions" && (
        <div className="card">
          {auctions.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>🔨</span>
              No auctions right now. Check back after the next match day.
            </div>
          ) : (
            <div className="grid stagger">
              {auctions.map((a) => (
                <div className="card hoverable" key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                      <span className={`pos-tag ${POSITION_CLASS[a.position]}`}>{POSITION_LETTER[a.position]}</span>
                      {a.playerName}
                      <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.15rem", color: "var(--grass-2)" }}>{a.overall}</span>
                    </div>
                    <div style={{ color: "var(--text-3)", fontSize: "0.86rem", marginTop: 5 }}>
                      {a.age} yrs · Min bid <b style={{ color: "var(--text-2)" }}>{money(a.minBid)}</b> · Current <b style={{ color: "var(--gold-2)" }}>{money(a.currentBid)}</b>
                    </div>
                    <div style={{ color: "var(--text-3)", fontSize: "0.8rem", marginTop: 2 }}>Ends {a.deadlineLabel}</div>
                    {a.myBid > 0 && <div style={{ color: "var(--grass-2)", fontSize: "0.84rem", marginTop: 4 }}>Your bid: {money(a.myBid)}</div>}
                  </div>
                  <button className="btn" onClick={() => { setAuctionBidTarget(a); setAuctionBidAmount(Math.max(a.minBid, a.currentBid + 1000)); }}>
                    {strings.transfers.bid}
                  </button>
                </div>
              ))}
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
              {freeAgents.map((p) => (
                <div className="card hoverable" key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <div>
                    <PlayerName player={p} />
                    <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5 }}>
                      OVR <b style={{ color: "var(--text-2)" }}>{p.overall}</b> · {p.age} yrs · Value {money(p.value)}
                    </div>
                  </div>
                  <button className="btn" onClick={() => { setBidTarget({ playerId: p.id, name: p.name, value: p.value }); setBidAmount(p.value); }}>
                    {strings.transfers.sign}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "sell" && (
        <div className="card">
          {squad.filter((p) => !p.isStar).length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: 26 }}>📤</span>
              No players available to sell.
            </div>
          ) : (
            <div className="grid stagger">
              {squad.filter((p) => !p.isStar && !p.onSale).map((p) => (
                <div className="card hoverable" key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <div>
                    <PlayerName player={p} />
                    <div style={{ color: "var(--text-3)", fontSize: "0.82rem", marginTop: 5 }}>
                      OVR <b style={{ color: "var(--text-2)" }}>{p.overall}</b> · Value {money(p.value)}
                    </div>
                  </div>
                  <button className="btn ghost" onClick={() => { setSellPlayer(p); setSellPrice(p.value); setSellMode("auction"); }}>
                    {strings.transfers.sell}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog header={`${strings.transfers.sell} — ${sellPlayer?.name ?? ""}`} visible={sellPlayer !== null} onHide={() => setSellPlayer(null)} style={{ width: 400 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, justifyContent: "center" }}>
          <Segmented
            value={sellMode}
            onChange={(v) => setSellMode(v)}
            items={[
              { value: "auction", label: strings.transfers.auction },
              { value: "fixed", label: strings.transfers.fixedPrice },
            ]}
          />
        </div>
        {sellMode === "fixed" && (
          <div className="form-group">
            <label htmlFor="sell-price">{strings.transfers.price}</label>
            <InputNumber id="sell-price" value={sellPrice} onValueChange={(e) => setSellPrice(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setSellPlayer(null)}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} onClick={sell}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`${strings.transfers.bid} — ${bidTarget?.name ?? ""}`} visible={bidTarget !== null} onHide={() => setBidTarget(null)} style={{ width: 400 }}>
        <p style={{ color: "var(--text-2)", marginTop: 0 }}>
          Market value: <b style={{ color: "var(--gold-2)" }}>{money(bidTarget?.value ?? 0)}</b>
        </p>
        <div className="form-group">
          <label htmlFor="bid-amount">{strings.transfers.yourBid}</label>
          <InputNumber id="bid-amount" value={bidAmount} onValueChange={(e) => setBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setBidTarget(null)}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} onClick={submitBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>

      <Dialog header={`${strings.transfers.bid} — ${auctionBidTarget?.playerName ?? ""}`} visible={auctionBidTarget !== null} onHide={() => setAuctionBidTarget(null)} style={{ width: 400 }}>
        <div className="form-group">
          <label htmlFor="auc-bid">{strings.transfers.yourBid} (min {money(auctionBidTarget?.minBid ?? 0)})</label>
          <InputNumber id="auc-bid" value={auctionBidAmount} onValueChange={(e) => setAuctionBidAmount(e.value ?? 0)} mode="currency" currency="USD" locale="en-US" style={{ width: "100%" }} inputStyle={{ width: "100%" }} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setAuctionBidTarget(null)}>{strings.common.cancel}</button>
          <button className="btn" style={{ flex: 1 }} onClick={submitAuctionBid}>{strings.common.confirm}</button>
        </div>
      </Dialog>
    </div>
  );
}
