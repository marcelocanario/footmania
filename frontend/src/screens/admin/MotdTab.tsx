import { useState } from "react";
import { Megaphone, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { AdminCard, useAdminFetch, type TabProps } from "./adminShared";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/** Mirrors the backend config default (game.config.jsonc → motd.maxLength). */
const MOTD_MAX_LENGTH = 280;

/**
 * Message-of-the-day management. Every post is retained as a separate
 * announcement; users see all retained MOTDs pinned in their News feed.
 */
export function MotdTab({ version, notify }: TabProps) {
  const messages = useAdminFetch(() => api.adminGetMotd(), [version]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const posted = messages.data?.messages ?? [];
  const trimmed = text.trim();

  const post = async () => {
    if (trimmed.length === 0) return;
    setBusy(true);
    try {
      await api.adminPostMotd(trimmed);
      notify("success", "MOTD posted", "It is now pinned to every user's News feed.");
      setText("");
      messages.reload();
    } catch (e) {
      notify("error", "Posting failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <AdminCard
        icon={<Megaphone size={17} />}
        title="Message of the day"
        subtitle="Every announcement is retained and pinned to the top of every user's News feed. You can post multiple MOTDs and remove them individually."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="motd-text">Announcement</label>
            <textarea
              id="motd-text"
              value={text}
              maxLength={MOTD_MAX_LENGTH}
              disabled={busy}
              rows={3}
              placeholder="e.g. Scheduled maintenance Sunday 02:00 UTC — matches may pause briefly."
              onChange={(e) => setText(e.target.value)}
              style={{
                width: "100%", maxWidth: 560, padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--text-1)",
                resize: "vertical", fontFamily: "inherit",
              }}
            />
            <div style={{ color: "var(--text-3)", fontSize: "0.78rem", marginTop: 4 }}>
              {trimmed.length}/{MOTD_MAX_LENGTH} characters
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={busy || trimmed.length === 0} onClick={() => void post()}>
              <Megaphone size={14} /> Post MOTD
            </button>
            {posted.length > 0 && (
              <button
                className="btn ghost danger"
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    title: "Clear all MOTDs?",
                    message: <>All retained announcements disappear from every dashboard immediately.</>,
                    confirmLabel: "Clear",
                    danger: true,
                    onConfirm: async () => {
                      await api.adminDeleteMotd();
                      notify("success", "All MOTDs cleared");
                      messages.reload();
                    },
                  })
                }
              >
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>
      </AdminCard>

      <AdminCard title={posted.length > 0 ? "Posted MOTDs" : "No posted MOTDs"} subtitle="Exactly what users see at the top of their News feed."
      >
        {!messages.loading && posted.length === 0 && <div className="empty-state" style={{ padding: 20 }}>Nothing posted yet.</div>}
        {posted.length > 0 && (
          <div className="news-feed">
            {posted.map((message, index) => (
              <div className="news-feed-item" key={`${message.dayIndex}-${index}`}>
                <span className="kind-dot" style={{ background: "var(--gold-2)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <span className="chip" style={{ borderColor: "rgba(240,180,41,0.5)", color: "var(--gold-2)", marginRight: 6, fontSize: "0.68rem", padding: "1px 6px" }}>ADMIN</span>
                    {message.text}
                  </div>
                </div>
                <span className="day">Day {message.dayIndex}</span>
                <button
                  className="btn ghost sm danger"
                  disabled={busy}
                  aria-label={`Delete MOTD: ${message.text}`}
                  onClick={() => setConfirm({
                    title: "Delete this MOTD?",
                    message: <>This announcement will be removed from every user's News feed.</>,
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: async () => {
                      await api.adminDeleteMotdMessage(message.dayIndex, message.text);
                      notify("success", "MOTD deleted");
                      messages.reload();
                    },
                  })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </AdminCard>
    </div>
  );
}
