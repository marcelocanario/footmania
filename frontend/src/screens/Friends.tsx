import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Trash2, UserPlus, Users, Copy, Check } from "lucide-react";
import { api } from "../api/client";
import { useGame } from "../store/game";
import { ClubNameLink } from "../components/ClubNameLink";
import { relativeTime } from "../utils/time";

interface FriendRow {
  userId: number;
  name: string;
  clubId: number | null;
  clubName: string | null;
  competitionState: string | null;
  since: string;
}

interface InvitationRow {
  token: string;
  createdAt: string;
}

/**
 * Friends management (plan 9): invite links auto-create a friendship when the
 * invitee signs up; friendships influence season regrouping while BOTH owners
 * keep the Settings switch enabled.
 */
export function FriendsScreen() {
  const { t } = useTranslation();
  const { status } = useGame();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void api.friends().then((res) => setFriends(res.friends)).catch(() => undefined);
    void api.invitations().then((res) => setInvitations(res.invitations)).catch(() => undefined);
  };

  useEffect(refresh, []);

  // Shared action wrapper so API failures surface in the UI instead of
  // becoming unhandled promise rejections.
  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message || t("friends.somethingWrong"));
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    runAction(async () => {
      const res = await api.createInvitation();
      setNewLink(`${location.origin}/login?invite=${res.inviteToken}`);
      setCopied(false);
      refresh();
    });

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — the link stays selectable */ }
  };

  const removeFriend = (userId: number) =>
    runAction(async () => {
      await api.removeFriend(userId);
      refresh();
    });

  const revoke = (token: string) =>
    runAction(async () => {
      await api.revokeInvitation(token);
      setInvitations((prev) => prev.filter((i) => i.token !== token));
    });

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="kicker">{t("friends.playTogether")}</div>
          <h1>{t("friends.title")}</h1>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ maxWidth: 640, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--red-2)", borderRadius: 8, color: "var(--red-2)", fontSize: "0.9rem" }}>
          {error}
        </div>
      )}

      <div className="card" style={{ maxWidth: 640 }}>
        <h2 className="card-title"><UserPlus size={17} /> {t("friends.inviteFriend")}</h2>
        <div style={{ color: "var(--text-3)", fontSize: "0.9rem", marginBottom: 14 }}>
          {t("friends.inviteIntro")}
        </div>
        <button className="btn gold" onClick={() => void generate()} disabled={busy}>
          <Link2 size={15} /> {t("friends.generateInvite")}
        </button>
        {newLink && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <input className="select" readOnly value={newLink} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => void copy(newLink)}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("friends.copied") : t("friends.copy")}
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Link2 size={17} /> {t("friends.pendingInvitations")}</h2>
        {invitations.length === 0 ? (
          <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>{t("friends.noInviteLinks")}</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {invitations.map((invitation) => (
              <li key={invitation.token} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--text-2)" }}>
                  …{invitation.token.slice(-8)} {t("friends.created", { time: relativeTime(invitation.createdAt) })}
                </span>
                <button className="btn sm ghost" disabled={busy} onClick={() => void revoke(invitation.token)}>
                  <Trash2 size={13} /> {t("friends.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <h2 className="card-title"><Users size={17} /> {t("friends.yourFriends")}</h2>
        {friends.length === 0 ? (
          <div style={{ color: "var(--text-3)", fontSize: "0.88rem" }}>
            {t("friends.noFriends")}{status?.club ? "" : t("friends.afterCreatingClub")}.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {friends.map((friend) => (
              <li key={friend.userId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <span>
                  <b style={{ fontSize: "0.92rem" }}>{friend.name}</b>
                  <span style={{ color: "var(--text-3)", fontSize: "0.85rem" }}>
                    {" "}·{" "}
                    {friend.clubName && friend.clubId != null
                      ? <ClubNameLink clubId={friend.clubId} name={friend.clubName} showCrest={false} />
                      : friend.clubName ?? t("friends.noClub")}
                    {friend.competitionState === "DORMANT" ? t("friends.dormant") : ""} {t("friends.friendSince", { time: relativeTime(friend.since) })}
                  </span>
                </span>
                <button className="btn sm ghost" disabled={busy} onClick={() => void removeFriend(friend.userId)}>
                  <Trash2 size={13} /> {t("friends.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
