import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "primereact/dialog";

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the dialog shows a reason input that must reach this many characters. */
  minReasonLength?: number;
  reasonHint?: string;
  onConfirm: (reason: string) => Promise<unknown>;
}

/**
 * Confirmation dialog for admin actions. Mirrors Squad's confirm pattern:
 * PrimeReact Dialog + busy state, with an optional audit-reason field.
 */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason("");
    setBusy(false);
    setError(null);
  }, [request]);

  if (!request) return null;
  const reasonReady = !request.minReasonLength || reason.trim().length >= request.minReasonLength;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await request.onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog header={request.title} visible onHide={onClose} style={{ width: 440 }}>
      <div style={{ color: "var(--text-2)", lineHeight: 1.5 }}>{request.message}</div>
      {request.minReasonLength !== undefined && (
        <div className="form-group" style={{ marginTop: 14 }}>
          <label htmlFor="admin-confirm-reason">Audit reason</label>
          <input
            id="admin-confirm-reason"
            type="text"
            value={reason}
            autoFocus
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder={request.reasonHint ?? `Required — at least ${request.minReasonLength} characters`}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
          />
          {!reasonReady && <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 5 }}>This action is recorded in the scheduler audit log.</div>}
        </div>
      )}
      {error && <div style={{ color: "#ff6b6b", fontSize: "0.85rem", marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`btn ${request.danger ? "red" : ""}`} style={{ flex: 1 }} disabled={busy || !reasonReady} onClick={() => void run()}>{busy ? "Working…" : request.confirmLabel ?? "Confirm"}</button>
      </div>
    </Dialog>
  );
}
