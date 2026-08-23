import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { api } from "../../api/client";

export interface ModField {
  key: string;
  label: string;
  type?: "text" | "number";
  placeholder?: string;
  optional?: boolean;
}

/** Descriptor for a moderation action rendered as a small form dialog. */
export interface ModerationRequest {
  title: string;
  description: React.ReactNode;
  fields: ModField[];
  submitLabel: string;
  /** Prefilled values (e.g. a suggested replacement name). */
  initialValues?: Record<string, string>;
  run: (values: Record<string, string>) => Promise<void>;
}

/**
 * Generic form dialog for moderation actions. Shared by the Users tab and the
 * competition drill-down so every action enforces the same reason discipline.
 */
export function ModerationDialog({ request, onClose }: { request: ModerationRequest | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(request?.initialValues ?? {});
    setBusy(false);
    setError(null);
  }, [request]);

  if (!request) return null;

  const complete =
    request.fields.every((field) => field.optional || String(values[field.key] ?? "").trim().length > 0) &&
    String(values.reason ?? "").trim().length >= 10;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await request.run(values);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog header={request.title} visible onHide={onClose} style={{ width: 430 }}>
      <div style={{ color: "var(--text-2)", lineHeight: 1.5 }}>{request.description}</div>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {request.fields.map((field) => (
          <div className="form-group" key={field.key} style={{ marginBottom: 0 }}>
            <label htmlFor={`mod-${field.key}`}>{field.label}</label>
            <input
              id={`mod-${field.key}`}
              type={field.type ?? "text"}
              value={values[field.key] ?? ""}
              disabled={busy}
              placeholder={field.placeholder}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)" }}
            />
          </div>
        ))}
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 8 }}>A reason of at least 10 characters is required — this action is audit-logged.</div>
      {error && <div style={{ color: "#ff6b6b", fontSize: "0.85rem", marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn red" style={{ flex: 1 }} disabled={busy || !complete} onClick={() => void submit()}>{busy ? "Working…" : request.submitLabel}</button>
      </div>
    </Dialog>
  );
}

/** Warning history for one user (or club-owner lookup target). */
export function WarningsDialog({ user, onClose }: { user: { id: number; username: string } | null; onClose: () => void }) {
  const [warnings, setWarnings] = useState<{ id: number; reason: string; issuedByAdminUserId: number; createdAt: string; acknowledgedAt: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setWarnings(null);
    setError(null);
    api.adminListUserWarnings(user.id)
      .then((res) => setWarnings(res.warnings))
      .catch((e) => setError((e as Error).message));
  }, [user]);

  return (
    <Dialog header={user ? `Warnings · ${user.username}` : "Warnings"} visible={user !== null} onHide={onClose} style={{ width: 480 }}>
      {error && <div style={{ color: "#ff6b6b" }}>{error}</div>}
      {!error && warnings === null && <div className="empty-state" style={{ padding: 20 }}>Loading…</div>}
      {warnings !== null && warnings.length === 0 && <div className="empty-state" style={{ padding: 20 }}>No warnings issued.</div>}
      {warnings !== null && warnings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {warnings.map((warning) => (
            <div key={warning.id} className="news-item">
              <div style={{ fontWeight: 600 }}>{warning.reason}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.8rem" }}>
                {new Date(warning.createdAt).toLocaleString()} · by admin #{warning.issuedByAdminUserId} · {warning.acknowledgedAt ? `acknowledged ${new Date(warning.acknowledgedAt).toLocaleDateString()}` : "not acknowledged"}
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
