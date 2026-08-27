import { money } from "../../format";

/** Bid-state chips shared by the auction and free-agent rows. */
export function TransferStatusChips({
  amILeading,
  outbid,
  myMaxBid,
  myMaxLabel,
}: {
  amILeading: boolean;
  outbid: boolean;
  myMaxBid: number | null;
  myMaxLabel: string;
}) {
  if (amILeading) {
    return (
      <span className="chip" style={{ marginTop: 4, color: "var(--grass-2)", borderColor: "var(--grass-2)" }}>
        You are leading
      </span>
    );
  }
  if (outbid) {
    return (
      <span className="chip" style={{ marginTop: 4, color: "var(--danger, #d66)", borderColor: "var(--danger, #d66)" }}>
        Outbid — raise your max
      </span>
    );
  }
  if (myMaxBid !== null) {
    return (
      <div style={{ color: "var(--text-3)", fontSize: "0.84rem", marginTop: 4 }}>
        {myMaxLabel}: {money(myMaxBid)}
      </div>
    );
  }
  return null;
}
